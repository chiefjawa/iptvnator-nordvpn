jest.mock('electron', () => ({
    app: {
        whenReady: jest.fn(),
        exit: jest.fn(),
        getPath: jest.fn(),
        relaunch: jest.fn(),
    },
    dialog: { showMessageBox: jest.fn() },
    BrowserWindow: jest.fn(),
}));
jest.mock('./linux-vpn.service', () => ({
    readVpnConfig: jest.fn(),
    protectedVpnSession: jest.fn(),
    getLinuxVpnStatus: jest.fn(),
    writeVpnConfig: jest.fn(),
}));
import { app, BrowserWindow, dialog } from 'electron';
import {
    getLinuxVpnStatus,
    protectedVpnSession,
    readVpnConfig,
    writeVpnConfig,
} from './linux-vpn.service';
import { bootstrapLinuxVpn } from './linux-vpn-startup';
import { rmSync } from 'node:fs';

(process.platform === 'linux' ? describe : describe.skip)(
    'VPN startup gate',
    () => {
        let task: Promise<unknown> | undefined;
        beforeEach(() => {
            jest.clearAllMocks();
            task = undefined;
            jest.mocked(app.whenReady).mockImplementation(
                () =>
                    ({
                        then: (callback: () => unknown) => {
                            task = Promise.resolve().then(callback);
                            return task;
                        },
                    }) as Promise<void>
            );
            jest.mocked(readVpnConfig).mockReturnValue({
                enabled: true,
                configured: true,
                server: 'canada',
            });
            jest.mocked(protectedVpnSession).mockReturnValue(false);
            jest.mocked(app.getPath).mockReturnValue('/tmp/test-profile');
            jest.mocked(getLinuxVpnStatus).mockRejectedValue(
                new Error('helper offline')
            );
            jest.mocked(dialog.showMessageBox).mockResolvedValue({
                response: 0,
                checkboxChecked: false,
            });
            // The gate selects a separate Chromium session directory before ready.
            Object.assign(app, { setPath: jest.fn() });
        });
        afterEach(() => {
            const calls = jest.mocked(app.setPath).mock.calls;
            for (const [key, path] of calls)
                if (key === 'sessionData')
                    rmSync(path, { recursive: true, force: true });
        });
        it('does not create a viewing window or start player requests if the helper fails', async () => {
            const start = jest.fn();
            bootstrapLinuxVpn(start);
            await task;
            expect(start).not.toHaveBeenCalled();
            expect(BrowserWindow).not.toHaveBeenCalled();
            expect(app.exit).toHaveBeenCalledWith(1);
            expect(writeVpnConfig).not.toHaveBeenCalled();
        });
        it('requires an explicit user choice before disabling protection and opening normally', async () => {
            jest.mocked(dialog.showMessageBox).mockResolvedValue({
                response: 1,
                checkboxChecked: false,
            });
            const start = jest.fn();
            bootstrapLinuxVpn(start);
            await task;
            expect(writeVpnConfig).toHaveBeenCalledWith({
                enabled: false,
                configured: true,
                server: 'canada',
            });
            expect(start).not.toHaveBeenCalled();
            expect(app.relaunch).toHaveBeenCalledTimes(1);
            expect(app.exit).toHaveBeenCalledWith(0);
        });
        it('starts directly when protection is off or the real managed namespace is verified', () => {
            const start = jest.fn();
            jest.mocked(readVpnConfig).mockReturnValue({
                enabled: false,
                configured: false,
                server: 'canada',
            });
            bootstrapLinuxVpn(start);
            expect(start).toHaveBeenCalledTimes(1);
            jest.mocked(readVpnConfig).mockReturnValue({
                enabled: true,
                configured: true,
                server: 'canada',
            });
            jest.mocked(protectedVpnSession).mockReturnValue(true);
            bootstrapLinuxVpn(start);
            expect(start).toHaveBeenCalledTimes(2);
            expect(app.whenReady).not.toHaveBeenCalled();
        });
        it('keeps corrupt saved protection closed rather than starting normally', async () => {
            jest.mocked(readVpnConfig).mockImplementation(() => {
                throw new Error('broken policy');
            });
            const start = jest.fn();
            bootstrapLinuxVpn(start);
            await task;
            expect(start).not.toHaveBeenCalled();
            expect(app.exit).toHaveBeenCalledWith(1);
        });
    }
);
