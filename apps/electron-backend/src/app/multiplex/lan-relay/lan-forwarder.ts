/**
 * Host-side forwarder: the LAN's way into the relay.
 *
 * The relay runs inside the VPN namespace, which the helper firewalls from
 * the host and the LAN, and listens on a unix socket instead of a port. This
 * small process runs on the host network, accepts TCP from allowed source
 * addresses only, and passes each connection to that socket, prefixed with
 * a PROXY v1 line naming the real client. It reads only the `lan` section
 * of the relay config: no provider account, token or client logins.
 */

import { readFileSync } from 'node:fs';
import {
    BlockList,
    connect,
    createServer,
    isIP,
    Server,
    Socket,
} from 'node:net';
import { RelayConfigError } from './relay-config';
import { parseListenSpec } from './relay-listen';

export interface ForwarderConfig {
    readonly host: string;
    readonly port: number;
    readonly allowFrom: readonly string[];
    readonly maxConnections: number;
}

export interface ForwarderStats {
    accepted: number;
    active: number;
    denied: number;
    overCapacity: number;
    upstreamFailures: number;
    bytesIn: number;
    bytesOut: number;
}

export interface ForwarderLogger {
    info(message: string): void;
    warn(message: string): void;
}

const DEFAULT_LISTEN = '0.0.0.0:8790';
const DEFAULT_ALLOW = ['127.0.0.0/8'];
const DEFAULT_MAX_CONNECTIONS = 64;
const DENY_LOG_EVERY_MS = 60_000;
const CONNECT_TIMEOUT_MS = 5000;

export function loadForwarderConfig(path: string): ForwarderConfig {
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        throw new RelayConfigError('config file could not be read as JSON');
    }
    return parseForwarderConfig(raw);
}

export function parseForwarderConfig(raw: unknown): ForwarderConfig {
    if (!isRecord(raw)) {
        throw new RelayConfigError('config must be a JSON object');
    }
    const lan = raw['lan'] ?? {};
    if (!isRecord(lan)) {
        throw new RelayConfigError('config.lan must be an object');
    }
    const listen = parseListenSpec(
        lan['listen'] ?? DEFAULT_LISTEN,
        'lan.listen'
    );
    if (listen.kind !== 'tcp') {
        throw new RelayConfigError('config.lan.listen must be a TCP address');
    }
    const allow = lan['allowFrom'] ?? DEFAULT_ALLOW;
    if (!Array.isArray(allow) || allow.length === 0) {
        throw new RelayConfigError(
            'config.lan.allowFrom must be a non-empty array of CIDRs'
        );
    }
    allow.forEach((entry, index) => {
        if (parseCidr(entry) === null) {
            throw new RelayConfigError(
                `config.lan.allowFrom[${index}] must be a CIDR such as 192.168.1.0/24`
            );
        }
    });
    const max = lan['maxConnections'] ?? DEFAULT_MAX_CONNECTIONS;
    if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 1) {
        throw new RelayConfigError(
            'config.lan.maxConnections must be a positive integer'
        );
    }
    return {
        host: listen.host,
        port: listen.port,
        allowFrom: allow as string[],
        maxConnections: max,
    };
}

export function parseCidr(
    value: unknown
): { address: string; prefix: number; family: 'ipv4' | 'ipv6' } | null {
    if (typeof value !== 'string') {
        return null;
    }
    const [address, bits, extra] = value.trim().split('/');
    const family = isIP(address ?? '');
    if (extra !== undefined || family === 0) {
        return null;
    }
    const max = family === 4 ? 32 : 128;
    const prefix = bits === undefined ? max : Number(bits);
    if (!/^\d{1,3}$/.test(bits ?? String(max)) || prefix > max) {
        return null;
    }
    return { address, prefix, family: family === 4 ? 'ipv4' : 'ipv6' };
}

export function createAllowList(
    cidrs: readonly string[]
): (ip: string) => boolean {
    const list = new BlockList();
    for (const cidr of cidrs) {
        const parsed = parseCidr(cidr);
        if (parsed) {
            list.addSubnet(parsed.address, parsed.prefix, parsed.family);
        }
    }
    return (ip) => {
        const plain = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
        const family = isIP(plain);
        return (
            family !== 0 && list.check(plain, family === 4 ? 'ipv4' : 'ipv6')
        );
    };
}

