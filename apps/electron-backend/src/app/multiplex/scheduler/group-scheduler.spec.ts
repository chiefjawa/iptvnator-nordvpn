import { createFakeProvider, FakeProvider } from '../testing/fake-provider';
import { SYNTHETIC_VIDEO_PID } from '../testing/synthetic-ts';
import { parseTsPacket, timestampDelta } from '../ts/ts-packet';
import { readPesTimestamps } from '../ts/ts-pes';
import { GroupScheduler } from './group-scheduler';
import { TileSink, TileStatus } from './scheduler-types';

jest.mock('../../util/validated-axios', () => ({
    requestWithValidatedRedirects: jest.fn(),
}));

const FRAME_MS = 40;
const FRAME_TICKS = 3600;

/** A tile's player: counts what it was given and plays it in real time. */
class FakePlayer implements TileSink {
    private frames = 0;
    private lastPts: number | null = null;
    private firstAtMs: number | null = null;
    gaps = 0;
    lowestBufferedMs = Number.POSITIVE_INFINITY;

    constructor(private readonly provider: FakeProvider) {}

    write(packets: Buffer[]): void {
        for (const packet of packets) {
            const header = parseTsPacket(packet);
            if (header?.pid !== SYNTHETIC_VIDEO_PID || !header.payloadUnitStart) {
                continue;
            }
            const pes = readPesTimestamps(packet, header);
            if (!pes) {
                continue;
            }
            if (
                this.lastPts !== null &&
                timestampDelta(pes.pts, this.lastPts) !== FRAME_TICKS
            ) {
                this.gaps += 1;
            }
            this.lastPts = pes.pts;
            this.frames += 1;
            this.firstAtMs ??= this.provider.clock.now();
        }
    }

    get started(): boolean {
        return this.firstAtMs !== null;
    }

    get receivedMs(): number {
        return this.frames * FRAME_MS;
    }

    /** Media not yet played, had playback begun with the first frame. */
    bufferedMs(): number {
        if (this.firstAtMs === null) {
            return 0;
        }
        const played = this.provider.clock.now() - this.firstAtMs;
        return this.receivedMs - played;
    }

    /** Records the buffer level, once the opening burst has had time to land. */
    sample(): void {
        const settled =
            this.firstAtMs !== null &&
            this.provider.clock.now() - this.firstAtMs > 3000;
        if (settled) {
            this.lowestBufferedMs = Math.min(
                this.lowestBufferedMs,
                this.bufferedMs()
            );
        }
    }
}

function setup(
    tileCount: number,
    options: Parameters<typeof createFakeProvider>[0] = {}
) {
    const provider = createFakeProvider(options);
    const statuses: TileStatus[][] = [];
    const scheduler = new GroupScheduler({
        open: provider.open,
        clock: provider.clock,
        onStatus: (tiles) => statuses.push(tiles),
    });
    const players = Array.from({ length: tileCount }, (_, index) => {
        const player = new FakePlayer(provider);
        scheduler.setTile(
            `tile-${index}`,
            { url: `http://provider.invalid/live/u/p/${index + 1}.ts` },
            player
        );
        return player;
    });

    /** Lets `simulatedMs` pass, sampling every player's buffer as it goes. */
    const run = async (simulatedMs: number) => {
        const end = provider.clock.now() + simulatedMs;
        while (provider.clock.now() < end) {
            await provider.clock.sleep(500);
            players.forEach((player) => player.sample());
        }
    };

    return { provider, scheduler, players, statuses, run };
}

describe('GroupScheduler', () => {
    jest.setTimeout(30000);

    it('keeps a single tile on one connection without reconnecting', async () => {
        const { provider, scheduler, players, run } = setup(1);

        await run(20000);
        await scheduler.stop();

        expect(provider.stats()).toMatchObject({ opens: 1, peak: 1 });
        expect(players[0].receivedMs).toBeGreaterThan(30000);
        expect(players[0].gaps).toBe(0);
    });

    it('feeds two tiles from one connection without either running dry', async () => {
        const { provider, scheduler, players, run } = setup(2);

        await run(60000);
        await scheduler.stop();

        const stats = provider.stats();
        expect(stats.peak).toBe(1);
        expect(stats.refused).toBe(0);
        expect(stats.opens).toBeGreaterThan(3);
        for (const player of players) {
            expect(player.gaps).toBe(0);
            expect(player.receivedMs).toBeGreaterThan(55000);
            expect(player.lowestBufferedMs).toBeGreaterThan(2000);
        }
    });

    it('feeds four tiles from one connection', async () => {
        const { provider, scheduler, players, run } = setup(4, {
            depthSec: 25,
        });

        await run(80000);
        await scheduler.stop();

        expect(provider.stats()).toMatchObject({ peak: 1, refused: 0 });
        for (const player of players) {
            expect(player.gaps).toBe(0);
            expect(player.lowestBufferedMs).toBeGreaterThan(1000);
        }
    });

    it('waits and retries after a refusal instead of opening a second connection', async () => {
        const { provider, scheduler, players, statuses, run } = setup(2, {
            refuseFirst: 3,
        });

        await run(40000);
        await scheduler.stop();

        expect(provider.stats()).toMatchObject({ peak: 1, refused: 3 });
        expect(players.every((player) => player.started)).toBe(true);
        expect(
            statuses.some((tiles) =>
                tiles.some(
                    (tile) => tile.state === 'error' && tile.httpStatus === 403
                )
            )
        ).toBe(true);
    });

    it('releases the connection when its tile is removed', async () => {
        const { provider, scheduler, run } = setup(1);
        await run(5000);
        expect(provider.stats().openNow).toBe(1);

        scheduler.removeTile('tile-0');
        await run(2000);

        expect(provider.stats().openNow).toBe(0);
        expect(scheduler.tileCount).toBe(0);
        await scheduler.stop();
    });

    it('starts a replaced tile on a fresh stream', async () => {
        const { provider, scheduler, players, run } = setup(2);
        await run(15000);

        const replacement = new FakePlayer(provider);
        scheduler.setTile(
            'tile-0',
            { url: 'http://provider.invalid/live/u/p/9.ts' },
            replacement
        );
        await run(20000);
        await scheduler.stop();

        expect(provider.stats().peak).toBe(1);
        expect(replacement.receivedMs).toBeGreaterThan(10000);
        expect(replacement.gaps).toBe(0);
        expect(players[1].gaps).toBe(0);
    });

    it('closes everything on stop and reports tile states while running', async () => {
        const { provider, scheduler, statuses, run } = setup(2);

        await run(10000);
        await scheduler.stop();

        expect(provider.stats().openNow).toBe(0);
        const states = new Set(
            statuses.flatMap((tiles) => tiles.map((tile) => tile.state))
        );
        expect(states).toContain('connecting');
        expect(states).toContain('filling');
        expect(states).toContain('waiting');
    });
});
