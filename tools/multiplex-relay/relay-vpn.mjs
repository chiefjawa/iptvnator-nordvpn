#!/usr/bin/env node
// Starts the LAN relay inside its own NordVPN WireGuard namespace, without
// the desktop app.
//
// It reuses the VPN setup the owner completed in the app: the app had the
// vopono helper derive NordLynx credentials (`vopono sync nordvpn`), and the
// helper keeps them in its own files. This launcher asks the same root
// `vopono daemon` for a namespace with the same fixed command the app uses
// (linux-vpn-policy.ts `vpnLaunchArguments`), its own helper config with the
// kill switch forced on, and a distinct namespace name, so the app and the
// relay never share or tear down each other's namespace. No credential is
// read, copied or passed by this script.
//
// Environment (see tools/multiplex-relay/iptv-relay.env.example):
//   MULTIPLEX_RELAY_CONFIG  relay config path (required; not read here)
//   RELAY_SOCKET            unix socket the relay listens on
//   RELAY_VPN_SERVER        region or server; default: the app's choice
//   RELAY_BUNDLE, RELAY_NODE, RELAY_STATE_FILE, IPTVNATOR_VPN_SETTINGS
//
// Exit: 0 after a clean stop, nonzero on any failure (systemd restarts it).

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
    daemonReady,
    GUARD_SCRIPT,
    guardApplications,
    isRelayNamespace,
    listNamespaces,
    log,
    NAMESPACE_PREFIX,
    netnsInode,
    ownedNamespace,
    pickServer,
    publicIp,
    quoteCommand,
    REPO_ROOT,
    sleep,
    vopono,
    vpnRegion,
} from './relay-vpn-lib.mjs';

