import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, Server } from 'node:http';
import { AddressInfo, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    createAllowList,
    createLanForwarder,
    LanForwarder,
    loadForwarderConfig,
    parseForwarderConfig,
} from './lan-forwarder';
import { RelayConfigError } from './relay-config';
import { clientAddress, listenEndpoint, ListenEndpoint } from './relay-listen';

function get(
    port: number,
    path: string
): Promise<{ status: number; body: string } | 'closed'> {
    return new Promise((resolve) => {
        const req = request(
            { host: '127.0.0.1', port, path, agent: false },
            (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => (body += chunk));
                res.on('end', () =>
                    resolve({ status: res.statusCode ?? 0, body })
                );
            }
        );
        req.on('error', () => resolve('closed'));
        req.end();
    });
}

function errorOf(fn: () => unknown): Error {
    try {
        fn();
    } catch (error) {
        return error as Error;
    }
    throw new Error('expected a throw');
}

describe('forwarder config', () => {
    it('reads only the lan section, with defaults', () => {
        expect(parseForwarderConfig({ serverUrl: 'x', username: 'u' })).toEqual(
            {
                host: '0.0.0.0',
                port: 8790,
                allowFrom: ['127.0.0.0/8'],
                maxConnections: 64,
            }
        );
        expect(
            parseForwarderConfig({
                lan: {
                    listen: '0.0.0.0:18791',
                    allowFrom: ['192.168.1.0/24', '::1/128'],
                    maxConnections: 8,
                },
            })
        ).toMatchObject({ port: 18791, maxConnections: 8 });
    });

    it('names fields, never values', () => {
        const cases: unknown[] = [
            { lan: { allowFrom: ['secret-subnet'] } },
            { lan: { allowFrom: ['10.0.0.0/99'] } },
            { lan: { allowFrom: [] } },
            { lan: { listen: 'unix:/tmp/secret.sock' } },
            { lan: { maxConnections: 0 } },
            { lan: 'secret' },
        ];
        for (const raw of cases) {
            const error = errorOf(() => parseForwarderConfig(raw));
            expect(error).toBeInstanceOf(RelayConfigError);
            expect(error.message).toMatch(/config\.lan/);
            expect(error.message).not.toMatch(/secret|99/);
        }
        const dir = mkdtempSync(join(tmpdir(), 'fwd-config-'));
        writeFileSync(join(dir, 'bad.json'), '{"password":"secret"');
        const error = errorOf(() => loadForwarderConfig(join(dir, 'bad.json')));
        expect(error.message).not.toContain('secret');
        rmSync(dir, { recursive: true, force: true });
    });

    it('matches IPv4, mapped IPv4 and IPv6 sources', () => {
        const allowed = createAllowList(['192.168.1.0/24', '2001:db8::/32']);
        expect(allowed('192.168.1.40')).toBe(true);
        expect(allowed('::ffff:192.168.1.40')).toBe(true);
        expect(allowed('192.168.2.40')).toBe(false);
        expect(allowed('2001:db8::7')).toBe(true);
        expect(allowed('2001:db9::7')).toBe(false);
        expect(allowed('')).toBe(false);
    });
});

describe('LanForwarder', () => {
    let dir: string;
    let relay: Server;
    let endpoint: ListenEndpoint | undefined;
    let forwarder: LanForwarder | undefined;
    const sources: string[] = [];

    async function start(allowFrom: string[], maxConnections = 64) {
        forwarder = createLanForwarder(
            { host: '127.0.0.1', port: 0, allowFrom, maxConnections },
            join(dir, 'relay.sock')
        );
        await new Promise<void>((resolve) =>
            forwarder?.server.listen(0, '127.0.0.1', resolve)
        );
        return (forwarder.server.address() as AddressInfo).port;
    }

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'fwd-'));
        sources.length = 0;
        relay = createServer((req, res) => {
            sources.push(clientAddress(req.socket));
            if (req.url === '/stream') {
                res.writeHead(200);
                res.write('a');
                setTimeout(() => res.end('b'), 50);
                return;
            }
            res.end(`hello ${req.url}`);
        });
        endpoint = await listenEndpoint(relay, {
            kind: 'unix',
            path: join(dir, 'relay.sock'),
        });
    });

    afterEach(async () => {
        await forwarder?.close();
        await endpoint?.close();
        forwarder = undefined;
        endpoint = undefined;
        rmSync(dir, { recursive: true, force: true });
    });

    it('carries HTTP to the unix socket with the real client address', async () => {
        const port = await start(['127.0.0.0/8']);
        expect(await get(port, '/x')).toEqual({
            status: 200,
            body: 'hello /x',
        });
        expect(await get(port, '/stream')).toEqual({ status: 200, body: 'ab' });
        expect(sources).toEqual(['127.0.0.1', '127.0.0.1']);
        expect(forwarder?.stats).toMatchObject({ accepted: 2, denied: 0 });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(forwarder?.stats.active).toBe(0);
    });

    it('drops sources outside the allowlist', async () => {
        const port = await start(['192.0.2.0/24']);
        expect(await get(port, '/x')).toBe('closed');
        expect(sources).toEqual([]);
        expect(forwarder?.stats.denied).toBe(1);
    });

    it('closes the client when the relay socket is down', async () => {
        await endpoint?.close();
        endpoint = undefined;
        const port = await start(['127.0.0.0/8']);
        expect(await get(port, '/x')).toBe('closed');
        expect(forwarder?.stats.upstreamFailures).toBe(1);
    });

    it('refuses connections beyond its cap', async () => {
        const port = await start(['127.0.0.0/8'], 1);
        const held = connect(port, '127.0.0.1');
        await new Promise((resolve) => held.once('connect', resolve));
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(await get(port, '/x')).toBe('closed');
        expect(forwarder?.stats.overCapacity).toBe(1);
        held.destroy();
    });
});
