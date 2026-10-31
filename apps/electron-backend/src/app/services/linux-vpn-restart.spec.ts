import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
jest.mock('electron', () => ({ app: { relaunch: jest.fn() } }));
jest.mock('./linux-vpn-session', () => ({
    protectedVpnSession: jest.fn(() => false),
}));
import { app } from 'electron';
import { protectedVpnSession } from './linux-vpn-session';
import { requestAppRelaunch, vpnRestartRequested } from './linux-vpn-restart';

describe('Protected-player restart routing', () => {
    let directory: string;
    const original = process.env.IPTVNATOR_VPN_CONTROLLER_DIR;
    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), 'iptvnator-restart-'));
        process.env.IPTVNATOR_VPN_CONTROLLER_DIR = directory;
        jest.mocked(protectedVpnSession).mockReturnValue(false);
        jest.clearAllMocks();
    });
    afterEach(() => {
        rmSync(directory, { recursive: true, force: true });
        if (original === undefined)
            delete process.env.IPTVNATOR_VPN_CONTROLLER_DIR;
        else process.env.IPTVNATOR_VPN_CONTROLLER_DIR = original;
    });
    it('keeps ordinary desktop restarts unchanged', () => {
        requestAppRelaunch();
        expect(app.relaunch).toHaveBeenCalledTimes(1);
        expect(vpnRestartRequested(directory)).toBe(false);
    });
    it('requests a new host-owned launch instead of inheriting the dying namespace', () => {
        jest.mocked(protectedVpnSession).mockReturnValue(true);
        requestAppRelaunch();
        expect(app.relaunch).not.toHaveBeenCalled();
        expect(vpnRestartRequested(directory)).toBe(true);
    });
    it('refuses an unsafe restart when its host controller is unavailable', () => {
        jest.mocked(protectedVpnSession).mockReturnValue(true);
        delete process.env.IPTVNATOR_VPN_CONTROLLER_DIR;
        expect(() => requestAppRelaunch()).toThrow('Close and reopen');
        expect(app.relaunch).not.toHaveBeenCalled();
    });
});
