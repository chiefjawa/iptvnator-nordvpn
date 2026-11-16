/**
 * Loopback HTTP relay that serves each multiview tile its stitched stream.
 *
 * The scheduler writes a tile's transport stream here; the tile's player
 * reads it as one endless MPEG-TS response. The server listens on 127.0.0.1
 * only, on an ephemeral port, and every URL carries an unguessable token —
 * other local software (or anything sharing the VPN namespace) cannot read
 * a stream it was not handed.
 *
 * This is media plumbing between the main process and its own renderer. It
 * opens no connection to the provider and is unrelated to VPN routing.
 */

import { randomBytes } from 'node:crypto';
import {
    createServer,
    IncomingMessage,
    Server,
    ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';
import { TileSink } from '../scheduler/scheduler-types';

/** Media held for a tile whose player has not connected yet. */
const MAX_PENDING_BYTES = 96 * 1024 * 1024;

export interface RelayTile {
    readonly url: string;
    readonly sink: TileSink;
    dispose(): void;
}

class TileChannel implements TileSink {
    private pending: Buffer[] = [];
    private pendingBytes = 0;
    private response: ServerResponse | null = null;

    write(packets: Buffer[]): void {
        const data = Buffer.concat(packets);
        if (this.response) {
            this.response.write(data);
            return;
        }
        // Each write is a run of whole segments, so dropping the oldest
        // write still leaves a stream that starts on a keyframe.
        this.pending.push(data);
        this.pendingBytes += data.length;
        while (
            this.pendingBytes > MAX_PENDING_BYTES &&
            this.pending.length > 1
        ) {
            this.pendingBytes -= (this.pending.shift() as Buffer).length;
        }
    }

    attach(response: ServerResponse): void {
        this.response?.end();
        this.response = response;
        response.once('close', () => {
            if (this.response === response) {
                this.response = null;
            }
        });
        for (const data of this.pending) {
            response.write(data);
        }
        this.pending = [];
        this.pendingBytes = 0;
    }

    close(): void {
        this.response?.end();
        this.response = null;
        this.pending = [];
        this.pendingBytes = 0;
    }
}

export class RelayServer {
    private readonly token = randomBytes(32).toString('hex');
    private readonly channels = new Map<string, TileChannel>();
    private server: Server | null = null;
    private starting: Promise<void> | null = null;
    private port = 0;

    /** Starts listening on first use. */
    async start(): Promise<void> {
        this.starting ??= new Promise<void>((resolve, reject) => {
            const server = createServer((request, response) =>
                this.handle(request, response)
            );
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                this.port = (server.address() as AddressInfo).port;
                this.server = server;
                resolve();
            });
        });
        await this.starting;
    }

    /** Creates the stream for one tile. `key` must be unique per stream. */
    async createTile(key: string): Promise<RelayTile> {
        await this.start();
        const channel = new TileChannel();
        this.channels.set(key, channel);
        return {
            url: `http://127.0.0.1:${this.port}/${this.token}/tile/${key}.ts`,
            sink: channel,
            dispose: () => {
                channel.close();
                this.channels.delete(key);
            },
        };
    }

    async stop(): Promise<void> {
        for (const channel of this.channels.values()) {
            channel.close();
        }
        this.channels.clear();
        const server = this.server;
        this.server = null;
        this.starting = null;
        if (server) {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    }

    private handle(request: IncomingMessage, response: ServerResponse): void {
        // A request addressed to any other host name is a rebinding attempt.
        if (request.headers.host !== `127.0.0.1:${this.port}`) {
            respond(response, 403);
            return;
        }
        if (request.method !== 'GET') {
            respond(response, 405);
            return;
        }

        const prefix = `/${this.token}/tile/`;
        const path = (request.url ?? '').split('?')[0];
        const channel =
            path.startsWith(prefix) && path.endsWith('.ts')
                ? this.channels.get(path.slice(prefix.length, -3))
                : undefined;
        if (!channel) {
            respond(response, 404);
            return;
        }

        response.writeHead(200, {
            'Content-Type': 'video/mp2t',
            'Cache-Control': 'no-store',
            // The packaged renderer runs from file://, whose origin is null.
            'Access-Control-Allow-Origin': '*',
            Connection: 'close',
        });
        channel.attach(response);
    }
}

function respond(response: ServerResponse, status: number): void {
    response.writeHead(status, { 'Cache-Control': 'no-store' });
    response.end();
}
