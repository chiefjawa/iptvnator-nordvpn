import { app, BrowserWindow, dialog } from 'electron';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    protectedVpnSession,
    readVpnConfig,
    writeVpnConfig,
    getLinuxVpnStatus,
} from './linux-vpn.service';
import { vpnLaunchArguments, vpnNamespaceName } from './linux-vpn-policy';
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
    try {
        if (process.env.VOPONO_NS) throw new Error('Unverified VPN namespace.');
        scheduleDeferredFixPath();
        await waitForLoginShellPath();
        const status = await getLinuxVpnStatus();
        if (!status.configured || !status.daemonAvailable)
            throw new Error('VPN helper not ready.');
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
        await progress.loadURL(
            'data:text/html;charset=utf-8,' +
                encodeURIComponent(
                    '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>IPTVnator VPN</title><body style="font:16px system-ui;padding:20px"><strong>Connecting to NordVPN…</strong><p>Your player will open when its protected connection is ready.</p>'
                )
        );
        const namespace = vpnNamespaceName(app.getPath('userData'));
        // The controller stays outside the tunnel, drains output without logging
        // it, and keeps the daemon client alive until the protected app exits.
        const env = { ...process.env };
        delete env.NORDVPN_ACCESS_TOKEN;
        env.IPTVNATOR_VPN_HOST_NETNS = String(
            statSync('/proc/self/ns/net').ino
        );
        const child = spawn(
            'vopono',
            vpnLaunchArguments(
                status.server,
                namespace,
                [process.execPath, ...process.argv.slice(1)],
                helperConfig
            ),
            { env, stdio: ['ignore', 'pipe', 'ignore'] }
        );
        let launched = false;
        let buffer = '';
        let cancelled = false;
        progress.on('closed', () => {
            if (!launched) {
                cancelled = true;
                child.kill('SIGTERM');
                app.exit(0);
            }
        });
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                child.kill('SIGTERM');
                reject(new Error('VPN launch timed out.'));
            }, 90_000);
            child.stdout.on('data', (chunk: Buffer) => {
                if (launched) return;
                buffer += chunk.toString();
                if (buffer.length > 65_536) {
                    child.kill('SIGTERM');
                    clearTimeout(timer);
                    reject(new Error('Invalid VPN helper response.'));
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
                            report.namespace ===
                                `${namespace}-u${process.getuid?.()}` &&
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
            child.once('error', () => {
                clearTimeout(timer);
                reject(new Error('VPN helper could not start.'));
            });
            child.once('close', (code) => {
                clearTimeout(timer);
                if (launched || cancelled) app.exit(code ?? 1);
                else reject(new Error('VPN connection did not start.'));
            });
        });
    } catch {
        // Only an explicit user choice may reopen the player on normal internet.
        progress?.removeAllListeners('closed');
        progress?.destroy();
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
