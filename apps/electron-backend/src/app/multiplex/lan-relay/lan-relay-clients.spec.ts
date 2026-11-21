import { createRelayLogger } from './relay-log';
import { secretsOf } from './relay-config';
import {
    connect,
    createRig,
    FAKE_SECRETS,
    RecordingOutput,
    RelayRig,
    runFor,
    testConfig,
} from './lan-relay.test-helpers';

jest.mock('../../util/validated-axios', () => ({
    requestWithValidatedRedirects: jest.fn(),
}));

const SPEED = 10;

function expectContinuous(output: RecordingOutput): void {
    expect(output.checker.startsClean).toBe(true);
    expect(output.checker.ccErrors).toBe(0);
    expect(output.checker.ptsErrors).toBe(0);
}

function firstMediaDelayMs(output: RecordingOutput): number {
    const first = output.writes.find((sample) => sample.mediaMs > 0);
    return first ? first.atMs - output.connectedAtMs : Number.POSITIVE_INFINITY;
}

function channel(rig: RelayRig, streamId: number) {
    return rig.relay.status().channels.find((c) => c.streamId === streamId);
}

describe('LanRelay clients', () => {
    let rig: RelayRig;

    afterEach(async () => {
        await rig?.relay.stop();
    });

    it('holds the connection on a single active channel', async () => {
        rig = createRig([1, 2], { speed: SPEED });
        const { output } = connect(rig, 1);
        await runFor(rig, 90_000);

        expect(rig.provider.stats().opens).toBe(1);
        expect(rig.relay.status().upstream).toMatchObject({
            open: true,
            streamId: 1,
            opens: 1,
        });
        expectContinuous(output);
        expect(output.maxWriteGapMs(rig.clock.now())).toBeLessThan(1000);
        expect(channel(rig, 1)?.dryStalls).toBe(0);
    }, 30_000);

    it('fans one channel out to two clients', async () => {
        rig = createRig([1, 2], { speed: SPEED });
        const first = connect(rig, 1);
        connect(rig, 2);
        await runFor(rig, 30_000);
        const second = connect(rig, 1);
        await runFor(rig, 60_000);

        expect(channel(rig, 1)?.clients).toBe(2);
        expect(rig.relay.status().channels).toHaveLength(2);
        expectContinuous(first.output);
        expectContinuous(second.output);
        // The joiner starts from the queue at once, on a keyframe.
        expect(firstMediaDelayMs(second.output)).toBeLessThan(500);
        expect(second.output.checker.mediaMs).toBeGreaterThan(55_000);
        expect(second.output.maxWriteGapMs(rig.clock.now())).toBeLessThan(1000);
        expect(rig.provider.stats().peak).toBe(1);
    }, 30_000);

    it('keeps a channel whose client reconnects within the grace period', async () => {
        rig = createRig([1, 2], { speed: SPEED });
        const first = connect(rig, 1);
        connect(rig, 2);
        await runFor(rig, 60_000);
        const visits = channel(rig, 1)?.visits ?? 0;
        first.leave();
        expect(first.output.closed).toBe(true);
        await runFor(rig, 4_000);
        expect(channel(rig, 1)?.state).toBe('grace');

        const again = connect(rig, 1);
        await runFor(rig, 40_000);

        expect(channel(rig, 1)?.visits).toBeGreaterThanOrEqual(visits);
        expect(channel(rig, 1)?.state).not.toBe('grace');
        expect(
            rig.lines.some((line) => line.includes('removed after grace'))
        ).toBe(false);
        expectContinuous(again.output);
        expect(firstMediaDelayMs(again.output)).toBeLessThan(500);
        expect(again.output.maxWriteGapMs(rig.clock.now())).toBeLessThan(1000);
        expect(rig.provider.stats().peak).toBe(1);
    }, 30_000);

    it('drops a channel after the grace period and starts it fresh', async () => {
        rig = createRig([1, 2], { speed: SPEED });
        const first = connect(rig, 1);
        const other = connect(rig, 2);
        await runFor(rig, 45_000);
        first.leave();
        await runFor(rig, 12_000);

        expect(channel(rig, 1)).toBeUndefined();
        expect(
            rig.lines.some((line) =>
                line.includes('1 "Synthetic 1" removed after grace')
            )
        ).toBe(true);
        // With one channel left the connection settles on it.
        const opens = rig.provider.stats().opens;
        await runFor(rig, 30_000);
        expect(rig.provider.stats().opens - opens).toBeLessThanOrEqual(1);
        expect(rig.relay.status().upstream.streamId).toBe(2);

        const again = connect(rig, 1);
        await runFor(rig, 45_000);
        expect(channel(rig, 1)?.clients).toBe(1);
        expectContinuous(again.output);
        expectContinuous(other.output);
        expect(again.output.checker.mediaMs).toBeGreaterThan(30_000);
        expect(again.output.maxWriteGapMs(rig.clock.now())).toBeLessThan(1000);
        expect(rig.provider.stats().peak).toBe(1);
    }, 40_000);

    it('pauses a client that stops reading and bounds the queue', async () => {
        rig = createRig([1], { speed: SPEED, tuning: { maxQueueSec: 30 } });
        const stuck = connect(rig, 1);
        const healthy = connect(rig, 1);
        await runFor(rig, 20_000);
        stuck.output.blocked = true;
        await runFor(rig, 1_000);
        const writesWhenBlocked = stuck.output.writes.length;
        const patsWhenBlocked = stuck.output.checker.patAt.length;
        await runFor(rig, 60_000);

        // Nothing more is written to a full socket, not even keep-alive.
        expect(stuck.output.writes.length).toBe(writesWhenBlocked);
        const status = channel(rig, 1);
        expect(status?.queuedSec).toBeLessThanOrEqual(32);
        expect(status?.backpressurePauses).toBeGreaterThanOrEqual(1);
        expect(status?.backpressureDrops).toBeGreaterThanOrEqual(1);
        expect(status?.backpressureDroppedMs).toBeGreaterThan(10_000);
        expectContinuous(healthy.output);
        expect(healthy.output.maxWriteGapMs(rig.clock.now())).toBeLessThan(
            1000
        );

        stuck.output.unblock();
        await runFor(rig, 5_000);
        expect(stuck.output.writes.length).toBeGreaterThan(writesWhenBlocked);
        // It resumes on a segment start (PAT, PMT, keyframe) past the drop.
        expect(stuck.output.checker.patAt.length).toBeGreaterThan(
            patsWhenBlocked
        );
    }, 30_000);

    it('caps the memory of all queues together', async () => {
        const capMb = 0.25;
        rig = createRig([1], {
            speed: SPEED,
            tuning: { maxTotalQueueMb: capMb },
        });
        const stuck = connect(rig, 1);
        stuck.output.blocked = true;
        let largest = 0;
        await runFor(rig, 60_000, () => {
            largest = Math.max(largest, rig.relay.status().queueBytes);
        });
        // One segment (two seconds) of slack above the cap.
        expect(largest).toBeLessThan(capMb * 1024 * 1024 + 150_000);
        expect(channel(rig, 1)?.backpressureDrops).toBeGreaterThan(0);
    }, 30_000);

    it('keeps secrets out of logs and status', async () => {
        rig = createRig([1, 2], { speed: SPEED, provider: { refuseFirst: 2 } });
        connect(rig, 1);
        connect(rig, 2);
        await runFor(rig, 40_000);
        const text = [...rig.lines, JSON.stringify(rig.relay.status())].join(
            '\n'
        );

        expect(rig.relay.status().upstream.refusals).toBe(2);
        expect(text).toContain('Synthetic 1');
        for (const secret of [
            FAKE_SECRETS.username,
            FAKE_SECRETS.password,
            FAKE_SECRETS.token,
            'provider.example.test',
            '/live/',
        ]) {
            expect(text).not.toContain(secret);
        }
    }, 30_000);

    it('scrubs configured secrets from any log line', () => {
        const lines: string[] = [];
        const log = createRelayLogger(secretsOf(testConfig([1])), (line) =>
            lines.push(line)
        );
        log.warn(
            `oops ${FAKE_SECRETS.serverUrl}/live/${FAKE_SECRETS.username}/${FAKE_SECRETS.password}/1.ts ${FAKE_SECRETS.token}`,
            { password: 'synthetic-value', streamId: 1 }
        );
        expect(lines[0]).not.toMatch(
            /provider\.example\.test|relay-user|relay-pass|tokenABC|synthetic-value/
        );
        expect(lines[0]).toContain('"streamId":1');
    });
});
