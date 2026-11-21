import { request } from 'node:http';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { createFakeProvider, FakeProvider } from '../testing/fake-provider';
import { closeRelayServer, createRelayHttpServer } from './lan-relay-http';
import { RelayApp } from './relay-app';
import {
    FAKE_SECRETS,
    StreamChecker,
    testConfig,
} from './lan-relay.test-helpers';

jest.mock('../../util/validated-axios', () => ({
    requestWithValidatedRedirects: jest.fn(),
}));

const TOKEN = FAKE_SECRETS.token;

interface Fetched {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
}

function fetchText(
    port: number,
    path: string,
    method = 'GET'
): Promise<Fetched> {
    return new Promise((resolve, reject) => {
        const req = request(
            { host: '127.0.0.1', port, path, method },
            (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => (body += chunk));
                res.on('end', () =>
                    resolve({
                        status: res.statusCode ?? 0,
                        headers: res.headers,
                        body,
                    })
                );
            }
        );
        req.on('error', reject);
        req.end();
    });
}

/** Reads a live URL for `ms` of real time over a real socket. */
function readLive(
    port: number,
    path: string,
    ms: number
): Promise<{ checker: StreamChecker; maxGapMs: number; type?: string }> {
    return new Promise((resolve, reject) => {
        const checker = new StreamChecker();
        let pending = Buffer.alloc(0);
        let last = Date.now();
        let maxGapMs = 0;
        const req = request({ host: '127.0.0.1', port, path }, (res) => {
            res.on('data', (chunk: Buffer) => {
                const now = Date.now();
                maxGapMs = Math.max(maxGapMs, now - last);
                last = now;
                pending = Buffer.concat([pending, chunk]);
                const whole = pending.length - (pending.length % 188);
                checker.push(pending.subarray(0, whole));
                pending = pending.subarray(whole);
            });
            setTimeout(() => {
                req.destroy();
                resolve({
                    checker,
                    maxGapMs,
                    type: res.headers['content-type'],
                });
            }, ms);
        });
        req.on('error', (error) => {
            if (!req.destroyed) {
                reject(error);
            }
        });
        req.end();
    });
}

describe('LanRelay over HTTP', () => {
    let provider: FakeProvider;
    let app: RelayApp;
    let server: Server;
    let port: number;

    beforeAll(async () => {
        provider = createFakeProvider({
            speed: 1,
            depthSec: 8,
            burstSpeed: 12,
            connectMs: 200,
            gopFrames: 25,
        });
        const config = testConfig([1, 2]);
        app = new RelayApp({
            config,
            open: provider.open,
            clock: provider.clock,
        });
        server = createRelayHttpServer(app);
        await new Promise<void>((resolve) =>
            server.listen(0, '127.0.0.1', () => resolve())
        );
        port = (server.address() as AddressInfo).port;
        app.relay.start();
    });

    afterAll(async () => {
        await app.stop();
        await closeRelayServer(server);
    });

    it('serves a playlist that points only at the relay', async () => {
        const response = await fetchText(port, `/${TOKEN}/playlist.m3u`);
        expect(response.status).toBe(200);
        expect(response.body.split('\n')).toEqual([
            '#EXTM3U',
            '#EXTINF:-1 tvg-id="1" tvg-name="Synthetic 1",Synthetic 1',
            `http://127.0.0.1:${port}/${TOKEN}/live/1.ts`,
            '#EXTINF:-1 tvg-id="2" tvg-name="Synthetic 2",Synthetic 2',
            `http://127.0.0.1:${port}/${TOKEN}/live/2.ts`,
            '',
        ]);
        expect(response.body).not.toMatch(
            /provider\.example|relay-user|relay-pass/
        );
    });

    it('rejects other paths, tokens and methods', async () => {
        const wrong = TOKEN.replace(/.$/, 'x');
        expect((await fetchText(port, '/')).status).toBe(404);
        expect((await fetchText(port, `/${wrong}/playlist.m3u`)).status).toBe(
            404
        );
        expect((await fetchText(port, `/${TOKEN}/live/x.ts`)).status).toBe(404);
        expect((await fetchText(port, `/${TOKEN}/other`)).status).toBe(404);
        expect((await fetchText(port, `/${TOKEN}/status`, 'POST')).status).toBe(
            405
        );
        const head = await fetchText(port, `/${TOKEN}/live/1.ts`, 'HEAD');
        expect(head.status).toBe(200);
        expect(head.headers['content-type']).toBe('video/mp2t');
        // A HEAD request does not start a channel.
        expect(app.relay.status().channels).toHaveLength(0);
    });

    it('streams two channels at once over real sockets', async () => {
        const [one, two] = await Promise.all([
            readLive(port, `/${TOKEN}/live/1.ts`, 9000),
            readLive(port, `/${TOKEN}/live/2.ts`, 9000),
        ]);
        for (const result of [one, two]) {
            expect(result.type).toBe('video/mp2t');
            expect(result.checker.startsClean).toBe(true);
            expect(result.checker.ccErrors).toBe(0);
            expect(result.checker.ptsErrors).toBe(0);
            expect(result.checker.mediaMs).toBeGreaterThan(4000);
            expect(result.maxGapMs).toBeLessThan(1000);
        }
        expect(provider.stats().peak).toBe(1);

        await new Promise((resolve) => setTimeout(resolve, 200));
        const status = JSON.parse(
            (await fetchText(port, `/${TOKEN}/status`)).body
        );
        expect(status.upstream.maxOpenAtOnce).toBe(1);
        expect(
            status.channels.map((c: { streamId: number }) => c.streamId).sort()
        ).toEqual([1, 2]);
        // Both sockets were closed by the reader.
        expect(
            status.channels.every((c: { clients: number }) => c.clients === 0)
        ).toBe(true);
    }, 20_000);
});
