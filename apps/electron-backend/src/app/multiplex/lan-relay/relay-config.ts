/**
 * Configuration of the standalone LAN relay.
 *
 * The file holds the provider account, so nothing read from it may reach a
 * log line, an error message or the status page except stream ids and
 * channel names. Validation errors name the field, never its value.
 */

import { readFileSync } from 'node:fs';
import {
    normalizeXtreamServerUrl,
    StreamFormat,
} from '@iptvnator/shared/interfaces';
import { SchedulerConfig } from '../scheduler/scheduler-types';
import { parseFrontConfig, RelayFrontConfig } from './relay-config-front';
import { ListenSpec, parseListenSpec } from './relay-listen';

export const CONFIG_ENV = 'MULTIPLEX_RELAY_CONFIG';

export interface RelayChannelConfig {
    readonly streamId: number;
    readonly name: string;
}

/** Output pacing, reserve and memory limits; all have defaults. */
export interface RelayTuning {
    /** Media sent at once when a client starts, so the player starts fast. */
    readonly fastStartSec: number;
    /** Send rate (media per wall time) while the client cushion is low. */
    readonly overdrive: number;
    /** Estimated client-side buffer at which sending drops to real time. */
    readonly targetCushionSec: number;
    /** A client joining a running channel starts this far before its end. */
    readonly joinBacklogSec: number;
    /** Null packets are sent after this long without any write. */
    readonly keepAliveIntervalMs: number;
    readonly keepAlivePackets: number;
    /** Output pump period. */
    readonly tickMs: number;
    /** A channel without clients is kept this long, then dropped. */
    readonly graceSec: number;
    readonly maxQueueSec: number;
    readonly maxQueueMb: number;
    readonly maxTotalQueueMb: number;
    /** How often each channel's reserve is fed to the scheduler. */
    readonly reportIntervalMs: number;
    readonly statusLogSec: number;
    /**
     * Grace of a channel whose client switched to another channel from the
     * same address within `zapWindowSec` (a zap), instead of `graceSec`.
     */
    readonly zapGraceSec: number;
    readonly zapWindowSec: number;
    /** Clients of a channel that got no media this long are ended cleanly. */
    readonly endAfterStarveSec: number;
    /** An upstream connection that delivers nothing this long is dropped. */
    readonly upstreamStallSec: number;
}

export const DEFAULT_RELAY_TUNING: RelayTuning = {
    fastStartSec: 3,
    overdrive: 1.02,
    targetCushionSec: 6,
    joinBacklogSec: 3,
    keepAliveIntervalMs: 300,
    keepAlivePackets: 4,
    tickMs: 50,
    graceSec: 8,
    maxQueueSec: 120,
    maxQueueMb: 64,
    maxTotalQueueMb: 256,
    reportIntervalMs: 500,
    statusLogSec: 10,
    zapGraceSec: 1,
    zapWindowSec: 2,
    endAfterStarveSec: 60,
    upstreamStallSec: 20,
};

export interface RelayConfig extends RelayFrontConfig {
    readonly serverUrl: string;
    readonly username: string;
    readonly password: string;
    readonly listen: ListenSpec;
    readonly token: string;
    /** Optional names for stream ids, and the token playlist's entries. */
    readonly channels: readonly RelayChannelConfig[];
    readonly userAgent?: string;
    readonly tuning: RelayTuning;
    readonly scheduler: Partial<SchedulerConfig>;
}

export class RelayConfigError extends Error {}

/** `--config <path>`, `--config=<path>`, or the environment variable. */
export function resolveConfigPath(
    argv: readonly string[],
    env: NodeJS.ProcessEnv
): string | null {
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--config') {
            return argv[index + 1] ?? null;
        }
        if (arg.startsWith('--config=')) {
            return arg.slice('--config='.length) || null;
        }
    }
    return env[CONFIG_ENV]?.trim() || null;
}

export function loadRelayConfig(path: string): RelayConfig {
    let text: string;
    try {
        text = readFileSync(path, 'utf8');
    } catch {
        throw new RelayConfigError('config file could not be read');
    }
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        throw new RelayConfigError('config file is not valid JSON');
    }
    return parseRelayConfig(raw);
}

export function parseRelayConfig(raw: unknown): RelayConfig {
    if (!isRecord(raw)) {
        throw new RelayConfigError('config must be a JSON object');
    }
    const serverUrl = requireString(raw, 'serverUrl');
    try {
        normalizeXtreamServerUrl(serverUrl);
    } catch {
        throw new RelayConfigError('config.serverUrl is not a usable URL');
    }
    const token = requireString(raw, 'token');
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
        throw new RelayConfigError(
            'config.token must be 16-128 characters of A-Z a-z 0-9 _ -'
        );
    }
    const rawUserAgent = raw['userAgent'];
    if (rawUserAgent !== undefined && typeof rawUserAgent !== 'string') {
        throw new RelayConfigError('config.userAgent must be a string');
    }
    const userAgent = typeof rawUserAgent === 'string' ? rawUserAgent : '';
    const username = requireString(raw, 'username');
    const password = requireString(raw, 'password');
    return {
        serverUrl,
        username,
        password,
        listen: parseListenSpec(raw['listen'] ?? '0.0.0.0:8790'),
        ...parseFrontConfig(raw, { username, password }, (message) => {
            throw new RelayConfigError(message);
        }),
        token,
        channels: parseChannels(raw['channels']),
        userAgent: userAgent.trim() || undefined,
        tuning: parseTuning(raw['pacing']),
        scheduler: parseScheduler(raw['scheduler']),
    };
}

