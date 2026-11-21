/**
 * HTTP front of the LAN relay.
 *
 * Every path starts with the configured token; anything else is a 404, so
 * the server reveals nothing to a host on the LAN that was not given the
 * playlist link. The playlist points the player at this server only: it
 * never sees the provider, the account or the upstream URL.
 */

import { timingSafeEqual } from 'node:crypto';
import {
    createServer,
    IncomingMessage,
    Server,
    ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';
import { LanRelay } from './lan-relay';
import { RelayConfig } from './relay-config';
import { ClientOutput } from './relay-client';
import { RelayLogger } from './relay-log';

const HOST_HEADER = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;
const LIVE_PATH = /^live\/(\d{1,12})\.ts$/;

export function createRelayHttpServer(
    relay: LanRelay,
    config: RelayConfig,
    log?: RelayLogger
): Server {
    const server = createServer((request, response) => {
        try {
            handle(request, response);
        } catch (error) {
            log?.warn(`request failed: ${(error as Error)?.name ?? 'Error'}`);
            if (!response.headersSent) {
                plain(response, 500);
            } else {
                response.destroy();
            }
        }
    });
    // A live response is endless; only the request itself is timed.
    server.requestTimeout = 30000;
    server.headersTimeout = 15000;

    function handle(request: IncomingMessage, response: ServerResponse): void {
        const path = (request.url ?? '/').split('?')[0];
        const [, token, ...rest] = path.split('/');
        if (!token || !sameToken(token, config.token)) {
            plain(response, 404);
            return;
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { Allow: 'GET, HEAD' });
            response.end();
            return;
        }
        const route = rest.join('/');
        if (route === 'playlist.m3u') {
            const body = playlist(config, hostFor(request, config));
            send(request, response, 'audio/x-mpegurl; charset=utf-8', body);
            return;
        }
        if (route === 'status') {
            const body = JSON.stringify(relay.status(), null, 2);
            send(request, response, 'application/json; charset=utf-8', body);
            return;
        }
        const live = LIVE_PATH.exec(route);
        const streamId = live ? Number(live[1]) : NaN;
        if (!live || !relay.hasChannel(streamId)) {
            plain(response, 404);
            return;
        }
        serveLive(request, response, streamId);
    }

    function serveLive(
        request: IncomingMessage,
        response: ServerResponse,
        streamId: number
    ): void {
        response.writeHead(200, {
            'Content-Type': 'video/mp2t',
            'Cache-Control': 'no-store',
            Connection: 'close',
        });
        if (request.method === 'HEAD') {
            response.end();
            return;
        }
        response.flushHeaders();
        request.socket.setNoDelay(true);
        request.socket.setTimeout(0);
        const output: ClientOutput = {
            write: (data) => response.write(data),
            onDrain: (listener) => response.once('drain', listener),
            close: () => response.end(),
        };
        const remote = request.socket.remoteAddress ?? 'unknown';
        const client = relay.attach(streamId, output, remote);
        if (!client) {
            response.end();
            return;
        }
        response.once('close', () => relay.detach(streamId, client));
    }

    return server;
}

export function listenRelay(
    server: Server,
    host: string,
    port: number
): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            server.off('error', reject);
            resolve(server.address() as AddressInfo);
        });
    });
}

export async function closeRelayServer(server: Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

export function playlist(config: RelayConfig, host: string): string {
    const lines = ['#EXTM3U'];
    for (const channel of config.channels) {
        const attribute = channel.name.replace(/"/g, "'");
        lines.push(
            `#EXTINF:-1 tvg-id="${channel.streamId}" tvg-name="${attribute}",${channel.name}`,
            `http://${host}/${config.token}/live/${channel.streamId}.ts`
        );
    }
    return `${lines.join('\n')}\n`;
}

/** The address the player used, so the playlist links work from its side. */
function hostFor(request: IncomingMessage, config: RelayConfig): string {
    const header = request.headers.host?.trim();
    if (header && HOST_HEADER.test(header)) {
        return header;
    }
    const local = request.socket.localAddress;
    const address =
        config.host === '0.0.0.0' || config.host === '::'
            ? (local ?? '127.0.0.1')
            : config.host;
    return `${address.includes(':') ? `[${address}]` : address}:${config.port}`;
}

function sameToken(given: string, expected: string): boolean {
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

function send(
    request: IncomingMessage,
    response: ServerResponse,
    type: string,
    body: string
): void {
    response.writeHead(200, {
        'Content-Type': type,
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
}

function plain(response: ServerResponse, status: number): void {
    response.writeHead(status, { 'Cache-Control': 'no-store' });
    response.end();
}
