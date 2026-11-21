/**
 * HTTP front of the LAN relay.
 *
 * Two kinds of paths:
 *
 * - Token paths, `/<token>/playlist.m3u|status|live/<id>.ts`, for a plain
 *   M3U player and for diagnostics (`status` is token-only).
 * - Xtream paths (`player_api.php`, `xmltv.php`, `get.php`, stream URLs)
 *   authenticated by the local logins in `clients`.
 *
 * Anything else is a 404. The player never sees the provider, the account
 * or an upstream URL; the relay's address comes from the request's `Host`.
 */

import { timingSafeEqual } from 'node:crypto';
import {
    createServer,
    IncomingMessage,
    Server,
    ServerResponse,
} from 'node:http';
import type { RelayApp } from './relay-app';
import { RelayConfig } from './relay-config';
import { serveLive } from './relay-live-http';
import { handleXtream, Origin, send } from './xtream/xtream-http';

const HOST_HEADER = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;
const LIVE_PATH = /^live\/(\d{1,12})\.ts$/;

export function createRelayHttpServer(app: RelayApp): Server {
    const config = app.deps.config;
    const log = app.deps.log;
    const server = createServer((request, response) => {
        handle(request, response).catch((error: unknown) => {
            app.http.errors += 1;
            log?.warn(`request failed: ${(error as Error)?.name ?? 'Error'}`);
            if (!response.headersSent) {
                plain(response, 500);
            } else {
                response.destroy();
            }
        });
    });
    // Live and VOD responses are long; only the request itself is timed.
    server.requestTimeout = 30000;
    server.headersTimeout = 15000;

    async function handle(
        request: IncomingMessage,
        response: ServerResponse
    ): Promise<void> {
        const method = request.method ?? 'GET';
        const url = new URL(request.url ?? '/', 'http://relay.invalid');
        const path = url.pathname;
        const [, first, ...rest] = path.split('/');
        if (first && sameToken(first, config.token)) {
            if (method !== 'GET' && method !== 'HEAD') {
                response.writeHead(405, { Allow: 'GET, HEAD' });
                response.end();
                return;
            }
            tokenRoute(request, response, rest.join('/'));
            return;
        }
        const post = method === 'POST' && path === '/player_api.php';
        if (method !== 'GET' && method !== 'HEAD' && !post) {
            response.writeHead(405, { Allow: 'GET, HEAD' });
            response.end();
            return;
        }
        const origin = originFor(request, config);
        const handled = await handleXtream(
            app,
            request,
            response,
            path,
            url.searchParams,
            origin
        );
        if (!handled) {
            app.http.notFound += 1;
            plain(response, 404);
        }
    }

    function tokenRoute(
        request: IncomingMessage,
        response: ServerResponse,
        route: string
    ): void {
        const headOnly = request.method === 'HEAD';
        if (route === 'playlist.m3u') {
            const body = playlist(app, originFor(request, config).origin);
            send(
                response,
                200,
                'audio/x-mpegurl; charset=utf-8',
                body,
                headOnly
            );
            return;
        }
        if (route === 'status') {
            const body = JSON.stringify(app.status(), null, 2);
            send(
                response,
                200,
                'application/json; charset=utf-8',
                body,
                headOnly
            );
            return;
        }
        const live = LIVE_PATH.exec(route);
        if (!live) {
            app.http.notFound += 1;
            plain(response, 404);
            return;
        }
        serveLive(app.relay, request, response, Number(live[1]));
    }

    return server;
}

export async function closeRelayServer(server: Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** The token playlist: the configured `channels`, pointing at this relay. */
export function playlist(app: RelayApp, origin: string): string {
    const config = app.deps.config;
    const lines = ['#EXTM3U'];
    for (const channel of config.channels) {
        const attribute = channel.name.replace(/"/g, "'");
        lines.push(
            `#EXTINF:-1 tvg-id="${channel.streamId}" tvg-name="${attribute}",${channel.name}`,
            `${origin}/${config.token}/live/${channel.streamId}.ts`
        );
    }
    return `${lines.join('\n')}\n`;
}

/** The address the player used, so links work from its side. */
function originFor(request: IncomingMessage, config: RelayConfig): Origin {
    const header = request.headers.host?.trim();
    let hostPort: string;
    if (header && HOST_HEADER.test(header)) {
        hostPort = header;
    } else {
        const listen = config.listen;
        const local = request.socket.localAddress;
        const wildcard =
            listen.kind !== 'tcp' ||
            listen.host === '0.0.0.0' ||
            listen.host === '::';
        const address = wildcard ? (local ?? '127.0.0.1') : listen.host;
        const port =
            request.socket.localPort ??
            (listen.kind === 'tcp' ? listen.port : 80);
        const bracketed = address.includes(':') ? `[${address}]` : address;
        hostPort = `${bracketed}:${port}`;
    }
    const host = hostPort.startsWith('[')
        ? hostPort.slice(0, hostPort.indexOf(']') + 1)
        : hostPort.split(':')[0];
    return { origin: `http://${hostPort}`, host };
}

function sameToken(given: string, expected: string): boolean {
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

function plain(response: ServerResponse, status: number): void {
    response.writeHead(status, { 'Cache-Control': 'no-store' });
    response.end();
}