export function proxyHeader(client: Socket): string {
    const source = plainAddress(client.remoteAddress);
    const target = plainAddress(client.localAddress);
    const family = isIP(source);
    if (family === 0 || isIP(target) !== family) {
        return 'PROXY UNKNOWN\r\n';
    }
    return `PROXY TCP${family} ${source} ${target} ${client.remotePort ?? 0} ${client.localPort ?? 0}\r\n`;
}

export interface LanForwarder {
    readonly server: Server;
    readonly stats: ForwarderStats;
    close(): Promise<void>;
}

export function createLanForwarder(
    config: ForwarderConfig,
    socketPath: string,
    log?: ForwarderLogger
): LanForwarder {
    const allowed = createAllowList(config.allowFrom);
    const stats: ForwarderStats = {
        accepted: 0,
        active: 0,
        denied: 0,
        overCapacity: 0,
        upstreamFailures: 0,
        bytesIn: 0,
        bytesOut: 0,
    };
    const open = new Set<Socket>();
    const lastDenyLog = new Map<string, number>();

    const server = createServer(
        { pauseOnConnect: true, allowHalfOpen: true },
        (client) => {
            const source = plainAddress(client.remoteAddress);
            if (!allowed(source)) {
                stats.denied += 1;
                const now = Date.now();
                if (now - (lastDenyLog.get(source) ?? 0) >= DENY_LOG_EVERY_MS) {
                    if (lastDenyLog.size > 1000) {
                        lastDenyLog.clear();
                    }
                    lastDenyLog.set(source, now);
                    log?.warn(
                        `denied ${source || 'unknown'} (not in lan.allowFrom)`
                    );
                }
                client.destroy();
                return;
            }
            if (open.size >= config.maxConnections) {
                stats.overCapacity += 1;
                client.destroy();
                return;
            }
            stats.accepted += 1;
            open.add(client);
            stats.active = open.size;
            pipe(
                client,
                socketPath,
                stats,
                () => {
                    open.delete(client);
                    stats.active = open.size;
                },
                log
            );
        }
    );
    server.on('error', (error) =>
        log?.warn(
            `listener error: ${(error as NodeJS.ErrnoException).code ?? 'Error'}`
        )
    );

    return {
        server,
        stats,
        close: async () => {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            for (const socket of open) {
                socket.destroy();
            }
        },
    };
}

function pipe(
    client: Socket,
    socketPath: string,
    stats: ForwarderStats,
    done: () => void,
    log?: ForwarderLogger
): void {
    const relay = connect({ path: socketPath, allowHalfOpen: true });
    let finished = false;
    const finish = () => {
        if (finished) {
            return;
        }
        finished = true;
        client.destroy();
        relay.destroy();
        done();
    };
    const timer = setTimeout(() => {
        stats.upstreamFailures += 1;
        finish();
    }, CONNECT_TIMEOUT_MS);
    client.setNoDelay(true);
    client.setKeepAlive(true, 30_000);
    relay.once('connect', () => {
        clearTimeout(timer);
        relay.write(proxyHeader(client));
        client.on('data', (chunk: Buffer) => (stats.bytesIn += chunk.length));
        relay.on('data', (chunk: Buffer) => (stats.bytesOut += chunk.length));
        // pipe() applies backpressure and forwards a half-close (end).
        client.pipe(relay);
        relay.pipe(client);
        client.resume();
    });
    relay.once('error', (error) => {
        if (!relay.connecting && relay.bytesWritten > 0) {
            finish();
            return;
        }
        clearTimeout(timer);
        stats.upstreamFailures += 1;
        log?.warn(
            `relay socket unavailable (${(error as NodeJS.ErrnoException).code ?? 'Error'})`
        );
        finish();
    });
    client.once('error', finish);
    // Both directions ended or either side closed: tear down the pair.
    client.once('close', finish);
    relay.once('close', finish);
}

export function formatForwarderStats(stats: ForwarderStats): string {
    return (
        `active=${stats.active} accepted=${stats.accepted} denied=${stats.denied}` +
        ` full=${stats.overCapacity} relayDown=${stats.upstreamFailures}` +
        ` in=${(stats.bytesIn / 1048576).toFixed(1)}MB out=${(stats.bytesOut / 1048576).toFixed(1)}MB`
    );
}

function plainAddress(address: string | undefined): string {
    if (!address) {
        return '';
    }
    return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
