/**
 * Where the relay listens: a TCP address, or a unix socket reached through
 * the host-side forwarder (`lan-forwarder.ts`).
 *
 * The relay runs inside a VPN network namespace whose firewall blocks the
 * host and the LAN. A unix socket on the shared filesystem crosses that
 * boundary without opening the namespace. The forwarder prefixes every
 * connection with a PROXY protocol v1 line, so the relay still knows which
 * LAN address a request came from (for logs, status and zap detection).
 */

import { lstatSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { Server } from 'node:http';
import { connect, createServer, isIP, Socket } from 'node:net';
import { dirname, isAbsolute } from 'node:path';
import { RelayConfigError } from './relay-config';

export type ListenSpec =
    | { kind: 'tcp'; host: string; port: number }
    | { kind: 'unix'; path: string };

export interface ListenEndpoint {
    /** `host` for TCP, the socket path for unix. */
    readonly address: string;
    readonly port: number | null;
    close(): Promise<void>;
}

/** Longest valid PROXY v1 line, CRLF included. */
export const PROXY_V1_MAX = 107;
const PROXY_DEADLINE_MS = 5000;
const UNIX_PREFIX = 'unix:';
const PROXY_LINE =
    /^PROXY (?:UNKNOWN[^\r\n]*|(TCP4|TCP6) (\S+) (\S+) (\d{1,5}) (\d{1,5}))$/;

const proxySources = new WeakMap<Socket, string>();

export function parseListenSpec(value: unknown, field = 'listen'): ListenSpec {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text.startsWith(UNIX_PREFIX)) {
        const path = text.slice(UNIX_PREFIX.length);
        // Linux limits sun_path to 108 bytes including the terminator.
        if (!isAbsolute(path) || Buffer.byteLength(path) > 100) {
            throw new RelayConfigError(
                `config.${field} unix socket must be an absolute path under 100 bytes`
            );
        }
        return { kind: 'unix', path };
    }
    const match = /^\[?([^\]]*?)\]?:(\d{1,5})$/.exec(text);
    const port = match ? Number(match[2]) : NaN;
    if (!match || !match[1] || !(port >= 1 && port <= 65535)) {
        throw new RelayConfigError(
            `config.${field} must look like 0.0.0.0:8790 or unix:/path/relay.sock`
        );
    }
    return { kind: 'tcp', host: match[1], port };
}

/** The peer address: the PROXY source for unix connections. */
export function clientAddress(socket: Socket): string {
    const proxied = proxySources.get(socket);
    if (proxied) {
        return proxied;
    }
    const remote = socket.remoteAddress;
    if (!remote) {
        return 'unknown';
    }
    return remote.startsWith('::ffff:') ? remote.slice(7) : remote;
}

export function listenEndpoint(
    server: Server,
    spec: ListenSpec
): Promise<ListenEndpoint> {
    return spec.kind === 'tcp'
        ? listenTcp(server, spec.host, spec.port)
        : listenUnix(server, spec.path);
}

function listenTcp(
    server: Server,
    host: string,
    port: number
): Promise<ListenEndpoint> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            server.off('error', reject);
            const info = server.address();
            const bound =
                typeof info === 'object' && info !== null ? info.port : port;
            resolve({
                address: host,
                port: bound,
                close: () => closeServer(server),
            });
        });
    });
}

async function listenUnix(
    server: Server,
    path: string
): Promise<ListenEndpoint> {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    await removeStaleSocket(path);
    const listener = createServer(
        { pauseOnConnect: true, allowHalfOpen: true },
        (socket) => acceptProxied(server, socket)
    );
    await new Promise<void>((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(path, () => {
            listener.off('error', reject);
            resolve();
        });
    });
    chmodSync(path, 0o600);
    return {
        address: path,
        port: null,
        close: async () => {
            await new Promise<void>((resolve) =>
                listener.close(() => resolve())
            );
            await closeServer(server);
            try {
                unlinkSync(path);
            } catch {
                // Already gone.
            }
        },
    };
}

/** Reads and strips the PROXY header, then hands the socket to HTTP. */
function acceptProxied(server: Server, socket: Socket): void {
    let pending = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), PROXY_DEADLINE_MS);
    const fail = () => {
        clearTimeout(timer);
        socket.destroy();
    };
    const onData = (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        const end = pending.indexOf('\r\n');
        if (end < 0) {
            if (pending.length >= PROXY_V1_MAX) {
                fail();
            }
            return;
        }
        if (end + 2 > PROXY_V1_MAX) {
            fail();
            return;
        }
        const source = parseProxyLine(
            pending.subarray(0, end).toString('latin1')
        );
        if (source === null) {
            fail();
            return;
        }
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', fail);
        socket.pause();
        proxySources.set(socket, source);
        const rest = pending.subarray(end + 2);
        if (rest.length > 0) {
            socket.unshift(rest);
        }
        server.emit('connection', socket);
        socket.resume();
    };
    socket.on('error', fail);
    socket.on('data', onData);
    socket.resume();
}

/** The source address of a PROXY v1 line, `unknown`, or null if invalid. */
export function parseProxyLine(line: string): string | null {
    const match = PROXY_LINE.exec(line);
    if (!match) {
        return null;
    }
    if (!match[1]) {
        return 'unknown';
    }
    const family = match[1] === 'TCP4' ? 4 : 6;
    const [source, target] = [match[2], match[3]];
    const ports = [Number(match[4]), Number(match[5])];
    if (
        isIP(source) !== family ||
        isIP(target) !== family ||
        ports.some((port) => port > 65535)
    ) {
        return null;
    }
    return source.startsWith('::ffff:') ? source.slice(7) : source;
}

/** Removes a leftover socket file nobody answers on; refuses anything else. */
async function removeStaleSocket(path: string): Promise<void> {
    let isSocket: boolean;
    try {
        isSocket = lstatSync(path).isSocket();
    } catch {
        return;
    }
    if (!isSocket) {
        throw new RelayConfigError(
            'config.listen unix socket path exists and is not a socket'
        );
    }
    const alive = await new Promise<boolean>((resolve) => {
        const probe = connect(path);
        probe.once('connect', () => {
            probe.destroy();
            resolve(true);
        });
        probe.once('error', () => resolve(false));
    });
    if (alive) {
        throw new RelayConfigError(
            'config.listen unix socket is already in use by another process'
        );
    }
    unlinkSync(path);
}

function closeServer(server: Server): Promise<void> {
    server.closeAllConnections();
    return new Promise((resolve) => {
        if (!server.listening) {
            resolve();
            return;
        }
        server.close(() => resolve());
    });
}
