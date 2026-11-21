import {
    connect,
    createRig,
    RecordingOutput,
    RelayRig,
    runFor,
} from './lan-relay.test-helpers';

jest.mock('../../util/validated-axios', () => ({
    requestWithValidatedRedirects: jest.fn(),
}));

const SPEED = 10;
const FAST_START_MS = 3000;
const OVERDRIVE = 1.02;
const TARGET_CUSHION_MS = 6000;
/** Pacing works in packets inside segments; frames are not all one size. */
const PACE_SLACK_MS = 250;

async function stopRig(rig: RelayRig): Promise<void> {
    await rig.relay.stop();
}

function expectContinuous(output: RecordingOutput): void {
    const checker = output.checker;
    expect(checker.startsClean).toBe(true);
    expect(checker.ccErrors).toBe(0);
    expect(checker.ptsErrors).toBe(0);
}

function expectPaced(output: RecordingOutput): void {
    const excess = output.paceExcessMs((elapsed, sinceFirst) =>
        Math.min(
            FAST_START_MS + OVERDRIVE * elapsed,
            TARGET_CUSHION_MS + Math.max(0, sinceFirst)
        )
    );
    expect(excess).toBeLessThanOrEqual(PACE_SLACK_MS);
}

/** Runs channels with one client each and checks every guarantee. */
async function runChannels(channels: number[], minutes: number): Promise<void> {
    const rig = createRig(channels, { speed: SPEED });
    let peak = 0;
    try {
        const clients = channels.map((id) => connect(rig, id));
        await runFor(rig, minutes * 60_000, () => {
            peak = Math.max(peak, rig.provider.stats().openNow);
        });
        const now = rig.clock.now();
        const status = rig.relay.status();

        expect(peak).toBeLessThanOrEqual(1);
        expect(rig.provider.stats().peak).toBe(1);
        expect(rig.provider.stats().refused).toBe(0);
        expect(status.upstream.maxOpenAtOnce).toBe(1);
        for (const { output } of clients) {
            expectContinuous(output);
            expectPaced(output);
            expect(output.maxWriteGapMs(now)).toBeLessThan(1000);
            // Real time, give or take the wait for the first visit.
            expect(output.checker.mediaMs).toBeGreaterThan(
                minutes * 60_000 - 15_000
            );
        }
        for (const channel of status.channels) {
            expect(channel.visits).toBeGreaterThan(2);
            expect(channel.skippedMs).toBe(0);
            expect(channel.dryStallMs).toBeLessThan(2000);
            expect(channel.backpressureDrops).toBe(0);
        }
        // The periodic line was logged.
        expect(rig.lines.some((line) => line.startsWith('up='))).toBe(true);
    } finally {
        await stopRig(rig);
    }
}

describe('LanRelay on the fake provider', () => {
    it('plays two channels for four minutes on one connection', async () => {
        await runChannels([1, 2], 4);
    }, 60_000);

    it('plays three channels for three minutes on one connection', async () => {
        await runChannels([1, 2, 3], 3);
    }, 60_000);
});
