import { protectedVpnSession } from './linux-vpn-session';
export { protectedVpnSession } from './linux-vpn-session';
import { app } from 'electron';
import {
    readFileSync,
    mkdirSync,
    writeFileSync,
    renameSync,
    chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
    LinuxVpnConnectionRequest,
    LinuxVpnStatus,
    LinuxVpnChangeResult,
} from '@iptvnator/shared/interfaces';
import { daemonIsReady, runVpnHelper } from './linux-vpn-helper';
import { getVpnPublicIp } from './linux-vpn-egress';
import {
    normalizeVpnConfig,
    validVpnServer,
    type LinuxVpnConfig,
} from './linux-vpn-policy';

export function vpnConfigPath(): string {
    return join(app.getPath('userData'), 'linux-vpn.json');
}

export function readVpnConfig(): LinuxVpnConfig {
    try {
        return normalizeVpnConfig(
            JSON.parse(readFileSync(vpnConfigPath(), 'utf8'))
        );
    } catch (error) {
        // A malformed existing policy must not silently disable a saved VPN.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return normalizeVpnConfig(undefined);
        throw new Error(
            'VPN settings could not be read. Restore linux-vpn.json before opening the player.'
        );
    }
}

export function writeVpnConfig(value: LinuxVpnConfig): void {
    const path = vpnConfigPath();
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(path + '.tmp', JSON.stringify(normalizeVpnConfig(value)), {
        mode: 0o600,
    });
    chmodSync(path + '.tmp', 0o600);
    renameSync(path + '.tmp', path);
}

export async function getLinuxVpnStatus(): Promise<LinuxVpnStatus> {
    const config = readVpnConfig();
    const result: LinuxVpnStatus = {
        ...config,
        supported: process.platform === 'linux',
        helperAvailable: false,
        daemonAvailable: false,
        connected: protectedVpnSession(),
    };
    if (!result.supported) return result;
    if (result.connected) result.publicIp = await getVpnPublicIp();
    try {
        await runVpnHelper(['--version']);
        result.helperAvailable = true;
        result.daemonAvailable = daemonIsReady(
            JSON.parse(await runVpnHelper(['daemon', 'status', '--json']))
        );
    } catch {
        /* A missing helper is a setup state, not a connected tunnel. */
    }
    return result;
}

let configuring = false;
export async function configureLinuxVpn(
    token: unknown
): Promise<LinuxVpnStatus> {
    if (process.platform !== 'linux')
        throw new Error('App VPN is available on Linux only.');
    if (configuring) throw new Error('NordVPN setup is already running.');
    if (
        typeof token !== 'string' ||
        !/^[a-zA-Z0-9_-]{20,512}$/.test(token.trim())
    ) {
        throw new Error('Enter a valid NordVPN access token.');
    }
    configuring = true;
    try {
        // Only this one-time child receives the token; the player never saves it.
        await runVpnHelper(
            ['sync', 'nordvpn', '--protocol', 'wireguard', '--json'],
            token.trim()
        );
        writeVpnConfig({ ...readVpnConfig(), configured: true });
        return await getLinuxVpnStatus();
    } finally {
        configuring = false;
    }
}

export async function changeLinuxVpn(
    request: LinuxVpnConnectionRequest,
    requestQuit: (commit: () => void) => Promise<boolean>
): Promise<LinuxVpnChangeResult> {
    if (process.platform !== 'linux')
        throw new Error('App VPN is available on Linux only.');
    if (
        !request ||
        typeof request.enabled !== 'boolean' ||
        !validVpnServer(request.server)
    ) {
        throw new Error('Choose a valid VPN server.');
    }
    const status = await getLinuxVpnStatus();
    if (request.enabled && (!status.configured || !status.daemonAvailable)) {
        throw new Error(
            'Finish NordVPN setup and start the VPN helper service first.'
        );
    }
    const confirmed = await requestQuit(() => {
        writeVpnConfig({
            ...readVpnConfig(),
            enabled: request.enabled,
            server: request.server,
        });
        if (request.enabled && !protectedVpnSession()) app.relaunch();
    });
    return {
        status: confirmed
            ? { ...status, enabled: request.enabled, server: request.server }
            : status,
        cancelled: !confirmed,
    };
}
