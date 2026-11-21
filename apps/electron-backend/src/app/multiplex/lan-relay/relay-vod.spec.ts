import { request } from 'node:http';
import { VOD_BYTES, vodByte } from '../testing/fake-panel';
import { FAKE_LOGIN } from './lan-relay.test-helpers';
import {
    expectNoLeak,
    fetchRelay,
    FrontRig,
    readLive,
    sleep,
    startFrontRig,
} from './relay-front.test-helpers';

const U = FAKE_LOGIN.username;
const P = FAKE_LOGIN.password;
const MOVIE = `/movie/${U}/${P}/2001.mkv`;

function expectBytes(body: Buffer, start: number): void {
    for (let i = 0; i < body.length; i += 4099) {
        expect(body[i]).toBe(vodByte(start + i));
    }
}

/** Samples live + VOD connections open at the provider. */
function watchConnections(rig: FrontRig): { peak(): number; stop(): void } {
    let peak = 0;
    const timer = setInterval(() => {
        peak = Math.max(
            peak,
            rig.provider.stats().openNow + rig.panel.vodOpenNow()
        );
    }, 5);
    return {
        peak: () => Math.max(peak, rig.panel.streamPeak()),
        stop: () => clearInterval(timer),
    };
}

/** Starts a GET and resolves with what arrived until it ended or was cut. */
function startDownload(
    port: number,
    path: string,
    headers: Record<string, string> = {}
): Promise<{ status: number; bytes: number; complete: boolean }> {
    return new Promise((resolve) => {
        let bytes = 0;
        let status = 0;
        let expected = -1;
        const req = request(
            { host: '127.0.0.1', port, path, headers },
            (res) => {
                status = res.statusCode ?? 0;
                expected = Number(res.headers['content-length'] ?? -1);
                res.on('data', (chunk: Buffer) => (bytes += chunk.length));
                res.on('end', () =>
                    resolve({ status, bytes, complete: bytes === expected })
                );
                res.on('error', () =>
                    resolve({ status, bytes, complete: false })
                );
                res.on('aborted', () =>
                    resolve({ status, bytes, complete: false })
                );
            }
        );
        req.on('error', () => resolve({ status, bytes, complete: false }));
        req.end();
    });
}

