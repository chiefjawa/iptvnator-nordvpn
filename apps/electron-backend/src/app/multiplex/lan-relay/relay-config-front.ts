/**
 * Configuration of the relay's Xtream-compatible front: local logins,
 * capacity, the VOD policy and the API/guide caches.
 *
 * Local logins are unrelated to the provider account; they only decide who
 * may use the relay. Like the rest of the config, errors name fields only.
 */

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export interface RelayClientLogin {
    readonly username: string;
    readonly password: string;
}

export type VodPolicy = 'refuse' | 'preempt';

export interface RelayCacheConfig {
    /** Catalogue actions (categories, streams, VOD and series info). */
    readonly catalogueTtlSec: number;
    /** `get_short_epg`, `get_simple_data_table`. */
    readonly shortTtlSec: number;
    /** The account/login answer (`player_api.php` without an action). */
    readonly loginTtlSec: number;
    readonly xmltvTtlSec: number;
    /** Disk budget of the cache directory; the oldest files go first. */
    readonly maxCacheMb: number;
}

export const DEFAULT_CACHE_CONFIG: RelayCacheConfig = {
    catalogueTtlSec: 6 * 3600,
    shortTtlSec: 60,
    loginTtlSec: 300,
    xmltvTtlSec: 12 * 3600,
    maxCacheMb: 1024,
};

export interface RelayFrontConfig {
    readonly clients: readonly RelayClientLogin[];
    readonly maxLiveChannels: number;
    readonly vodPolicy: VodPolicy;
    readonly cacheDir: string;
    readonly cache: RelayCacheConfig;
}

export const DEFAULT_MAX_LIVE_CHANNELS = 4;

type Fail = (message: string) => never;

export function parseFrontConfig(
    raw: Record<string, unknown>,
    provider: { username: string; password: string },
    fail: Fail,
    env: NodeJS.ProcessEnv = process.env
): RelayFrontConfig {
    return {
        clients: parseClients(raw['clients'], provider, fail),
        maxLiveChannels: parseInteger(
            raw['maxLiveChannels'],
            'maxLiveChannels',
            DEFAULT_MAX_LIVE_CHANNELS,
            1,
            16,
            fail
        ),
        vodPolicy: parseVodPolicy(raw['vodPolicy'], fail),
        cacheDir: parseCacheDir(raw['cacheDir'], fail, env),
        cache: parseCache(raw['cache'], fail),
    };
}

function parseClients(
    value: unknown,
    provider: { username: string; password: string },
    fail: Fail
): RelayClientLogin[] {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value) || value.length > 32) {
        fail('config.clients must be an array of at most 32 logins');
    }
    const seen = new Set<string>();
    return (value as unknown[]).map((entry, index) => {
        const record =
            typeof entry === 'object' && entry !== null && !Array.isArray(entry)
                ? (entry as Record<string, unknown>)
                : {};
        const username = record['username'];
        const password = record['password'];
        for (const [key, field] of [
            ['username', username],
            ['password', password],
        ] as const) {
            if (
                typeof field !== 'string' ||
                !/^[A-Za-z0-9._~-]{3,64}$/.test(field)
            ) {
                fail(
                    `config.clients[${index}].${key} must be 3-64 characters of A-Z a-z 0-9 . _ ~ -`
                );
            }
        }
        const user = username as string;
        const pass = password as string;
        if (seen.has(user)) {
            fail(`config.clients[${index}].username is used twice`);
        }
        seen.add(user);
        if (
            user === provider.username.trim() ||
            pass === provider.password.trim()
        ) {
            fail(
                `config.clients[${index}] must not reuse the provider username or password`
            );
        }
        return { username: user, password: pass };
    });
}

function parseVodPolicy(value: unknown, fail: Fail): VodPolicy {
    if (value === undefined) {
        return 'refuse';
    }
    if (value !== 'refuse' && value !== 'preempt') {
        fail('config.vodPolicy must be "refuse" or "preempt"');
    }
    return value as VodPolicy;
}

function parseCacheDir(
    value: unknown,
    fail: Fail,
    env: NodeJS.ProcessEnv
): string {
    if (value === undefined) {
        const base = env['XDG_CACHE_HOME']?.trim() || join(homedir(), '.cache');
        return join(base, 'iptv-relay');
    }
    if (typeof value !== 'string' || !isAbsolute(value.trim())) {
        fail('config.cacheDir must be an absolute path');
    }
    return (value as string).trim();
}

function parseCache(value: unknown, fail: Fail): RelayCacheConfig {
    if (value === undefined) {
        return DEFAULT_CACHE_CONFIG;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        fail('config.cache must be an object');
    }
    const result: Record<string, number> = { ...DEFAULT_CACHE_CONFIG };
    for (const [key, entry] of Object.entries(value as object)) {
        if (!(key in DEFAULT_CACHE_CONFIG)) {
            fail(`config.cache.${key} is not a known setting`);
        }
        if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0) {
            fail(`config.cache.${key} must be a non-negative number`);
        }
        result[key] = entry;
    }
    return result as unknown as RelayCacheConfig;
}

function parseInteger(
    value: unknown,
    field: string,
    fallback: number,
    min: number,
    max: number,
    fail: Fail
): number {
    if (value === undefined) {
        return fallback;
    }
    if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < min ||
        value > max
    ) {
        fail(`config.${field} must be an integer from ${min} to ${max}`);
    }
    return value as number;
}
