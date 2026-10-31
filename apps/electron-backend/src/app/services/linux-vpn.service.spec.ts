import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
jest.mock('electron', () => ({
    app: { getPath: jest.fn(), relaunch: jest.fn(), quit: jest.fn() },
}));
jest.mock('./linux-vpn-helper', () => ({
    runVpnHelper: jest.fn(),
    daemonIsReady: jest.requireActual('./linux-vpn-helper').daemonIsReady,
}));
import { app } from 'electron';
import { runVpnHelper } from './linux-vpn-helper';
import {
    configureLinuxVpn,
    changeLinuxVpn as changeLinuxVpnWithGuard,
    readVpnConfig,
    vpnConfigPath,
    writeVpnConfig,
    getLinuxVpnStatus,
} from './linux-vpn.service';
const quit = jest.fn(async (commit: () => void) => {
    commit();
    app.quit();
    return true;
});
const changeLinuxVpn = (
    request: Parameters<typeof changeLinuxVpnWithGuard>[0]
) => changeLinuxVpnWithGuard(request, quit);

(process.platform === 'linux' ? describe : describe.skip)(
    'Linux VPN account and connection controls',
    () => {
        let directory: string;
        const run = jest.mocked(runVpnHelper);
        beforeEach(() => {
            directory = mkdtempSync(join(tmpdir(), 'iptvnator-vpn-spec-'));
            jest.mocked(app.getPath).mockReturnValue(directory);
            run.mockImplementation(async (args) =>
                args[0] === 'daemon'
                    ? JSON.stringify({ available: true, compatible: true })
                    : 'vopono test'
            );
            quit.mockImplementation(async (commit) => {
                commit();
                app.quit();
                return true;
            });
            jest.clearAllMocks();
        });
        afterEach(() => {
            jest.useRealTimers();
            rmSync(directory, { recursive: true, force: true });
        });
        it('uses a token only for sync and never stores or returns it', async () => {
            const token = 'SYNTHETIC_SECRET_TOKEN_123456789';
            const status = await configureLinuxVpn(token);
            expect(run).toHaveBeenCalledWith(
                ['sync', 'nordvpn', '--protocol', 'wireguard', '--json'],
                token
            );
            expect(status.configured).toBe(true);
            expect(JSON.stringify(status)).not.toContain(token);
            expect(readFileSync(vpnConfigPath(), 'utf8')).not.toContain(token);
            expect(readVpnConfig().enabled).toBe(false);
        });
        it('does not enable playback if account setup fails', async () => {
            run.mockRejectedValue(new Error('Account setup failed.'));
            await expect(
                configureLinuxVpn('SYNTHETIC_SECRET_TOKEN_123456789')
            ).rejects.toThrow('Account setup failed');
            expect(readVpnConfig().configured).toBe(false);
            expect(readVpnConfig().enabled).toBe(false);
        });
        it('fails closed for corrupt persisted policy instead of silently disabling it', () => {
            writeFileSync(vpnConfigPath(), '{"enabled":"true"}');
            expect(() => readVpnConfig()).toThrow(
                'VPN settings could not be read'
            );
        });
        it('requires a configured account and compatible daemon before enabling', async () => {
            await expect(
                changeLinuxVpn({ enabled: true, server: 'canada' })
            ).rejects.toThrow('Finish NordVPN setup');
            writeVpnConfig({
                enabled: false,
                configured: true,
                server: 'canada',
            });
            run.mockResolvedValue('{}');
            await expect(
                changeLinuxVpn({ enabled: true, server: 'canada' })
            ).rejects.toThrow('Finish NordVPN setup');
            expect(readVpnConfig().enabled).toBe(false);
        });
        it('commits a protected restart only through a confirmed quit', async () => {
            writeVpnConfig({
                enabled: false,
                configured: true,
                server: 'canada',
            });
            await changeLinuxVpn({ enabled: true, server: 'canada' });
            expect(readVpnConfig().enabled).toBe(true);

            expect(app.relaunch).toHaveBeenCalledTimes(1);
            expect(app.quit).toHaveBeenCalledTimes(1);
        });
        it('leaves the policy and restart queue untouched when the user stays', async () => {
            writeVpnConfig({
                enabled: false,
                configured: true,
                server: 'canada',
            });
            quit.mockResolvedValue(false);
            const result = await changeLinuxVpn({
                enabled: true,
                server: 'united_states',
            });
            expect(result.cancelled).toBe(true);
            expect(readVpnConfig()).toEqual({
                enabled: false,
                configured: true,
                server: 'canada',
            });
            expect(app.relaunch).not.toHaveBeenCalled();
        });
        it('shows missing support as unavailable, never connected', async () => {
            run.mockRejectedValue(new Error('missing'));
            const status = await getLinuxVpnStatus();
            expect(status.helperAvailable).toBe(false);
            expect(status.daemonAvailable).toBe(false);
            expect(status.connected).toBe(false);
        });
        it('discards unexpected secret fields at the persistence boundary', () => {
            const supplied = Object.assign(
                { enabled: false, configured: true, server: 'canada' },
                { token: 'SYNTHETIC_EXTRA_SECRET' }
            );
            writeVpnConfig(supplied);
            const file = readFileSync(vpnConfigPath(), 'utf8');
            expect(JSON.parse(file)).toEqual({
                enabled: false,
                configured: true,
                server: 'canada',
            });
            expect(file).not.toContain('SYNTHETIC_EXTRA_SECRET');
        });
    }
);