const LAUNCH_TIMEOUT_MS = 90_000;
const env = process.env;
const runtime = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`;
const stateDir = join(runtime, 'iptv-relay');
const socketPath = env.RELAY_SOCKET || join(stateDir, 'relay.sock');
const bundle =
    env.RELAY_BUNDLE || join(REPO_ROOT, 'dist/apps/multiplex-relay/main.js');
const nodeBin = env.RELAY_NODE || process.execPath;
const stateFile = env.RELAY_STATE_FILE || join(stateDir, 'guard-state.json');

let child = null;
let launchedPid = null;
let permit = null;
let workDir = null;
let stopping = false;

async function waitFor(what, check, timeoutMs, everyMs = 5000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() >= until || stopping) {
            throw new Error(`${what} not available`);
        }
        await sleep(everyMs);
    }
}

/** Stops relay namespaces left by an earlier run (only our own apps). */
async function cleanupStale() {
    const stale = (await listNamespaces()).filter((ns) =>
        isRelayNamespace(ns.id)
    );
    for (const ns of stale) {
        for (const app of guardApplications(ns)) {
            log('info', `stopping leftover relay in ${ns.id}`);
            await vopono([
                'stop',
                'application',
                String(app.pid),
                '--json',
            ]).catch(() => undefined);
        }
    }
    if (stale.length) {
        await waitFor(
            'cleanup of leftover namespaces',
            async () =>
                !(await listNamespaces()).some(
                    (ns) =>
                        isRelayNamespace(ns.id) && guardApplications(ns).length
                ),
            20_000,
            500
        );
    }
}

/** Guard exit code for "egress could not be verified" (relay-guard.mjs). */
const EGRESS_UNVERIFIED = 5;
const SERVER_ATTEMPTS = 3;

async function launch() {
    if (!existsSync(bundle)) {
        throw new Error('relay bundle missing; build it first');
    }
    if (
        !env.MULTIPLEX_RELAY_CONFIG ||
        !existsSync(env.MULTIPLEX_RELAY_CONFIG)
    ) {
        throw new Error(
            'MULTIPLEX_RELAY_CONFIG does not name an existing file'
        );
    }
    await waitFor('vopono daemon', daemonReady, 120_000);
    // Doubles as the wait for the network: user units have no
    // network-online.target.
    const hostIp = await waitFor(
        'host internet (IP echo)',
        publicIp,
        300_000,
        10_000
    );
    const hostNetns = netnsInode();
    await cleanupStale();
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    // Launch dirs of runs that were killed before they could clean up.
    for (const entry of readdirSync(stateDir)) {
        if (entry.startsWith('launch-')) {
            rmSync(join(stateDir, entry), { recursive: true, force: true });
        }
    }

    // Some listed servers are offline: a namespace whose egress never
    // verifies is replaced by one on another server, a few times.
    const tried = [];
    for (let attempt = 1; ; attempt += 1) {
        const inUse = (await listNamespaces())
            .map((ns) => ns.server?.id)
            .filter(Boolean);
        const region = vpnRegion(env);
        const { server, specific } = pickServer(region, [...inUse, ...tried]);
        tried.push(server);
        const end = await runSession({
            server,
            specific,
            region,
            hostIp,
            hostNetns,
        });
        if (stopping) return;
        const retry =
            end.code === EGRESS_UNVERIFIED &&
            !end.relayStarted &&
            specific &&
            attempt < SERVER_ATTEMPTS;
        if (!retry) {
            log('warn', `relay namespace session ended (${end.code})`);
            cleanup();
            process.exit(end.code || 1);
        }
        log('warn', `server ${server} did not pass traffic; trying another`);
        cleanup();
        launchedPid = null;
        await waitForTeardown();
    }
}

/** One namespace with the guard in it; resolves when the session ends. */
async function runSession({ server, specific, region, hostIp, hostNetns }) {
    const name = `${NAMESPACE_PREFIX}${randomBytes(4).toString('hex')}`;
    const owned = ownedNamespace(name);
    log(
        'info',
        `starting VPN namespace ${owned} (region ${region}, ${specific ? `server ${server}, not used by other namespaces` : 'server chosen by vopono'})`
    );
    workDir = mkdtempSync(join(stateDir, 'launch-'));
    const helperConfig = join(workDir, 'vopono.toml');
    writeFileSync(helperConfig, 'no_killswitch = false\n', { mode: 0o600 });
    permit = join(workDir, 'launch.allowed');
    writeFileSync(permit, '', { mode: 0o600 });

    const childEnv = {
        ...env,
        RELAY_GUARD_NAMESPACE: owned,
        RELAY_GUARD_HOST_NETNS: String(hostNetns),
        RELAY_GUARD_HOST_IP: hostIp,
        RELAY_GUARD_PERMIT: permit,
        RELAY_GUARD_SUPERVISOR: String(process.pid),
        RELAY_SOCKET: socketPath,
        RELAY_BUNDLE: bundle,
        RELAY_NODE: nodeBin,
        RELAY_STATE_FILE: stateFile,
    };
    delete childEnv.NORDVPN_ACCESS_TOKEN;
    child = spawn(
        'vopono',
        [
            'exec',
            '--provider',
            'nordvpn',
            '--protocol',
            'wireguard',
            '--server',
            server,
            '--custom-netns-name',
            name,
            '--vopono-config',
            helperConfig,
            '--json',
            quoteCommand([nodeBin, GUARD_SCRIPT]),
        ],
        // Helper diagnostics may name servers/addresses: not forwarded
        // unless RELAY_VPN_DEBUG=1.
        {
            env: childEnv,
            stdio: [
                'ignore',
                'pipe',
                env.RELAY_VPN_DEBUG === '1' ? 'inherit' : 'ignore',
            ],
        }
    );
    return followSession(owned);
}

/** Reads vopono's launch report, forwards log lines, reports the end. */
function followSession(owned) {
    return new Promise((resolve, reject) => {
        let buffer = '';
        let relayStarted = false;
        const timer = setTimeout(
            () => reject(new Error('VPN launch timed out')),
            LAUNCH_TIMEOUT_MS
        );
        const onLine = (line) => {
            if (launchedPid === null) {
                try {
                    const report = JSON.parse(line);
                    if (
                        report.version === 1 &&
                        report.event === 'launched' &&
                        report.namespace === owned &&
                        Number.isSafeInteger(report.pid) &&
                        report.pid > 0
                    ) {
                        launchedPid = report.pid;
                        clearTimeout(timer);
                        log(
                            'info',
                            `VPN namespace ${owned} up; guard pid ${launchedPid}`
                        );
                        return;
                    }
                } catch {
                    // Not the report.
                }
            }
            if (line.includes('guard: relay started')) relayStarted = true;
            // Lines of the guard and relay (already free of secrets).
            process.stdout.write(`${line}\n`);
        };
        child.stdout.on('data', (chunk) => {
            buffer += chunk.toString();
            for (
                let end = buffer.indexOf('\n');
                end >= 0;
                end = buffer.indexOf('\n')
            ) {
                onLine(buffer.slice(0, end));
                buffer = buffer.slice(end + 1);
            }
            if (buffer.length > 65_536) buffer = '';
        });
        child.once('error', () => reject(new Error('vopono could not start')));
        child.once('close', (code) => {
            clearTimeout(timer);
            if (launchedPid === null && !stopping) {
                reject(new Error('VPN connection did not start'));
                return;
            }
            resolve({ code, relayStarted });
        });
    });
}

function waitForTeardown() {
    return waitFor(
        'namespace teardown',
        async () =>
            !(await listNamespaces()).some(
                (ns) => isRelayNamespace(ns.id) && guardApplications(ns).length
            ),
        15_000,
        500
    );
}

function cleanup() {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    workDir = null;
}

async function stop(signal, code = 0) {
    if (stopping) return;
    stopping = true;
    log('info', `${signal}: stopping the relay and its VPN namespace`);
    if (permit) rmSync(permit, { force: true });
    if (launchedPid !== null) {
        try {
            process.kill(launchedPid, 'SIGTERM');
        } catch {
            // Already gone.
        }
    }
    const closed = child
        ? new Promise((resolve) =>
              child.exitCode !== null ? resolve() : child.once('close', resolve)
          )
        : Promise.resolve();
    await Promise.race([closed, sleep(25_000)]);
    if (launchedPid !== null && child?.exitCode === null) {
        await vopono([
            'stop',
            'application',
            String(launchedPid),
            '--json',
        ]).catch(() => undefined);
        await Promise.race([closed, sleep(10_000)]);
    }
    try {
        await waitForTeardown();
    } catch {
        log('warn', 'relay namespace still listed after stop');
    }
    cleanup();
    process.exit(code);
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => void stop(signal));
}

launch().catch(async (error) => {
    log('error', `launch failed: ${error.message}`);
    await stop('failure', 1);
});
