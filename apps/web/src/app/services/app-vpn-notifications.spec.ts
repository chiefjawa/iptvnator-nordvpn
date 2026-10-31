import { notifyAppVpn } from './app-vpn-notifications';
import type { LinuxVpnStatus } from '@iptvnator/shared/interfaces';

describe('VPN startup notifications', () => {
    const status: LinuxVpnStatus = {
        supported: true,
        helperAvailable: true,
        daemonAvailable: true,
        configured: true,
        enabled: true,
        connected: true,
        server: 'canada',
        publicIp: '203.0.113.7',
    };
    const message = (key: string, params?: Record<string, string>) =>
        key + (params?.['ip'] ?? '');
    it('announces a verified protected connection and its actual public IP', async () => {
        const show = jest.fn();
        await notifyAppVpn(async () => status, message, show);
        expect(show).toHaveBeenCalledWith('VPN.STARTUP_CONNECTED203.0.113.7');
    });
    it('warns when namespace protection exists but internet cannot be verified', async () => {
        const show = jest.fn();
        await notifyAppVpn(
            async () => ({ ...status, publicIp: undefined }),
            message,
            show
        );
        expect(show).toHaveBeenCalledWith('VPN.STARTUP_UNVERIFIED');
    });
    it('stays quiet when app VPN is intentionally off', async () => {
        const show = jest.fn();
        await notifyAppVpn(
            async () => ({ ...status, enabled: false }),
            message,
            show
        );
        expect(show).not.toHaveBeenCalled();
    });
    it('reports a failed status check', async () => {
        const show = jest.fn();
        await notifyAppVpn(
            async () => {
                throw Error('unavailable');
            },
            message,
            show
        );
        expect(show).toHaveBeenCalledWith('VPN.STATUS_FAILED');
    });
});
