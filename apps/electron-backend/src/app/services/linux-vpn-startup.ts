import { app, BrowserWindow, dialog } from 'electron';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
    protectedVpnSession,
    readVpnConfig,
    writeVpnConfig,
    getLinuxVpnStatus,
} from './linux-vpn.service';
import { vpnLaunchArguments, vpnNamespaceName } from './linux-vpn-policy';
import { createVpnLaunchGuard, stopVpnLaunch } from './linux-vpn-launch-guard';
import { vpnRestartRequested } from './linux-vpn-restart';
import {
    scheduleDeferredFixPath,
    waitForLoginShellPath,
} from '../startup/login-shell-path';

/** Nothing loads the viewing UI or contacts a playlist before this gate. */
export function bootstrapLinuxVpn(startPlayer: () => void): void {
    if (process.platform !== 'linux') return startPlayer();
    try {
        if (!readVpnConfig().enabled || protectedVpnSession())
            return startPlayer();
    } catch {
        void app.whenReady().then(async () => {
            await dialog.showMessageBox({
                type: 'error',
                message: 'VPN settings could not be read.',
                detail: 'The player has not opened. Restore linux-vpn.json and try again.',
            });
            app.exit(1);
        });
        return;
    }
    // The controller must not hold the protected player's Chromium storage.
    // Electron requires sessionData to be selected before app.whenReady.
    const sessionData = mkdtempSync(
        join(tmpdir(), 'iptvnator-vpn-controller-')
    );
    app.setPath('sessionData', sessionData);
    process.once('exit', () =>
        rmSync(sessionData, { recursive: true, force: true })
    );
    // This process owns the helper until it exits, even after its only window
    // closes on success or before a native recovery dialog is displayed.
    app.on('window-all-closed', () => undefined);
    const helperConfig = join(sessionData, 'vopono.toml');
    writeFileSync(helperConfig, 'no_killswitch = false\n', { mode: 0o600 });
    void app.whenReady().then(() => launchProtectedPlayer(helperConfig));
}

