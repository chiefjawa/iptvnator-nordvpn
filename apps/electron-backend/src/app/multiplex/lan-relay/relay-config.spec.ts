import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    buildLiveUrl,
    CONFIG_ENV,
    DEFAULT_RELAY_TUNING,
    loadRelayConfig,
    parseRelayConfig,
    resolveConfigPath,
} from './relay-config';

const VALID = {
    serverUrl: 'http://provider.example.test:8080/',
    username: 'user name',
    password: 'p@ss/word',
    listen: '0.0.0.0:8790',
    token: 'abcdefghijklmnop0123456789',
    channels: [
        { streamId: 101, name: 'Synthetic A' },
        { streamId: 202, name: 'Synthetic B' },
    ],
};

describe('relay config', () => {
    it('parses a valid file with defaults', () => {
        const config = parseRelayConfig(VALID);
        expect(config.listen).toEqual({
            kind: 'tcp',
            host: '0.0.0.0',
            port: 8790,
        });
        expect(config).toMatchObject({
            clients: [],
            maxLiveChannels: 4,
            vodPolicy: 'refuse',
        });
        expect(config.channels.map((c) => c.streamId)).toEqual([101, 202]);
        expect(config.tuning).toEqual(DEFAULT_RELAY_TUNING);
        expect(config.userAgent).toBeUndefined();
    });

    it('builds the Xtream live MPEG-TS URL like the desktop app', () => {
        const config = parseRelayConfig(VALID);
        expect(buildLiveUrl(config, 101)).toBe(
            'http://provider.example.test:8080/live/user%20name/p%40ss%2Fword/101.ts'
        );
    });

    it('accepts pacing and scheduler overrides', () => {
        const config = parseRelayConfig({
            ...VALID,
            pacing: { fastStartSec: 4, overdrive: 1.05 },
            scheduler: { minGapMs: 500 },
        });
        expect(config.tuning.fastStartSec).toBe(4);
        expect(config.tuning.overdrive).toBe(1.05);
        expect(config.scheduler).toEqual({ minGapMs: 500 });
    });

    it.each([
        [{ ...VALID, serverUrl: 'ftp://provider.example.test' }, 'serverUrl'],
        [{ ...VALID, password: '' }, 'password'],
        [{ ...VALID, token: 'short' }, 'token'],
        [{ ...VALID, listen: 'nope' }, 'listen'],
        [{ ...VALID, channels: {} }, 'channels'],
        [{ ...VALID, clients: [{ username: 'ab' }] }, 'clients[0].username'],
        [
            {
                ...VALID,
                username: 'provuser1',
                clients: [{ username: 'provuser1', password: 'local-pass' }],
            },
            'clients[0]',
        ],
        [{ ...VALID, vodPolicy: 'sometimes' }, 'vodPolicy'],
        [{ ...VALID, maxLiveChannels: 0 }, 'maxLiveChannels'],
        [{ ...VALID, cacheDir: 'relative/dir' }, 'cacheDir'],
        [{ ...VALID, cache: { xmltvTtlSec: -1 } }, 'cache.xmltvTtlSec'],
        [
            { ...VALID, channels: [{ streamId: 1 }, { streamId: 1 }] },
            'streamId',
        ],
        [{ ...VALID, pacing: { unknown: 1 } }, 'pacing.unknown'],
    ])('rejects a bad field without echoing values (%#)', (raw, field) => {
        let message = '';
        try {
            parseRelayConfig(raw);
        } catch (error) {
            message = (error as Error).message;
        }
        expect(message).toContain(field);
        expect(message).not.toMatch(
            /provider\.example|user name|p@ss|abcdefghijklmnop/
        );
    });

    it('finds the config path from the flag or the environment', () => {
        expect(resolveConfigPath(['--config', 'a.json'], {})).toBe('a.json');
        expect(resolveConfigPath(['--config=b.json'], {})).toBe('b.json');
        expect(resolveConfigPath([], { [CONFIG_ENV]: 'c.json' })).toBe(
            'c.json'
        );
        expect(resolveConfigPath([], {})).toBeNull();
    });

    it('loads a file and reports unreadable or invalid files generically', () => {
        const dir = mkdtempSync(join(tmpdir(), 'relay-config-'));
        try {
            const good = join(dir, 'good.json');
            writeFileSync(good, JSON.stringify(VALID));
            expect(loadRelayConfig(good).channels).toHaveLength(2);

            const bad = join(dir, 'bad.json');
            writeFileSync(bad, '{"password": "p@ss/word",');
            expect(() => loadRelayConfig(bad)).toThrow(
                'config file is not valid JSON'
            );
            expect(() => loadRelayConfig(join(dir, 'missing.json'))).toThrow(
                'config file could not be read'
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
