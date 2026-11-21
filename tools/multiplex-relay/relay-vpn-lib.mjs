// Shared helpers of the relay's VPN launcher, guard and relayctl.
//
// Secrets rule: nothing here prints a config value, a token, a provider
// address or a public IP. The NordVPN WireGuard files that the vopono helper
// derived during the desktop app's account setup are only ever LISTED by
// name (to pick a server); vopono itself reads them.

import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isIP } from 'node:net';

/** Same rule as the app (`validVpnServer` in linux-vpn-policy.ts). */
export const SERVER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
export const NAMESPACE_PREFIX = 'iptvrelay-';
export const DEFAULT_APP_VPN_SETTINGS =
    '/home/jackd/Work/iptvnator-private/profile/user-data/linux-vpn.json';
export const GUARD_SCRIPT = new URL('./relay-guard.mjs', import.meta.url)
    .pathname;
export const REPO_ROOT = new URL('../..', import.meta.url).pathname.replace(
    /\/$/,
    ''
);

export function uid() {
    return process.getuid?.() ?? 0;
}

/** vopono appends `-u<uid>` to the name it is given. */
export function ownedNamespace(name) {
    return `${name}-u${uid()}`;
}

export function isRelayNamespace(id) {
    return new RegExp(`^${NAMESPACE_PREFIX}[a-f0-9]{8}-u${uid()}$`).test(id);
}

export function log(level, message) {
    process.stdout.write(`${new Date().toISOString()} ${level} ${message}\n`);
}

/** Runs vopono without a shell; its output is returned, never logged. */
export function vopono(args, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
        const env = { ...process.env };
        delete env.NORDVPN_ACCESS_TOKEN;
        execFile(
            'vopono',
            args,
            { env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
            (error, stdout) =>
                error
                    ? reject(new Error('vopono call failed'))
                    : resolve(stdout)
        );
    });
}

export async function daemonReady() {
    try {
        const status = JSON.parse(await vopono(['daemon', 'status', '--json']));
        return status?.available === true && status?.compatible === true;
    } catch {
        return false;
    }
}

export async function listNamespaces() {
    const result = JSON.parse(await vopono(['list', 'namespaces', '--json']));
    if (!Array.isArray(result?.namespaces)) {
        throw new Error('unknown helper state');
    }
    return result.namespaces;
}

/** Applications of a namespace that this launcher started (by guard path). */
export function guardApplications(namespace) {
    return (namespace.applications ?? []).filter(
        (app) =>
            Array.isArray(app.argv) &&
            app.argv.includes(GUARD_SCRIPT) &&
            Number.isSafeInteger(app.pid) &&
            app.pid > 0
    );
}

/** Region from the env, else the desktop app's saved choice, else canada. */
export function vpnRegion(env = process.env) {
    const fromEnv = env.RELAY_VPN_SERVER?.trim();
    if (fromEnv) {
        if (!SERVER_PATTERN.test(fromEnv)) {
            throw new Error('RELAY_VPN_SERVER is not a valid server name');
        }
        return fromEnv;
    }
    const path = env.IPTVNATOR_VPN_SETTINGS || DEFAULT_APP_VPN_SETTINGS;
    try {
        // linux-vpn.json holds only {enabled, configured, server}.
        const server = JSON.parse(readFileSync(path, 'utf8'))?.server;
        if (typeof server === 'string' && SERVER_PATTERN.test(server)) {
            return server;
        }
    } catch {
        // Missing or unreadable: use the app's default region.
    }
    return 'canada';
}

/** Names of the vopono NordVPN WireGuard server files; never their content. */
export function wireguardServers() {
    const dir = join(
        process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
        'vopono/nordvpn/wireguard'
    );
    try {
        return readdirSync(dir)
            .filter((name) => name.endsWith('.conf'))
            .map((name) => name.slice(0, -'.conf'.length));
    } catch {
        return [];
    }
}

/**
 * A specific server for `region` that no other running namespace uses: one
 * NordLynx key on one server from two tunnels would make the server flip
 * between the two endpoints and break both.
 */
export function pickServer(region, inUse, servers = wireguardServers()) {
    const busy = new Set(inUse);
    // vopono's aliases: "canada", "ca", "ca2128", "canada-ca-ca2128".
    const matching = servers.filter(
        (name) => name.startsWith(region) || name.split('-').includes(region)
    );
    if (matching.length === 0) {
        // No server list to choose from: let vopono resolve the prefix.
        return { server: region, specific: false };
    }
    const free = matching.filter((name) => !busy.has(name));
    if (free.length === 0) {
        // A specific server (e.g. the app's) is busy: use its country.
        const country = region.split('-')[0];
        if (country && country !== region) {
            return pickServer(country, inUse, servers);
        }
        throw new Error('every server of the region is already in use');
    }
    // Plain "country-cc-ccNNN" servers first; odd variants such as
    // "canada-ca-us-ca104" did not pass traffic in testing.
    const plain = free.filter((name) =>
        /^[a-z_]+-[a-z]{2}-[a-z]{2}\d+$/.test(name)
    );
    const pool = plain.length ? plain : free;
    const server = pool[Math.floor(Math.random() * pool.length)];
    return { server, specific: true };
}

export function netnsInode(path = '/proc/self/ns/net') {
    return statSync(path).ino;
}

const IP_ECHO = ['https://api.ipify.org', 'https://icanhazip.com'];

/** This network's public IP from a neutral echo service, or null. */
export async function publicIp(timeoutMs = 8000) {
    for (const url of IP_ECHO) {
        try {
            const response = await fetch(url, {
                signal: AbortSignal.timeout(timeoutMs),
                cache: 'no-store',
            });
            const text = (await response.text()).trim();
            if (response.ok && text.length < 64 && isIP(text)) {
                return text;
            }
        } catch {
            // Try the next service.
        }
    }
    return null;
}

/** Escapes one argv for vopono's single command string (as the app does). */
export function quoteCommand(args) {
    return args
        .map((arg) => `'${String(arg).replace(/'/g, `'\\''`)}'`)
        .join(' ')
        .replace(/\$/g, () => '$$');
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