async function launchProtectedPlayer(helperConfig: string): Promise<void> {
    let progress: BrowserWindow | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    let guard: ReturnType<typeof createVpnLaunchGuard> | undefined;
    let stopped = false;
    let cancelled = false;
    let aborting = false;
    let launched = false;
    let rejectLaunch: ((error: Error) => void) | undefined;
    const session = randomBytes(6).toString('hex');
    const namespace = `${vpnNamespaceName(app.getPath('userData'))}-${session}`;
    const ownedNamespace = `${namespace}-u${process.getuid?.()}`;
    try {
        if (process.env.VOPONO_NS) throw new Error('Unverified VPN namespace.');
        scheduleDeferredFixPath();
        await waitForLoginShellPath();
        const status = await getLinuxVpnStatus();
        if (!status.configured || !status.daemonAvailable)
            throw new Error('VPN helper not ready.');
        guard = createVpnLaunchGuard(dirname(helperConfig), [
            process.execPath,
            ...process.argv.slice(1),
        ]);
        progress = new BrowserWindow({
            width: 430,
            height: 155,
            resizable: false,
            webPreferences: {
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
            },
        });
        progress.on('closed', () => {
            if (!launched) {
                cancelled = true;
                aborting = true;
                guard?.cancel();
                rejectLaunch?.(new Error('VPN launch cancelled.'));
            }
        });
        await progress.loadURL(
            'data:text/html;charset=utf-8,' +
                encodeURIComponent(
                    '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>IPTVnator VPN</title><body style="font:16px system-ui;padding:20px"><strong>Connecting to NordVPN…</strong><p>Your player will open when its protected connection is ready.</p>'
                )
        );
        if (cancelled) throw new Error('VPN launch cancelled.');
        // The controller stays outside the tunnel, drains output without logging
        // it, and keeps the daemon client alive until the protected app exits.
        const env = { ...process.env };
        delete env.NORDVPN_ACCESS_TOKEN;
        env.IPTVNATOR_VPN_CONTROLLER_DIR = dirname(helperConfig);
        env.IPTVNATOR_VPN_SESSION = session;
        env.IPTVNATOR_VPN_HOST_NETNS = String(
            statSync('/proc/self/ns/net').ino
        );
        child = spawn(
            'vopono',
            vpnLaunchArguments(
                status.server,
                namespace,
                guard.args,
                helperConfig
            ),
            { env, stdio: ['ignore', 'pipe', 'ignore'] }
        );
        let buffer = '';
        await new Promise<void>((resolve, reject) => {
            const abort = (error: Error) => {
                aborting = true;
                guard?.cancel();
                clearTimeout(timer);
                reject(error);
            };
            const timer = setTimeout(() => {
                abort(new Error('VPN launch timed out.'));
            }, 90_000);
            rejectLaunch = abort;
            child?.stdout?.on('data', (chunk: Buffer) => {
                if (launched || aborting) return;
                buffer += chunk.toString();
                if (buffer.length > 65_536) {
                    abort(new Error('Invalid VPN helper response.'));
                    return;
                }
                for (
                    let end = buffer.indexOf('\n');
                    end >= 0;
                    end = buffer.indexOf('\n')
                ) {
                    const line = buffer.slice(0, end);
                    buffer = buffer.slice(end + 1);
                    try {
                        const report = JSON.parse(line);
                        if (
                            report.version === 1 &&
                            report.event === 'launched' &&
                            report.namespace === ownedNamespace &&
                            Number.isSafeInteger(report.pid) &&
                            report.pid > 0
                        ) {
                            launched = true;
                            buffer = '';
                            clearTimeout(timer);
                            progress?.destroy();
                            resolve();
                            return;
                        }
                    } catch {
                        /* Ignore non-JSON helper output; never forward it to logs/UI. */
                    }
                }
            });
            child?.once('error', () => {
                stopped = true;
                abort(new Error('VPN helper could not start.'));
            });
            child?.once('close', (code) => {
                stopped = true;
                clearTimeout(timer);
                if (launched && !aborting) {
                    if (vpnRestartRequested(dirname(helperConfig)))
                        app.relaunch();
                    app.exit(code ?? 1);
                } else abort(new Error('VPN connection did not start.'));
            });
        });
    } catch {
        aborting = true;
        guard?.cancel();
        // Only an explicit user choice may reopen the player on normal internet.
        progress?.removeAllListeners('closed');
        progress?.destroy();
        const cleaned =
            !child ||
            (await stopVpnLaunch(
                ownedNamespace,
                guard?.script ?? '',
                () => stopped
            ));
        if (cancelled && cleaned) {
            app.exit(0);
            return;
        }
        if (!cleaned) {
            await dialog.showMessageBox({
                type: 'error',
                message: 'VPN launch could not be fully stopped.',
                detail: 'The player remains blocked. Close the VPN helper session before reopening. No normal-network relaunch was allowed.',
                buttons: ['Quit'],
            });
            app.exit(1);
            return;
        }
        const choice = await dialog.showMessageBox({
            type: 'error',
            message: 'NordVPN could not connect.',
            detail: 'The player has not opened. Check the VPN support service and your account setup, then try again.',
            buttons: [
                'Quit',
                process.env.VOPONO_NS
                    ? 'Turn off app VPN and close'
                    : 'Turn off app VPN and reopen player',
            ],
            defaultId: 0,
            cancelId: 0,
        });
        if (choice.response === 1) {
            writeVpnConfig({ ...readVpnConfig(), enabled: false });
            // A controller uses temporary Chromium storage. Reopen in a fresh
            // host process so the real player's preferences remain persistent.
            if (!process.env.VOPONO_NS) app.relaunch();
            app.exit(0);
        } else app.exit(1);
    }
}
