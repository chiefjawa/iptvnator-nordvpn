import { gunzipSync } from 'node:zlib';
import { PANEL_ACCOUNT } from '../testing/fake-panel';
import { FAKE_LOGIN, FAKE_SECRETS } from './lan-relay.test-helpers';
import {
    expectNoLeak,
    fetchRelay,
    FrontRig,
    LEAK_PATTERNS,
    readLive,
    sleep,
    startFrontRig,
} from './relay-front.test-helpers';

const U = FAKE_LOGIN.username;
const P = FAKE_LOGIN.password;
const AUTH = `username=${U}&password=${P}`;
const ACTIONS = [
    '',
    '&action=get_live_categories',
    '&action=get_live_streams',
    '&action=get_live_streams&category_id=1',
    '&action=get_vod_categories',
    '&action=get_vod_streams',
    '&action=get_vod_info&vod_id=2001',
    '&action=get_series_categories',
    '&action=get_series',
    '&action=get_series_info&series_id=301',
    '&action=get_short_epg&stream_id=1001&limit=4',
    '&action=get_simple_data_table&stream_id=1001',
];

async function api(rig: FrontRig, query: string): Promise<unknown> {
    const response = await fetchRelay(rig.port, `/player_api.php?${query}`);
    expect(response.status).toBe(200);
    expectNoLeak(response, query);
    return JSON.parse(response.body.toString('utf8'));
}