/** The Xtream live MPEG-TS URL, built like `XtreamUrlService.constructLiveUrl`. */
export function buildLiveUrl(config: RelayConfig, streamId: number): string {
    return buildProviderUrl(config, 'live', [
        `${streamId}.${StreamFormat.TsStreamFormat}`,
    ]);
}

/**
 * `<server>/<kind>/<user>/<pass>/<rest...>` with the real account; `rest`
 * segments are already validated path segments and are encoded here.
 */
export function buildProviderUrl(
    config: RelayConfig,
    kind: string,
    rest: readonly string[]
): string {
    const base = normalizeXtreamServerUrl(config.serverUrl);
    const user = encodeURIComponent(config.username.trim());
    const pass = encodeURIComponent(config.password.trim());
    const tail = rest.map((part) => encodeURIComponent(part)).join('/');
    return `${base}/${kind}/${user}/${pass}/${tail}`;
}

/** `<server>/<file>` with the real account in the query, plus `params`. */
export function buildProviderQueryUrl(
    config: RelayConfig,
    file: string,
    params: Readonly<Record<string, string>> = {}
): string {
    const base = normalizeXtreamServerUrl(config.serverUrl);
    const query = new URLSearchParams({
        username: config.username.trim(),
        password: config.password.trim(),
        ...params,
    });
    return `${base}/${file}?${query.toString()}`;
}

/** Values that must never appear in output, for the log scrubber. */
export function secretsOf(config: RelayConfig): string[] {
    const values = [
        config.username,
        config.password,
        config.token,
        ...config.clients.map((client) => client.password),
    ];
    try {
        const url = new URL(normalizeXtreamServerUrl(config.serverUrl));
        values.push(url.host, url.hostname, url.origin);
    } catch {
        values.push(config.serverUrl);
    }
    values.push(encodeURIComponent(config.username));
    values.push(encodeURIComponent(config.password));
    return [
        ...new Set(values.map((v) => v.trim()).filter((v) => v.length >= 3)),
    ];
}

function parseChannels(value: unknown): RelayChannelConfig[] {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw new RelayConfigError('config.channels must be an array');
    }
    const seen = new Set<number>();
    return value.map((entry, index) => {
        const streamId = isRecord(entry) ? entry['streamId'] : undefined;
        const name = isRecord(entry) ? entry['name'] : undefined;
        if (
            typeof streamId !== 'number' ||
            !Number.isSafeInteger(streamId) ||
            streamId <= 0 ||
            seen.has(streamId)
        ) {
            throw new RelayConfigError(
                `config.channels[${index}].streamId must be a unique positive integer`
            );
        }
        seen.add(streamId);
        const clean =
            typeof name === 'string'
                ? // eslint-disable-next-line no-control-regex
                  name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
                : '';
        return { streamId, name: clean || `Channel ${streamId}` };
    });
}

function parseTuning(value: unknown): RelayTuning {
    const overrides = parseNumbers(value, 'pacing', DEFAULT_RELAY_TUNING);
    const tuning = { ...DEFAULT_RELAY_TUNING, ...overrides };
    if (tuning.overdrive < 1 || tuning.overdrive > 2) {
        throw new RelayConfigError('config.pacing.overdrive must be 1-2');
    }
    return tuning;
}

function parseScheduler(value: unknown): Partial<SchedulerConfig> {
    return parseNumbers(value, 'scheduler', null);
}

/** Numeric overrides; with `known`, only its keys are accepted. */
function parseNumbers<T extends object>(
    value: unknown,
    field: string,
    known: T | null
): Partial<T> {
    if (value === undefined) {
        return {};
    }
    if (!isRecord(value)) {
        throw new RelayConfigError(`config.${field} must be an object`);
    }
    const result: Record<string, number> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (known && !(key in known)) {
            throw new RelayConfigError(
                `config.${field}.${key} is not a known setting`
            );
        }
        if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0) {
            throw new RelayConfigError(
                `config.${field}.${key} must be a non-negative number`
            );
        }
        result[key] = entry;
    }
    return result as Partial<T>;
}

function requireString(raw: Record<string, unknown>, key: string): string {
    const value = raw[key];
    if (typeof value !== 'string' || !value.trim()) {
        throw new RelayConfigError(`config.${key} must be a non-empty string`);
    }
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
