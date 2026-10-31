import { app } from 'electron';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { protectedVpnSession } from './linux-vpn-session';

export function vpnRestartRequested(directory: string): boolean {
    return existsSync(join(directory, 'restart.requested'));
}

/** A replacement launched inside a dying namespace cannot keep its tunnel. */
export function requestAppRelaunch(): void {
    if (!protectedVpnSession()) {
        app.relaunch();
        return;
    }
    const directory = process.env.IPTVNATOR_VPN_CONTROLLER_DIR;
    if (!directory)
        throw new Error('Close and reopen the player to restart its VPN.');
    writeFileSync(join(directory, 'restart.requested'), 'restart', {
        mode: 0o600,
    });
}