describe('relay Xtream front', () => {
    let rig: FrontRig;

    beforeEach(async () => {
        rig = await startFrontRig({ maxLiveChannels: 2 });
    });

    afterEach(async () => {
        await rig.close();
    });

    it('answers the login with local credentials, its own address and capacity', async () => {
        const login = (await api(rig, AUTH)) as {
            user_info: Record<string, unknown>;
            server_info: Record<string, unknown>;
        };
        expect(login.user_info).toMatchObject({
            username: U,
            password: P,
            auth: 1,
            status: 'Active',
            max_connections: '2',
            active_cons: '0',
            allowed_output_formats: ['ts'],
            message: `Welcome ${U}, server 127.0.0.1`,
        });
        expect(login.server_info).toMatchObject({
            url: '127.0.0.1',
            port: String(rig.port),
            https_port: String(rig.port),
            rtmp_port: String(rig.port),
            server_protocol: 'http',
            timezone: 'UTC',
        });
    });

    it('answers unknown logins like a panel, without asking the provider', async () => {
        // Only the start-up catalogue warm-up has asked the panel.
        expect([...rig.panel.hits.keys()]).toEqual(['api:get_live_streams']);
        for (const query of [
            `username=${U}&password=wrong-pass`,
            `username=nobody&password=${P}`,
            `username=${PANEL_ACCOUNT.username}&password=${PANEL_ACCOUNT.password}`,
            '',
            'action=get_live_streams',
        ]) {
            const response = await fetchRelay(
                rig.port,
                `/player_api.php?${query}`
            );
            expect(response.status).toBe(200);
            expect(JSON.parse(response.body.toString())).toEqual({
                user_info: { auth: 0 },
            });
        }
        expect([...rig.panel.hits.values()]).toEqual([1]);
        const guide = await fetchRelay(
            rig.port,
            '/xmltv.php?username=x&password=y'
        );
        expect(guide.status).toBe(401);
        expect(
            (await fetchRelay(rig.port, '/get.php?username=x&password=y'))
                .status
        ).toBe(401);
        expect((await fetchRelay(rig.port, '/live/x/y/1001.ts')).status).toBe(
            403
        );
        expect(
            (await fetchRelay(rig.port, `/movie/${U}/bad/2001.mkv`)).status
        ).toBe(403);
        expect(rig.app.status().http.unauthorized).toBe(9);
    });

    it('accepts the POST form of player_api.php', async () => {
        const response = await fetchRelay(rig.port, '/player_api.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `${AUTH}&action=get_live_categories`,
        });
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body.toString())).toEqual([
            { category_id: '1', category_name: 'Synthetic News', parent_id: 0 },
        ]);
    });

    it('rewrites stream URLs to the relay and blanks other provider URLs', async () => {
        const live = (await api(
            rig,
            `${AUTH}&action=get_live_streams`
        )) as Record<string, unknown>[];
        expect(live).toHaveLength(5);
        expect(live[0]).toMatchObject({
            stream_id: 1001,
            stream_icon: '',
            direct_source: '',
        });
        const vod = (await api(
            rig,
            `${AUTH}&action=get_vod_streams`
        )) as Record<string, unknown>[];
        expect(vod[0]).toMatchObject({
            stream_icon: 'https://images.example.test/film.jpg',
            direct_source: '',
        });
        const info = (await api(
            rig,
            `${AUTH}&action=get_vod_info&vod_id=2001`
        )) as {
            info: Record<string, unknown>;
            movie_data: Record<string, unknown>;
        };
        expect(info.movie_data['custom_sid']).toBe(
            `http://127.0.0.1:${rig.port}/movie/${U}/${P}/2001.mkv`
        );
        expect(info.info['cover_big']).toBe('');
        const series = (await api(
            rig,
            `${AUTH}&action=get_series_info&series_id=301`
        )) as {
            episodes: Record<string, Record<string, unknown>[]>;
        };
        expect(series.episodes['1'][0]).toMatchObject({
            id: '4001',
            direct_source: '',
        });
        expect(rig.app.status().api.blankedProviderUrls).toBeGreaterThan(5);
    });

    it('caches catalogue actions, serves stale while revalidating and when the provider is down', async () => {
        const path = `${AUTH}&action=get_live_streams`;
        await api(rig, path);
        await api(rig, path);
        expect(rig.panel.hits.get('api:get_live_streams')).toBe(1);

        // Older than the 6 h TTL: served at once, refreshed behind.
        rig.clockOffsetMs = 7 * 3600_000;
        expect(await api(rig, path)).toHaveLength(5);
        await sleep(200);
        expect(rig.panel.hits.get('api:get_live_streams')).toBe(2);

        rig.clockOffsetMs = 14 * 3600_000;
        rig.panel.down = true;
        expect(await api(rig, path)).toHaveLength(5);
        await sleep(200);
        const stats = rig.app.status().api.cache['get_live_streams'];
        expect(stats).toMatchObject({ hits: 2, stale: 2, misses: 1 });
        expect(stats.errors).toBeGreaterThanOrEqual(1);

        // Nothing cached and the provider down: an error, not a crash.
        const fresh = await fetchRelay(
            rig.port,
            `/player_api.php?${AUTH}&action=get_series`
        );
        expect(fresh.status).toBe(502);
        expect(JSON.parse(fresh.body.toString())).toEqual([]);
        expectNoLeak(fresh, 'provider down');
    });

    it('caches the short EPG for a minute only', async () => {
        const path = `${AUTH}&action=get_short_epg&stream_id=1001`;
        await api(rig, path);
        await api(rig, path);
        expect(rig.panel.hits.get('api:get_short_epg')).toBe(1);
        rig.clockOffsetMs = 61_000;
        await api(rig, path);
        await sleep(200);
        expect(rig.panel.hits.get('api:get_short_epg')).toBe(2);
    });

    it('proxies the guide with a gzip cache, scrubbed, and keeps it when the provider is down', async () => {
        const gz = await fetchRelay(rig.port, `/xmltv.php?${AUTH}`, {
            headers: { 'Accept-Encoding': 'gzip' },
        });
        expect(gz.status).toBe(200);
        expect(gz.headers['content-encoding']).toBe('gzip');
        expect(gz.headers['set-cookie']).toBeUndefined();
        const text = gunzipSync(gz.body).toString('utf8');
        expect(text).toContain('<tv generator-info-name="panel"');
        expect(text.match(/<programme /g)).toHaveLength(400);
        for (const pattern of LEAK_PATTERNS) {
            expect(text.includes(pattern)).toBe(false);
        }
        expectNoLeak({ ...gz, body: Buffer.from(text) }, 'xmltv');

        const plain = await fetchRelay(rig.port, `/xmltv.php?${AUTH}`);
        expect(plain.headers['content-encoding']).toBeUndefined();
        expect(plain.body.toString('utf8')).toBe(text);
        expect(rig.panel.hits.get('xmltv')).toBe(1);

        rig.clockOffsetMs = 13 * 3600_000;
        rig.panel.down = true;
        const stale = await fetchRelay(rig.port, `/xmltv.php?${AUTH}`);
        expect(stale.body.toString('utf8')).toBe(text);
        await sleep(200);
        expect(rig.app.status().api.cache['xmltv']).toMatchObject({
            hits: 1,
            stale: 1,
            misses: 1,
        });
    });

    it('generates get.php from the catalogue with relay URLs', async () => {
        const response = await fetchRelay(
            rig.port,
            `/get.php?${AUTH}&type=m3u_plus&output=ts`
        );
        expect(response.status).toBe(200);
        expectNoLeak(response, 'get.php');
        const lines = response.body.toString('utf8').trim().split('\n');
        const base = `http://127.0.0.1:${rig.port}`;
        expect(lines[0]).toBe(`#EXTM3U url-tvg="${base}/xmltv.php?${AUTH}"`);
        expect(lines[1]).toBe(
            '#EXTINF:-1 tvg-id="synthetic1001.example" tvg-name="Synthetic Live 1001" tvg-logo="" group-title="Synthetic News",Synthetic Live 1001'
        );
        expect(lines[2]).toBe(`${base}/live/${U}/${P}/1001.ts`);
        expect(lines).toContain(`${base}/movie/${U}/${P}/2001.mkv`);
        expect(lines.filter((line) => line.startsWith('http'))).toHaveLength(6);
    });

    it('serves every live URL form from the multiplexed channel, and refuses HLS', async () => {
        const forms = [
            `/live/${U}/${P}/1001.ts`,
            `/${U}/${P}/1001`,
            `/${U}/${P}/1001.ts`,
        ];
        for (const form of forms) {
            const result = await readLive(rig.port, form, 2500);
            expect(result.status).toBe(200);
            expect(result.checker.startsClean).toBe(true);
            expect(result.checker.ccErrors).toBe(0);
            expect(result.checker.mediaMs).toBeGreaterThan(1000);
        }
        const hls = await fetchRelay(rig.port, `/live/${U}/${P}/1001.m3u8`);
        expect(hls.status).toBe(404);
        expect(rig.lines.some((line) => line.includes('MPEG-TS only'))).toBe(
            true
        );
        expect(rig.provider.stats().peak).toBe(1);
        // Names for logs come from the cached catalogue.
        await api(rig, `${AUTH}&action=get_live_streams`);
        const status = rig.app.status();
        expect(status.channels.map((c) => c.streamId)).toEqual([1001]);
    }, 20_000);

    it('refuses a channel beyond maxLiveChannels with 503 and counts it', async () => {
        const one = readLive(rig.port, `/live/${U}/${P}/1001.ts`, 3000);
        const two = readLive(rig.port, `/live/${U}/${P}/1002.ts`, 3000);
        await sleep(300);
        const third = await fetchRelay(rig.port, `/live/${U}/${P}/1003.ts`);
        expect(third.status).toBe(503);
        await Promise.all([one, two]);
        expect(rig.app.status().refused503.liveCapacity).toBe(1);
        expect(rig.provider.stats().peak).toBe(1);
    }, 20_000);

    it('never shows the provider in any endpoint, header, status or log line', async () => {
        const token = FAKE_SECRETS.token;
        const paths = [
            ...ACTIONS.map((query) => `/player_api.php?${AUTH}${query}`),
            `/xmltv.php?${AUTH}`,
            `/get.php?${AUTH}&type=m3u_plus`,
            `/${token}/playlist.m3u`,
            `/movie/${U}/${P}/2001.mkv`,
            `/series/${U}/${P}/4001.mp4`,
            `/timeshift/${U}/${P}/60/2026-11-21:10-00/1001.ts`,
            `/streaming/timeshift.php?${AUTH}&stream=1001&start=2026-11-21:10-00&duration=60`,
            '/nothing-here',
            `/live/${U}/${P}/1001.m3u8`,
        ];
        for (const path of paths) {
            for (const headers of [
                {},
                { 'Accept-Encoding': 'gzip' },
                { Range: 'bytes=100-199' },
            ]) {
                const response = await fetchRelay(rig.port, path, { headers });
                const body =
                    response.headers['content-encoding'] === 'gzip'
                        ? gunzipSync(response.body)
                        : response.body;
                expectNoLeak({ ...response, body }, path);
                await sleep(450); // let the VOD session linger end
            }
            expectNoLeak(
                await fetchRelay(rig.port, path, { method: 'HEAD' }),
                `HEAD ${path}`
            );
            await sleep(450);
        }
        const status = await fetchRelay(rig.port, `/${token}/status`);
        expectNoLeak(status, 'status');
        const parsed = JSON.parse(status.body.toString());
        expect(parsed).toMatchObject({
            version: 'dev',
            vod: { policy: 'refuse' },
        });
        expect(parsed.upstream.gate.peak).toBe(1);
        expect(rig.panel.streamPeak()).toBe(1);
        for (const line of rig.lines) {
            for (const pattern of [...LEAK_PATTERNS, P]) {
                expect(line.includes(pattern)).toBe(false);
            }
        }
    }, 60_000);
});