describe('relay VOD and catch-up', () => {
    let rig: FrontRig;

    afterEach(async () => {
        await rig.close();
    });

    describe('with vodPolicy refuse', () => {
        beforeEach(async () => {
            rig = await startFrontRig({ vodPolicy: 'refuse' });
        });

        it('proxies whole files, ranges and HEAD with only safe headers', async () => {
            const whole = await fetchRelay(rig.port, MOVIE);
            expect(whole.status).toBe(200);
            expect(whole.body.length).toBe(VOD_BYTES);
            expectBytes(whole.body, 0);
            expectNoLeak(whole, 'movie');
            expect(whole.headers['set-cookie']).toBeUndefined();
            expect(whole.headers['location']).toBeUndefined();
            expect(whole.headers['accept-ranges']).toBe('bytes');

            const part = await fetchRelay(rig.port, MOVIE, {
                headers: { Range: 'bytes=1000-1999' },
            });
            expect(part.status).toBe(206);
            expect(part.headers['content-range']).toBe(
                `bytes 1000-1999/${VOD_BYTES}`
            );
            expect(part.body.length).toBe(1000);
            expectBytes(part.body, 1000);

            const head = await fetchRelay(rig.port, MOVIE, { method: 'HEAD' });
            expect(head.status).toBe(200);
            expect(head.headers['content-length']).toBe(String(VOD_BYTES));
            expect(head.body.length).toBe(0);

            const beyond = await fetchRelay(rig.port, MOVIE, {
                headers: { Range: `bytes=${VOD_BYTES}-` },
            });
            expect(beyond.status).toBe(416);

            const episode = await fetchRelay(
                rig.port,
                `/series/${U}/${P}/4001.mp4`,
                { headers: { Range: 'bytes=0-9' } }
            );
            expect(episode.status).toBe(206);
            const catchup = await fetchRelay(
                rig.port,
                `/timeshift/${U}/${P}/60/2026-11-21:10-00/1001.ts`,
                { headers: { Range: 'bytes=5-14' } }
            );
            expect(catchup.status).toBe(206);
            expectBytes(catchup.body, 5);
            const query = await fetchRelay(
                rig.port,
                `/streaming/timeshift.php?username=${U}&password=${P}&stream=1001&start=2026-11-21:10-00&duration=60`,
                { headers: { Range: 'bytes=0-9' } }
            );
            expect(query.status).toBe(206);
            expect(rig.panel.hits.get('timeshift')).toBe(2);
            expect(rig.panel.streamPeak()).toBe(1);
        });

        it('serializes one player session: a newer range cancels the older upstream request', async () => {
            rig.panel.vodChunkDelayMs = 25;
            const watch = watchConnections(rig);
            const first = startDownload(rig.port, MOVIE);
            await sleep(150);
            const seek = startDownload(rig.port, MOVIE, {
                Range: 'bytes=1048576-',
            });
            const [cut, done] = await Promise.all([first, seek]);
            watch.stop();
            expect(cut.complete).toBe(false);
            expect(done).toMatchObject({
                status: 206,
                bytes: VOD_BYTES - 1048576,
                complete: true,
            });
            expect(rig.panel.ranges).toEqual(['', 'bytes=1048576-']);
            expect(watch.peak()).toBe(1);
            const status = rig.app.status();
            expect(status.vod).toMatchObject({ superseded: 1, sessions: 1 });
            expect(status.upstream.gate?.peak).toBe(1);
        });

        it('refuses a movie for another player while one streams', async () => {
            rig.panel.vodChunkDelayMs = 20;
            const first = startDownload(rig.port, MOVIE);
            await sleep(100);
            // Another player (address) asks for another movie.
            const other = await new Promise<number>((resolve) => {
                request(
                    {
                        host: '127.0.0.1',
                        port: rig.port,
                        path: `/movie/${U}/${P}/2002.mkv`,
                        localAddress: '127.0.0.3',
                    },
                    (res) => {
                        res.resume();
                        resolve(res.statusCode ?? 0);
                    }
                ).end();
            });
            expect(other).toBe(503);
            expect((await first).complete).toBe(true);
            expect(rig.app.status().refused503.vodBusy).toBe(1);
        });

        it('refuses VOD while live is watched, and live while VOD streams', async () => {
            const watch = watchConnections(rig);
            const live = readLive(rig.port, `/live/${U}/${P}/1001.ts`, 2500);
            await sleep(500);
            expect((await fetchRelay(rig.port, MOVIE)).status).toBe(503);
            await live;
            await sleep(300);
            // The live client left: its channel's grace does not block VOD.
            rig.panel.vodChunkDelayMs = 20;
            const movie = startDownload(rig.port, MOVIE);
            await sleep(150);
            expect(
                (await fetchRelay(rig.port, `/live/${U}/${P}/1002.ts`)).status
            ).toBe(503);
            expect((await movie).complete).toBe(true);
            watch.stop();
            const status = rig.app.status();
            expect(status.refused503).toMatchObject({
                vodWhileLive: 1,
                liveWhileVod: 1,
            });
            expect(watch.peak()).toBe(1);
            expect(rig.app.status().channels).toHaveLength(0);

            // After the session's linger, live works again.
            await sleep(600);
            const again = await readLive(
                rig.port,
                `/live/${U}/${P}/1002.ts`,
                2000
            );
            expect(again.status).toBe(200);
            expect(again.checker.mediaMs).toBeGreaterThan(500);
        }, 20_000);

        it('answers a provider outage with 502 and frees the connection', async () => {
            rig.panel.down = true;
            const failed = await fetchRelay(rig.port, MOVIE);
            expect(failed.status).toBe(502);
            expectNoLeak(failed, 'vod outage');
            rig.panel.down = false;
            await sleep(500);
            const ok = await fetchRelay(rig.port, MOVIE, {
                headers: { Range: 'bytes=0-99' },
            });
            expect(ok.status).toBe(206);
            expect(rig.app.status().vod.upstreamErrors).toBe(1);
            expect(rig.app.relay.gate.idle).toBe(true);
        });
    });

    describe('with vodPolicy preempt', () => {
        beforeEach(async () => {
            rig = await startFrontRig({ vodPolicy: 'preempt' });
        });

        it('suspends live for the movie and resumes it afterwards', async () => {
            const watch = watchConnections(rig);
            const live = readLive(rig.port, `/live/${U}/${P}/1001.ts`, 9000);
            await sleep(1500);
            rig.panel.vodChunkDelayMs = 30;
            const movie = startDownload(rig.port, MOVIE);
            await sleep(400);
            expect(rig.app.status().suspended).toBe(true);
            expect((await movie).complete).toBe(true);
            await sleep(1500);
            const status = rig.app.status();
            expect(status.suspended).toBe(false);
            const channel = status.channels.find((c) => c.streamId === 1001);
            expect(channel?.clients).toBe(1);
            const opensAfter = rig.provider.stats().opens;
            const result = await live;
            watch.stop();
            expect(result.checker.ccErrors).toBe(0);
            expect(result.checker.mediaMs).toBeGreaterThan(2000);
            // The live channel reconnected after the movie.
            expect(opensAfter).toBeGreaterThanOrEqual(2);
            expect(watch.peak()).toBe(1);
            expect(rig.app.status().upstream.gate?.peak).toBe(1);
            expect(
                rig.lines.some((line) => line.includes('live rotation resumed'))
            ).toBe(true);
        }, 20_000);
    });
});
