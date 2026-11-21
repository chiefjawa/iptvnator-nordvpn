/**
 * A synthetic Xtream panel on a real socket, for the relay's front specs.
 *
 * It answers `player_api.php` (login and catalogue actions), `xmltv.php`
 * (gzip) and ranged VOD/catch-up files, and plants the provider's address
 * and account in the places a real panel does — stream URLs, direct
 * sources, artwork, free text, the guide — so the specs can prove none of
 * it reaches a relay client. It counts concurrent stream connections
 * together with the live fake provider, so the one-connection invariant
 * can be asserted across live and VOD.
 */

import {
    createServer,
    IncomingMessage,
    Server,
    ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

export const PANEL_ACCOUNT = {
    username: 'realacct-u7',
    password: 'realsecret-p9',
};
/** Loopback address of the panel, distinct from the relay's 127.0.0.1. */
export const PANEL_HOST = '127.0.0.2';
export const VOD_BYTES = 2 * 1024 * 1024;

export interface FakePanel {
    readonly url: string;
    readonly port: number;
    /** Requests by path kind, e.g. `api:get_live_streams`, `xmltv`, `movie`. */
    readonly hits: Map<string, number>;
    /** Most VOD connections open at once, plus live ones from `liveOpenNow`. */
    readonly streamPeak: () => number;
    readonly vodOpenNow: () => number;
    /** Ranges asked for, in order. */
    readonly ranges: string[];
    down: boolean;
    /** Delay per 64 KiB of VOD body, to keep transfers open. */
    vodChunkDelayMs: number;
    close(): Promise<void>;
}

export function vodByte(offset: number): number {
    return (offset * 31 + 7) & 0xff;
}

export async function startFakePanel(
    liveOpenNow: () => number = () => 0
): Promise<FakePanel> {
    const hits = new Map<string, number>();
    const ranges: string[] = [];
    let vodOpen = 0;
    let peak = 0;
    const count = (key: string) => hits.set(key, (hits.get(key) ?? 0) + 1);
    let origin = '';

    const panel: FakePanel = {
        url: '',
        port: 0,
        hits,
        ranges,
        streamPeak: () => peak,
        vodOpenNow: () => vodOpen,
        down: false,
        vodChunkDelayMs: 0,
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };

    const server: Server = createServer((request, response) => {
        if (panel.down) {
            request.socket.destroy();
            return;
        }
        const url = new URL(request.url ?? '/', 'http://panel.invalid');
        const authed =
            url.searchParams.get('username') === PANEL_ACCOUNT.username &&
            url.searchParams.get('password') === PANEL_ACCOUNT.password;
        if (url.pathname === '/player_api.php') {
            const action = url.searchParams.get('action') ?? 'login';
            count(`api:${action}`);
            json(
                response,
                authed
                    ? apiAnswer(action, origin, url.searchParams)
                    : { user_info: { auth: 0 } }
            );
            return;
        }
        if (url.pathname === '/xmltv.php') {
            count('xmltv');
            const body = gzipSync(Buffer.from(guide(origin)));
            response.writeHead(200, {
                'Content-Type': 'application/xml',
                'Content-Encoding': 'gzip',
                'Set-Cookie': `panel=${PANEL_ACCOUNT.password}`,
                'X-Server': `${PANEL_HOST}`,
            });
            response.end(body);
            return;
        }
        const parts = url.pathname.split('/').slice(1);
        const kind = parts[0];
        if (
            ['movie', 'series', 'timeshift'].includes(kind) &&
            parts[1] === PANEL_ACCOUNT.username &&
            parts[2] === PANEL_ACCOUNT.password
        ) {
            count(kind);
            void serveFile(request, response);
            return;
        }
        response.writeHead(404);
        response.end();
    });

    async function serveFile(
        request: IncomingMessage,
        response: ServerResponse
    ): Promise<void> {
        vodOpen += 1;
        peak = Math.max(peak, vodOpen + liveOpenNow());
        let closed = false;
        response.once('close', () => {
            closed = true;
            vodOpen -= 1;
        });
        const range = request.headers.range;
        ranges.push(range ?? '');
        let start = 0;
        let end = VOD_BYTES - 1;
        const match = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
        if (range && !match) {
            response.writeHead(416, {
                'Content-Range': `bytes */${VOD_BYTES}`,
            });
            response.end();
            return;
        }
        if (match) {
            start = Number(match[1]);
            end = match[2] ? Math.min(Number(match[2]), VOD_BYTES - 1) : end;
            if (start >= VOD_BYTES) {
                response.writeHead(416, {
                    'Content-Range': `bytes */${VOD_BYTES}`,
                });
                response.end();
                return;
            }
        }
        response.writeHead(match ? 206 : 200, {
            'Content-Type': 'video/x-matroska',
            'Content-Length': String(end - start + 1),
            'Accept-Ranges': 'bytes',
            ...(match
                ? { 'Content-Range': `bytes ${start}-${end}/${VOD_BYTES}` }
                : {}),
            'Set-Cookie': `session=${PANEL_ACCOUNT.username}`,
            Location: `${origin}/movie/${PANEL_ACCOUNT.username}/x`,
            'X-Origin': origin,
        });
        if (request.method === 'HEAD') {
            response.end();
            return;
        }
        for (let offset = start; offset <= end && !closed; offset += 65536) {
            const last = Math.min(end, offset + 65535);
            const chunk = Buffer.alloc(last - offset + 1);
            for (let i = 0; i < chunk.length; i += 1) {
                chunk[i] = vodByte(offset + i);
            }
            if (!response.write(chunk)) {
                await new Promise((resolve) => response.once('drain', resolve));
            }
            if (panel.vodChunkDelayMs > 0) {
                await new Promise((resolve) =>
                    setTimeout(resolve, panel.vodChunkDelayMs)
                );
            }
        }
        response.end();
    }

    await new Promise<void>((resolve) =>
        server.listen(0, PANEL_HOST, () => resolve())
    );
    const port = (server.address() as AddressInfo).port;
    origin = `http://${PANEL_HOST}:${port}`;
    return Object.assign(panel, { url: origin, port });
}

function json(response: ServerResponse, value: unknown): void {
    const body = JSON.stringify(value);
    response.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Powered-By': `panel ${PANEL_HOST}`,
    });
    response.end(body);
}

