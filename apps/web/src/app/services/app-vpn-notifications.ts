import type { LinuxVpnStatus } from '@iptvnator/shared/interfaces';

/** The launch gate supplies a native error dialog if the player cannot open. */
export async function notifyAppVpn(
    getStatus: () => Promise<LinuxVpnStatus>,
    message: (key: string, params?: Record<string, string>) => string,
    show: (text: string) => void
): Promise<void> {
    try {
        const status = await getStatus();
        if (!status.enabled) return;
        show(
            status.connected && status.publicIp
                ? message('VPN.STARTUP_CONNECTED', { ip: status.publicIp })
                : message('VPN.STARTUP_UNVERIFIED')
        );
    } catch {
        show(message('VPN.STATUS_FAILED'));
    }
}
