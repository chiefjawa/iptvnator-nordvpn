jest.mock('electron', () => ({
    app: {
        whenReady: jest.fn(),
        exit: jest.fn(),
        getPath: jest.fn(),
        relaunch: jest.fn(),
        on: jest.fn(),
    },
    dialog: { showMessageBox: jest.fn() },
    BrowserWindow: jest.fn(),
}));
jest.mock('node:child_process', () => ({ spawn: jest.fn() }));
jest.mock('../startup/login-shell-path', () => ({
    scheduleDeferredFixPath: jest.fn(),
    waitForLoginShellPath: jest.fn(async () => true),
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
import { readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { vpnNamespaceName } from './linux-vpn-policy';
import {
    scheduleDeferredFixPath,
    waitForLoginShellPath,
} from '../startup/login-shell-path';

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
            expect(scheduleDeferredFixPath).toHaveBeenCalledTimes(1);
            expect(waitForLoginShellPath).toHaveBeenCalledTimes(1);
            expect(
                jest.mocked(waitForLoginShellPath).mock.invocationCallOrder[0]
            ).toBeLessThan(
                jest.mocked(getLinuxVpnStatus).mock.invocationCallOrder[0]
            );
        });
        it('keeps the controller alive after success and ignores user helper defaults', async () => {
            jest.mocked(getLinuxVpnStatus).mockResolvedValue({
                enabled: true,
                configured: true,
                server: 'canada',
                supported: true,
                helperAvailable: true,
                daemonAvailable: true,
                connected: false,
            });
            const child = Object.assign(new EventEmitter(), {
                stdout: new EventEmitter(),
                kill: jest.fn(),
            });
            const progress = {
                loadURL: jest.fn(async () => undefined),
                on: jest.fn(),
                destroy: jest.fn(),
            };
            jest.mocked(BrowserWindow).mockImplementation(
                () => progress as unknown as BrowserWindow
            );
            jest.mocked(spawn).mockImplementation(() => {
                setImmediate(() =>
                    child.stdout.emit(
                        'data',
                        Buffer.from(
                            JSON.stringify({
                                version: 1,
                                event: 'launched',
                                pid: 123,
                                namespace: `${vpnNamespaceName('/tmp/test-profile')}-u${process.getuid?.()}`,
                            }) + '\n'
                        )
                    )
                );
                return child as unknown as ReturnType<typeof spawn>;
            });
            bootstrapLinuxVpn(jest.fn());
            await task;
            expect(app.on).toHaveBeenCalledWith(
                'window-all-closed',
                expect.any(Function)
            );
            expect(progress.destroy).toHaveBeenCalledTimes(1);
            expect(app.exit).not.toHaveBeenCalled();
            const args = jest.mocked(spawn).mock.calls[0][1] as string[];
            const helperConfig = args[args.indexOf('--vopono-config') + 1];
            expect(readFileSync(helperConfig, 'utf8')).toBe(
                'no_killswitch = false\n'
            );
            child.emit('close', 0);
            expect(app.exit).toHaveBeenCalledWith(0);
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
