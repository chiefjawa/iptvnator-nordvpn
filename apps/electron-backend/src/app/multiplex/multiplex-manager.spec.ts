import { get, IncomingMessage, request } from 'node:http';
import { MultiplexStatus } from '@iptvnator/shared/interfaces';
import { MultiplexManager } from './multiplex-manager';
import { createFakeProvider, FakeProvider } from './testing/fake-provider';
import { SYNTHETIC_VIDEO_PID } from './testing/synthetic-ts';
import { parseTsPacket, TsPacketAligner, TS_PACKET_SIZE } from './ts/ts-packet';

jest.mock('../util/validated-axios', () => ({
    requestWithValidatedRedirects: jest.fn(),
}));

function source(channel: number, groupKey = 'playlist-1') {
    return {
        url: `http://provider.invalid/live/user/secret/${channel}.ts`,
        groupKey,
    };
}

/** Plays a relay URL like a tile would, counting the video frames received. */
function play(url: string) {
    const aligner = new TsPacketAligner();
    const state = { frames: 0, status: 0, response: null as IncomingMessage | null };
    const req = get(url, (response) => {
        state.status = response.statusCode ?? 0;
        state.response = response;
        response.on('data', (chunk: Buffer) => {
            const packets = aligner.push(chunk);
            for (let offset = 0; offset < packets.length; offset += TS_PACKET_SIZE) {
                const header = parseTsPacket(packets, offset);
                if (header?.pid === SYNTHETIC_VIDEO_PID && header.payloadUnitStart) {
                    state.frames += 1;
                }
            }
        });
        response.on('error', () => undefined);
    });
    req.on('error', () => undefined);
    return { state, stop: () => req.destroy() };
}

function statusOf(url: string, headers: Record<string, string> = {}, method = 'GET') {
    return new Promise<number>((resolve, reject) => {
        const target = new URL(url);
        const req = request(
            {
                host: target.hostname,
                port: target.port,
                path: target.pathname,
                method,
                headers,
            },
            (response) => {
                resolve(response.statusCode ?? 0);
                response.destroy();
            }
        );
        req.on('error', reject);
        req.end();
    });
}

describe('MultiplexManager', () => {
    jest.setTimeout(30000);

    let provider: FakeProvider;
    let manager: MultiplexManager;
    let statuses: MultiplexStatus[];

    beforeEach(() => {
        provider = createFakeProvider();
        statuses = [];
        manager = new MultiplexManager({
            open: provider.open,
            clock: provider.clock,
            onStatus: (status) => statuses.push(status),
        });
    });

    afterEach(async () => {
        await manager.shutdown();
    });

    it('serves two tiles over the relay from a single provider connection', async () => {
        const { sessionId } = manager.openSession();
        const first = await manager.setTile(sessionId, 'a', source(1));
        const second = await manager.setTile(sessionId, 'b', source(2));
        const players = [play(first.relayUrl), play(second.relayUrl)];

        await provider.clock.sleep(30000);

        expect(first.relayUrl).toMatch(
            /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/tile\/[\w-]+\.ts$/
        );
        expect(first.relayUrl).not.toContain('secret');
        for (const player of players) {
            expect(player.state.status).toBe(200);
            // 30 s of 25 fps video, less startup.
            expect(player.state.frames).toBeGreaterThan(500);
        }
        expect(provider.stats()).toMatchObject({ peak: 1, refused: 0 });
        expect(
            statuses.some(
                (status) =>
                    status.sessionId === sessionId && status.tiles.length === 2
            )
        ).toBe(true);
        players.forEach((player) => player.stop());
    });

    it('keeps media for a tile whose player connects late', async () => {
        const { sessionId } = manager.openSession();
        const { relayUrl } = await manager.setTile(sessionId, 'a', source(1));

        await provider.clock.sleep(8000);
        const player = play(relayUrl);
        await provider.clock.sleep(2000);

        // Everything since the tile was added, not just the last 2 s.
        expect(player.state.frames).toBeGreaterThan(300);
        player.stop();
    });

    it('rejects requests without the token, for another host, or not GET', async () => {
        const { sessionId } = manager.openSession();
        const { relayUrl } = await manager.setTile(sessionId, 'a', source(1));
        const url = new URL(relayUrl);
        const forged = relayUrl.replace(/\/[0-9a-f]{64}\//, `/${'0'.repeat(64)}/`);

        expect(await statusOf(forged)).toBe(404);
        expect(await statusOf(relayUrl, { Host: `evil.example:${url.port}` })).toBe(
            403
        );
        expect(await statusOf(relayUrl, {}, 'POST')).toBe(405);
    });

    it('gives a replaced tile a new stream and retires the old URL', async () => {
        const { sessionId } = manager.openSession();
        const before = await manager.setTile(sessionId, 'a', source(1));
        const after = await manager.setTile(sessionId, 'a', source(5));

        expect(after.relayUrl).not.toBe(before.relayUrl);
        expect(await statusOf(before.relayUrl)).toBe(404);

        const player = play(after.relayUrl);
        await provider.clock.sleep(6000);
        expect(player.state.frames).toBeGreaterThan(100);
        expect(provider.stats().peak).toBe(1);
        player.stop();
    });

    it('uses separate connections for tiles of different playlists', async () => {
        const { sessionId } = manager.openSession();
        // Two groups on one single-connection provider would be refused, so
        // a refusal here proves each group opened its own connection.
        await manager.setTile(sessionId, 'a', source(1, 'playlist-1'));
        await manager.setTile(sessionId, 'b', source(2, 'playlist-2'));

        await provider.clock.sleep(6000);

        expect(provider.stats().refused).toBeGreaterThan(0);
    });

    it('closes the provider connection when the session closes', async () => {
        const { sessionId } = manager.openSession();
        const { relayUrl } = await manager.setTile(sessionId, 'a', source(1));
        await provider.clock.sleep(4000);
        expect(provider.stats().openNow).toBe(1);

        await manager.closeSession(sessionId);
        await provider.clock.sleep(500);

        expect(provider.stats().openNow).toBe(0);
        expect(await statusOf(relayUrl)).toBe(404);
        await expect(manager.setTile(sessionId, 'b', source(2))).rejects.toThrow(
            'Unknown multiplex session'
        );
    });

    it('ignores progress and removals for unknown sessions and tiles', () => {
        const { sessionId } = manager.openSession();

        expect(() => {
            manager.reportProgress('nope', []);
            manager.reportProgress(sessionId, [
                { tileId: 'ghost', bufferedAheadSec: 1, playing: true, focused: false },
            ]);
            manager.removeTile(sessionId, 'ghost');
            manager.removeTile('nope', 'a');
        }).not.toThrow();
    });
});
