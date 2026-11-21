import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request, Server } from 'node:http';
import { connect, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    clientAddress,
    listenEndpoint,
    ListenEndpoint,
    parseListenSpec,
    parseProxyLine,
} from './relay-listen';
import { RelayConfigError } from './relay-config';

/** Sends raw bytes over the unix socket and collects the whole reply. */
function rawExchange(path: string, payload: string): Promise<string> {
    return new Promise((resolve) => {
        const socket = connect(path);
        let reply = '';
        socket.setEncoding('latin1');
        socket.on('data', (chunk) => (reply += chunk));
        socket.on('close', () => resolve(reply));
        socket.on('error', () => undefined);
        socket.write(payload);
    });
}

/** A process that binds the path and is killed, leaving the file. */
function leaveStaleSocket(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [
                '-e',
                `require('net').createServer().listen(${JSON.stringify(path)},()=>console.log('up'))`,
            ],
            { stdio: ['ignore', 'pipe', 'ignore'] }
        );
        child.stdout.once('data', () => child.kill('SIGKILL'));
        child.once('exit', () => resolve());
        child.once('error', reject);
    });
}

describe('parseListenSpec', () => {
    it('accepts TCP addresses and unix sockets', () => {
        expect(parseListenSpec('0.0.0.0:8790')).toEqual({
            kind: 'tcp',
            host: '0.0.0.0',
            port: 8790,
        });
        expect(parseListenSpec('[::1]:9000')).toEqual({
            kind: 'tcp',
            host: '::1',
            port: 9000,
        });
        expect(parseListenSpec('unix:/run/user/1000/relay.sock')).toEqual({
            kind: 'unix',
            path: '/run/user/1000/relay.sock',
        });
    });

    it('names the field, never the value', () => {
        for (const bad of [
            'secret-host',
            'secret:99999',
            'unix:relative-secret.sock',
            7,
        ]) {
            let error: unknown;
            try {
                parseListenSpec(bad, 'lan.listen');
            } catch (caught) {
                error = caught;
            }
            expect(error).toBeInstanceOf(RelayConfigError);
            expect((error as Error).message).toContain('config.lan.listen');
            expect((error as Error).message).not.toContain('secret');
        }
    });
});

describe('parseProxyLine', () => {
    it('reads TCP4, TCP6 and UNKNOWN', () => {
        expect(parseProxyLine('PROXY TCP4 192.0.2.5 192.0.2.1 5000 8790')).toBe(
            '192.0.2.5'
        );
        expect(parseProxyLine('PROXY TCP6 2001:db8::5 2001:db8::1 1 2')).toBe(
            '2001:db8::5'
        );
        expect(parseProxyLine('PROXY TCP6 ::ffff:192.0.2.9 ::1 1 2')).toBe(
            '192.0.2.9'
        );
        expect(parseProxyLine('PROXY UNKNOWN')).toBe('unknown');
    });

    it('rejects malformed lines', () => {
        expect(parseProxyLine('GET / HTTP/1.1')).toBeNull();
        expect(
            parseProxyLine('PROXY TCP4 2001:db8::5 192.0.2.1 1 2')
        ).toBeNull();
        expect(
            parseProxyLine('PROXY TCP4 192.0.2.5 192.0.2.1 1 70000')
        ).toBeNull();
    });
});

describe('listenEndpoint on a unix socket', () => {
    let dir: string;
    let server: Server;
    let endpoint: ListenEndpoint | undefined;
    const seen: string[] = [];

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'relay-listen-'));
        seen.length = 0;
        server = createServer((req, res) => {
            seen.push(clientAddress(req.socket));
            res.writeHead(200, { Connection: 'close' });
            res.end(`ok ${req.url}`);
        });
    });

    afterEach(async () => {
        await endpoint?.close();
        endpoint = undefined;
        rmSync(dir, { recursive: true, force: true });
    });

    it('serves HTTP after a PROXY header and records its source', async () => {
        const path = join(dir, 'nested', 'relay.sock');
        endpoint = await listenEndpoint(server, { kind: 'unix', path });
        expect(endpoint.port).toBeNull();
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700);

        const reply = await rawExchange(
            path,
            'PROXY TCP4 192.0.2.44 192.0.2.1 40000 8790\r\nGET /a HTTP/1.1\r\nHost: x\r\n\r\n'
        );
        expect(reply).toMatch(/^HTTP\/1\.1 200/);
        expect(reply).toContain('ok /a');
        expect(seen).toEqual(['192.0.2.44']);
    });

    it('accepts a header split across writes', async () => {
        const path = join(dir, 'relay.sock');
        endpoint = await listenEndpoint(server, { kind: 'unix', path });
        const reply = await new Promise<string>((resolve) => {
            const socket = connect(path);
            let text = '';
            socket.setEncoding('latin1');
            socket.on('data', (chunk) => (text += chunk));
            socket.on('close', () => resolve(text));
            socket.write('PROXY TCP4 192.0.2.7 ');
            setTimeout(
                () =>
                    socket.write(
                        '192.0.2.1 1 2\r\nGET /b HTTP/1.1\r\nHost: x\r\n\r\n'
                    ),
                30
            );
        });
        expect(reply).toContain('ok /b');
        expect(seen).toEqual(['192.0.2.7']);
    });

    it('drops connections without a valid header', async () => {
        const path = join(dir, 'relay.sock');
        endpoint = await listenEndpoint(server, { kind: 'unix', path });
        expect(
            await rawExchange(path, 'GET / HTTP/1.1\r\nHost: x\r\n\r\n')
        ).toBe('');
        expect(await rawExchange(path, 'X'.repeat(200))).toBe('');
        expect(seen).toEqual([]);
    });

    it('replaces a stale socket but refuses a live one or a regular file', async () => {
        const path = join(dir, 'relay.sock');
        const stale = createNetServer();
        await new Promise<void>((resolve) => stale.listen(path, resolve));
        // A live listener keeps the path busy.
        await expect(
            listenEndpoint(server, { kind: 'unix', path })
        ).rejects.toBeInstanceOf(RelayConfigError);
        await new Promise<void>((resolve) => stale.close(() => resolve()));
        // Leave the socket file behind, as a crashed process would.
        await leaveStaleSocket(path);
        expect(statSync(path).isSocket()).toBe(true);
        writeFileSync(join(dir, 'plain'), 'x');
        await expect(
            listenEndpoint(server, { kind: 'unix', path: join(dir, 'plain') })
        ).rejects.toBeInstanceOf(RelayConfigError);

        endpoint = await listenEndpoint(server, { kind: 'unix', path });
        expect(statSync(path).isSocket()).toBe(true);
        await endpoint.close();
        endpoint = undefined;
        expect(() => statSync(path)).toThrow();
    });

    it('listens on TCP and reports the bound port', async () => {
        endpoint = await listenEndpoint(server, {
            kind: 'tcp',
            host: '127.0.0.1',
            port: 0,
        });
        const port = endpoint.port ?? 0;
        expect(port).toBeGreaterThan(0);
        const body = await new Promise<string>((resolve, reject) => {
            request({ host: '127.0.0.1', port, path: '/c' }, (res) => {
                let text = '';
                res.on('data', (chunk) => (text += chunk));
                res.on('end', () => resolve(text));
            })
                .on('error', reject)
                .end();
        });
        expect(body).toBe('ok /c');
        expect(seen).toEqual(['127.0.0.1']);
    });
});
