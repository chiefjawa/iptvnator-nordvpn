import { PassThrough } from 'node:stream';
import { OpenUpstream } from '../scheduler/scheduler-types';
import { createFakeProvider } from '../testing/fake-provider';
import { LanRelay } from './lan-relay';
import { RelayClient } from './relay-client';
import {
    DEEP_BURST,
    RecordingOutput,
    testConfig,
} from './lan-relay.test-helpers';

jest.mock('../../util/validated-axios', () => ({
    requestWithValidatedRedirects: jest.fn(),
}));

const SPEED = 10;

function makeRelay(
    open: OpenUpstream | null,
    tuning: Record<string, number> = {},
    extra: Record<string, unknown> = {}
) {
    const provider = createFakeProvider({ ...DEEP_BURST, speed: SPEED });
    const lines: string[] = [];
    const relay = new LanRelay({
        config: testConfig([], { statusLogSec: 0, ...tuning }, extra),
        open: open ?? provider.open,
        clock: provider.clock,
        log: { info: (m) => lines.push(m), warn: (m) => lines.push(m) },
    });
    relay.start();
    const wait = async (ms: number) => {
        const until = provider.clock.now() + ms;
        while (provider.clock.now() < until) {
            await provider.clock.sleep(100);
        }
    };
    const attach = (id: number, remote = '192.0.2.10') => {
        const output = new RecordingOutput(provider.clock);
        const result = relay.attach(id, output, remote);
        return { output, result };
    };
    return { provider, relay, lines, wait, attach };
}

describe('LanRelay admission and robustness', () => {
    let relay: LanRelay | undefined;

    afterEach(async () => {
        await relay?.stop();
        relay = undefined;
    });

    it('accepts any stream id up to maxLiveChannels, evicting unwatched ones', async () => {
        const rig = makeRelay(null, {}, { maxLiveChannels: 2 });
        relay = rig.relay;
        const one = rig.attach(1);
        rig.attach(2);
        expect(rig.attach(3).result.refused).toBe('capacity');
        // A channel in grace makes room for a new one.
        if (one.result.client) {
            rig.relay.detach(1, one.result.client);
        }
        expect(rig.attach(3).result.client).toBeDefined();
        const status = rig.relay.status();
        expect(status.channels.map((c) => c.streamId).sort()).toEqual([2, 3]);
        expect(status.refused.capacity).toBe(1);
    });

    it('shortens the grace of a channel left by a zap from the same address', async () => {
        const rig = makeRelay(null);
        relay = rig.relay;
        const a = rig.attach(1, '192.0.2.20');
        const b = rig.attach(5, '192.0.2.30');
        await rig.wait(3000);
        rig.relay.detach(1, a.result.client as RelayClient);
        rig.attach(2, '192.0.2.20');
        rig.relay.detach(5, b.result.client as RelayClient);
        await rig.wait(2500);
        const ids = rig.relay
            .status()
            .channels.map((c) => c.streamId)
            .sort();
        // 1 was zapped away from (1 s grace); 5 keeps the normal 8 s grace.
        expect(ids).toEqual([2, 5]);
        expect(rig.relay.status().zaps).toBe(1);
    });

    it('survives a provider outage: backoff, keep-alive, then a clean end', async () => {
        let attempts = 0;
        const rig = makeRelay(
            async () => {
                attempts += 1;
                const error = new Error(
                    'connect failed'
                ) as NodeJS.ErrnoException;
                error.code = 'ECONNREFUSED';
                throw error;
            },
            { endAfterStarveSec: 10 }
        );
        relay = rig.relay;
        const { output } = rig.attach(7);
        await rig.wait(5000);
        expect(output.checker.nullPackets).toBeGreaterThan(0);
        expect(output.closed).toBe(false);
        await rig.wait(7000);
        expect(output.closed).toBe(true);
        const status = rig.relay.status();
        expect(status.upstream.errors).toBe(attempts);
        // Backoff: far fewer attempts than one per scheduler tick.
        expect(attempts).toBeLessThan(15);
        expect(rig.lines.some((l) => l.includes('ECONNREFUSED'))).toBe(true);
        expect(rig.relay.gate.idle).toBe(true);
    });

    it('drops a connection that goes silent (a dropped tunnel) and reconnects', async () => {
        let opens = 0;
        const silent: OpenUpstream = async () => {
            opens += 1;
            const stream = new PassThrough();
            return {
                status: 200,
                stream,
                close: async () => {
                    stream.destroy();
                },
            };
        };
        const rig = makeRelay(silent, { upstreamStallSec: 3 });
        relay = rig.relay;
        rig.attach(9);
        await rig.wait(12_000);
        const status = rig.relay.status();
        expect(status.upstream.stalls).toBeGreaterThanOrEqual(1);
        expect(opens).toBeGreaterThanOrEqual(2);
        expect(status.upstream.gate?.peak).toBe(1);
    });
});