/** Synthetic catalogue with the provider planted everywhere it can be. */
export function apiAnswer(
    action: string,
    origin: string,
    query: URLSearchParams
): unknown {
    const { username: u, password: p } = PANEL_ACCOUNT;
    const host = new URL(origin).hostname;
    switch (action) {
        case 'login':
            return {
                user_info: {
                    username: u,
                    password: p,
                    message: `Welcome ${u}, server ${host}`,
                    auth: 1,
                    status: 'Active',
                    exp_date: '1893456000',
                    is_trial: '0',
                    active_cons: '0',
                    max_connections: '1',
                    allowed_output_formats: ['m3u8', 'ts'],
                },
                server_info: {
                    url: host,
                    port: new URL(origin).port,
                    https_port: '8443',
                    server_protocol: 'http',
                    rtmp_port: '8880',
                    timezone: 'UTC',
                    timestamp_now: 1700000000,
                },
            };
        case 'get_live_categories':
            return [
                {
                    category_id: '1',
                    category_name: 'Synthetic News',
                    parent_id: 0,
                },
            ];
        case 'get_live_streams':
            return [1001, 1002, 1003, 1004, 1005].map((id) => ({
                num: id - 1000,
                name: `Synthetic Live ${id}`,
                stream_type: 'live',
                stream_id: id,
                stream_icon: `${origin}/images/${id}.png`,
                epg_channel_id: `synthetic${id}.example`,
                category_id: '1',
                direct_source: `http://cdn.example.test/live/${u}/${p}/${id}.ts`,
                tv_archive: 1,
                tv_archive_duration: 3,
            }));
        case 'get_vod_categories':
            return [
                {
                    category_id: '7',
                    category_name: 'Synthetic Films',
                    parent_id: 0,
                },
            ];
        case 'get_vod_streams':
            return [
                {
                    num: 1,
                    name: 'Synthetic Film',
                    stream_type: 'movie',
                    stream_id: 2001,
                    stream_icon: 'https://images.example.test/film.jpg',
                    category_id: '7',
                    container_extension: 'mkv',
                    direct_source: `${origin}/movie/${u}/${p}/2001.mkv`,
                },
            ];
        case 'get_vod_info':
            return {
                info: {
                    name: 'Synthetic Film',
                    cover_big: `${origin}/covers/2001.jpg`,
                    plot: `Served by ${origin}`,
                },
                movie_data: {
                    stream_id: Number(query.get('vod_id') ?? 2001),
                    container_extension: 'mkv',
                    direct_source: `${origin}/movie/${u}/${p}/2001.mkv`,
                    custom_sid: `${origin}/movie/${u}/${p}/2001.mkv`,
                },
            };
        case 'get_series_categories':
            return [
                {
                    category_id: '9',
                    category_name: 'Synthetic Shows',
                    parent_id: 0,
                },
            ];
        case 'get_series':
            return [
                {
                    series_id: 301,
                    name: 'Synthetic Show',
                    cover: `${origin}/s/301.jpg`,
                    category_id: '9',
                },
            ];
        case 'get_series_info':
            return {
                info: { name: 'Synthetic Show' },
                episodes: {
                    '1': [
                        {
                            id: '4001',
                            episode_num: 1,
                            container_extension: 'mp4',
                            direct_source: `http://other-dns.example.test/series/${u}/${p}/4001.mp4`,
                            info: { movie_image: `${origin}/e/4001.jpg` },
                        },
                    ],
                },
            };
        case 'get_short_epg':
            return {
                epg_listings: [
                    {
                        id: '1',
                        title: Buffer.from('Synthetic Programme').toString(
                            'base64'
                        ),
                        start: '2026-11-21 10:00:00',
                        end: '2026-11-21 11:00:00',
                        stream_id: query.get('stream_id') ?? '1001',
                        channel_id: 'synthetic1001.example',
                        description: Buffer.from(`At ${origin}`).toString(
                            'base64'
                        ),
                    },
                ],
            };
        case 'get_simple_data_table':
            return { epg_listings: [] };
        default:
            return [];
    }
}

function guide(origin: string): string {
    const { username: u, password: p } = PANEL_ACCOUNT;
    const programmes = Array.from(
        { length: 400 },
        (_, i) =>
            `<programme start="20261121${String(i % 24).padStart(2, '0')}0000 +0000" channel="synthetic1001.example"><title>Synthetic ${i}</title></programme>`
    ).join('\n');
    return (
        `<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="panel" generator-info-url="${origin}/xmltv.php?username=${u}&amp;password=${p}">\n` +
        `<channel id="synthetic1001.example"><display-name>Synthetic Live 1001</display-name><icon src="${origin}/images/1001.png"/></channel>\n` +
        `${programmes}\n</tv>\n`
    );
}
