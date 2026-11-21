/**
 * An end-to-end rig for the relay's Xtream front: the fake live provider
 * (accelerated clock) for live channels, the fake panel on a real socket
 * for the API, guide and VOD, and the relay's HTTP server on 127.0.0.1.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { request, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeProvider, FakeProvider } from '../testing/fake-provider';
import {
    FakePanel,
    PANEL_ACCOUNT,
    PANEL_HOST,
    startFakePanel,
} from '../testing/fake-panel';
import { closeRelayServer, createRelayHttpServer } from './lan-relay-http';
import { StreamChecker, testConfig } from './lan-relay.test-helpers';
import { RelayApp } from './relay-app';
import { RelayTuning } from './relay-config';
import { RelayLogger } from './relay-log';

export interface FrontRig {
    readonly provider: FakeProvider;
    readonly panel: FakePanel;
    readonly app: RelayApp;
    readonly server: Server;
    readonly port: number;
    readonly lines: string[];
    readonly cacheDir: string;
    /** Wall-clock offset added to cache ages. */
    clockOffsetMs: number;
    close(): Promise<void>;
}

export interface Fetched {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
}

export async function startFrontRig(
    options: {
        vodPolicy?: 'refuse' | 'preempt';
        maxLiveChannels?: number;
        tuning?: Partial<RelayTuning>;
        cache?: Record<string, number>;
        speed?: number;
    } = {}
): Promise<FrontRig> {
    const provider = createFakeProvider({
        speed: options.speed ?? 4,
        depthSec: 8,
        burstSpeed: 12,
        connectMs: 200,
        gopFrames: 25,
    });
    const panel = await startFakePanel(() => provider.stats().openNow);
    const cacheDir = mkdtempSync(join(tmpdir(), 'relay-front-'));
    const config = testConfig(
        [],
        { statusLogSec: 0, ...options.tuning },
        {
            serverUrl: panel.url,
            username: PANEL_ACCOUNT.username,
            password: PANEL_ACCOUNT.password,
            cacheDir,
            vodPolicy: options.vodPolicy ?? 'refuse',
            maxLiveChannels: options.maxLiveChannels ?? 4,
            ...(options.cache ? { cache: options.cache } : {}),
        }
    );
    const lines: string[] = [];
    const log: RelayLogger = {
        info: (message) => lines.push(message),
        warn: (message) => lines.push(message),
    };
    const rig = {
        provider,
        panel,
        lines,
        cacheDir,
        clockOffsetMs: 0,
    } as Partial<FrontRig> & { clockOffsetMs: number };
    const app = new RelayApp({
        config,
        open: provider.open,
        clock: provider.clock,
        log,
        vodLingerMs: 400,
        now: () => Date.now() + rig.clockOffsetMs,
    });
    const server = createRelayHttpServer(app);
    await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve())
    );
    await app.start();
    return Object.assign(rig, {
        app,
        server,
        port: (server.address() as AddressInfo).port,
        close: async () => {
            await app.stop();
            await closeRelayServer(server);
            await panel.close();
            rmSync(cacheDir, { recursive: true, force: true });
        },
    }) as FrontRig;
}

export function fetchRelay(
    port: number,
    path: string,
    init: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
    } = {}
): Promise<Fetched> {
    return new Promise((resolve, reject) => {
        const req = request(
            {
                host: '127.0.0.1',
                port,
                path,
                method: init.method ?? 'GET',
                headers: init.headers,
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () =>
                    resolve({
                        status: res.statusCode ?? 0,
                        headers: res.headers,
                        body: Buffer.concat(chunks),
                    })
                );
                res.on('error', reject);
            }
        );
        req.on('error', reject);
        req.end(init.body);
    });
}

/** Opens a live URL and reads it for `ms` of real time. */
export function readLive(
    port: number,
    path: string,
    ms: number
): Promise<{ status: number; checker: StreamChecker; bytes: number }> {
    return new Promise((resolve, reject) => {
        const checker = new StreamChecker();
        let pending = Buffer.alloc(0);
        let bytes = 0;
        const req = request({ host: '127.0.0.1', port, path }, (res) => {
            res.on('data', (chunk: Buffer) => {
                bytes += chunk.length;
                pending = Buffer.concat([pending, chunk]);
                const whole = pending.length - (pending.length % 188);
                checker.push(pending.subarray(0, whole));
                pending = pending.subarray(whole);
            });
            res.on('end', () =>
                resolve({ status: res.statusCode ?? 0, checker, bytes })
            );
            setTimeout(() => {
                req.destroy();
                resolve({ status: res.statusCode ?? 0, checker, bytes });
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

/** Every value that would reveal the provider or its account. */
export const LEAK_PATTERNS = [
    PANEL_HOST,
    PANEL_ACCOUNT.username,
    PANEL_ACCOUNT.password,
    encodeURIComponent(PANEL_ACCOUNT.password),
];

/** Fails when a body or any header carries a provider value. */
export function expectNoLeak(response: Fetched, what: string): void {
    const texts = [
        response.body.toString('latin1'),
        JSON.stringify(response.headers),
    ];
    for (const text of texts) {
        for (const pattern of LEAK_PATTERNS) {
            if (text.includes(pattern)) {
                throw new Error(`${what} leaked a provider value`);
            }
        }
    }
}

export const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
