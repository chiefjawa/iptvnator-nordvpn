#!/usr/bin/env node
// Runs INSIDE the relay's VPN namespace (started by vopono for
// relay-vpn.mjs). It starts the relay only after proving it is in the
// expected namespace and that traffic leaves through the VPN, keeps
// checking, and kills the relay when any check fails (fail closed). The
// helper's WireGuard kill switch stays on underneath: if the tunnel drops,
// the namespace has no route to the internet at all.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { log, netnsInode, publicIp, sleep } from './relay-vpn-lib.mjs';

const TICK_MS = 3000;
const EGRESS_RECHECK_MS = 30 * 60_000;
const EGRESS_DEADLINE_MS = 90_000;
const START_EGRESS_DEADLINE_MS = 30_000;
/** Wall clock ahead of the monotonic clock by this much means a suspend. */
const SUSPEND_JUMP_MS = 15_000;

const env = process.env;
const namespace = env.RELAY_GUARD_NAMESPACE ?? '';
const hostNetns = Number(env.RELAY_GUARD_HOST_NETNS);
const hostIp = env.RELAY_GUARD_HOST_IP ?? '';
const permit = env.RELAY_GUARD_PERMIT ?? '';
const supervisor = Number(env.RELAY_GUARD_SUPERVISOR);
const stateFile = env.RELAY_STATE_FILE ?? '';

let relay = null;
let stopping = false;

function fail(code, message) {
    log('error', `guard: ${message}; relay stopped (fail closed)`);
    writeState({ ok: false, reason: message });
    stopRelay().then(() => process.exit(code));
}

function writeState(fields) {
    if (!stateFile) return;
    try {
        mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
        const body = JSON.stringify({
            namespace,
            checkedAt: new Date().toISOString(),
            ...fields,
        });
        writeFileSync(`${stateFile}.tmp`, body, { mode: 0o600 });
        renameSync(`${stateFile}.tmp`, stateFile);
    } catch {
        // State is informational only.
    }
}

/** Namespace identity: named, the kernel's, and not the host's. */
function namespaceProblem() {
    if (!namespace || env.VOPONO_NS !== namespace) {
        return 'not started in the expected VPN namespace';
    }
    if (!permit || !existsSync(permit)) {
        return 'launch permit revoked';
    }
    try {
        const own = netnsInode();
        if (!Number.isSafeInteger(hostNetns) || hostNetns <= 0) {
            return 'host namespace identity missing';
        }
        if (own === hostNetns) {
            return 'running in the host network namespace';
        }
        if (own !== netnsInode(`/run/netns/${namespace}`)) {
            return 'VPN namespace is gone or was replaced';
        }
    } catch {
        return 'VPN namespace is gone';
    }
    if (Number.isSafeInteger(supervisor) && supervisor > 0) {
        try {
            process.kill(supervisor, 0);
        } catch {
            return 'launcher is no longer running';
        }
    }
    return null;
}

/** Retries until the deadline; never prints either address. */
async function egressVerdict(deadlineMs) {
    const until = Date.now() + deadlineMs;
    do {
        if (namespaceProblem()) return 'unknown';
        const ip = await publicIp();
        if (ip) {
            return ip === hostIp ? 'same' : 'differs';
        }
        await sleep(5000);
    } while (Date.now() < until && !stopping);
    return 'unknown';
}

async function checkEgress(deadlineMs, why) {
    const verdict = await egressVerdict(deadlineMs);
    const problem = namespaceProblem();
    if (problem) {
        fail(3, problem);
        return false;
    }
    if (verdict !== 'differs') {
        fail(
            verdict === 'same' ? 4 : 5,
            verdict === 'same'
                ? `${why}: namespace public IP is the SAME as the host's`
                : `${why}: egress could not be verified within ${deadlineMs / 1000}s`
        );
        return false;
    }
    log('info', `guard: ${why}: namespace and host public IP differ`);
    writeState({ ok: true, egress: 'differs' });
    return true;
}

function startRelay() {
    const args = [
        env.RELAY_BUNDLE,
        '--config',
        env.MULTIPLEX_RELAY_CONFIG,
        '--listen',
        `unix:${env.RELAY_SOCKET}`,
    ];
    const childEnv = { ...env };
    delete childEnv.NORDVPN_ACCESS_TOKEN;
    relay = spawn(env.RELAY_NODE || process.execPath, args, {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: childEnv,
    });
    relay.once('exit', (code, signal) => {
        relay = null;
        if (!stopping) {
            log('warn', `guard: relay exited (${signal ?? code})`);
            process.exit(code || 1);
        }
    });
}

function stopRelay() {
    stopping = true;
    if (!relay) return Promise.resolve();
    const child = relay;
    return new Promise((resolve) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
        child.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
        // The relay closes its upstream connection first on SIGTERM.
        child.kill('SIGTERM');
    });
}

async function main() {
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
        process.on(signal, () => stopRelay().then(() => process.exit(0)));
    }
    const problem = namespaceProblem();
    if (problem) return fail(3, problem);
    if (!hostIp) return fail(3, 'host public IP unknown; cannot compare');
    for (const key of [
        'RELAY_BUNDLE',
        'MULTIPLEX_RELAY_CONFIG',
        'RELAY_SOCKET',
    ]) {
        if (!env[key]) return fail(2, `${key} is not set`);
    }
    // A working tunnel answers within seconds; a dead server is replaced.
    if (!(await checkEgress(START_EGRESS_DEADLINE_MS, 'start'))) return;
    if (namespaceProblem()) return fail(3, namespaceProblem());
    startRelay();
    log('info', 'guard: relay started inside the VPN namespace');

    let lastWall = Date.now();
    let lastMono = performance.now();
    let lastEgress = lastMono;
    while (!stopping) {
        await sleep(TICK_MS);
        const problemNow = namespaceProblem();
        if (problemNow) return fail(3, problemNow);
        const wall = Date.now();
        const mono = performance.now();
        // CLOCK_MONOTONIC stops during suspend; the wall clock does not.
        const resumed = wall - lastWall - (mono - lastMono) > SUSPEND_JUMP_MS;
        lastWall = wall;
        lastMono = mono;
        if (resumed || mono - lastEgress > EGRESS_RECHECK_MS) {
            lastEgress = mono;
            if (
                !(await checkEgress(
                    EGRESS_DEADLINE_MS,
                    resumed ? 'resume' : 'recheck'
                ))
            ) {
                return;
            }
        }
    }
}

main().catch(() => fail(1, 'unexpected guard error'));
