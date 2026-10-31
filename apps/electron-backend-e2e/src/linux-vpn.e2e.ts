import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    test,
    expect,
    launchElectronApp,
    closeElectronApp,
    openSettings,
    saveSettings,
    electronMainPath,
} from './electron-test-fixtures';

test.describe('Linux app-only VPN', () => {
    test.skip(process.platform !== 'linux', 'App VPN is Linux only');
    test('announces a verified connection and shows its public IP in settings', async ({
        dataDir,
    }) => {
        const entryPoint = join(dataDir, 'vpn-status-fixture.cjs');
        writeFileSync(
            entryPoint,
            `
            const {ipcMain}=require('electron');
            const handle=ipcMain.handle.bind(ipcMain);
            ipcMain.handle=(channel,listener)=>handle(channel,channel==='VPN:STATUS'
                ? ()=>({supported:true,helperAvailable:true,daemonAvailable:true,
                    configured:true,enabled:true,connected:true,server:'canada',publicIp:'203.0.113.7'})
                : listener);
            require(${JSON.stringify(electronMainPath)});
        `
        );
        const player = await launchElectronApp(dataDir, {
            entryPoint,
            args: ['--ozone-platform=x11', '--disable-gpu'],
        });
        try {
            await expect(
                player.mainWindow.getByText(
                    "NordVPN connected. Your app's public IP is 203.0.113.7.",
                    { exact: true }
                )
            ).toBeVisible();
            await openSettings(player.mainWindow);
            await expect(
                player.mainWindow.getByTestId('vpn-status')
            ).toHaveText('Connected to NordVPN');
            await expect(
                player.mainWindow.getByTestId('vpn-public-ip')
            ).toHaveText('203.0.113.7');
        } finally {
            await closeElectronApp(player);
        }
    });
    test('sets up an account through the real bridge without persisting its token', async ({
        dataDir,
    }) => {
        const binaryDir = join(dataDir, 'vpn-test-bin');
        mkdirSync(binaryDir);
        const binary = join(binaryDir, 'vopono');
        writeFileSync(
            binary,
            '#!/bin/sh\ncase "$1" in\n--version) echo "vopono fixture";;\ndaemon) echo \'{"available":true,"compatible":true}\';;\nsync) test "$NORDVPN_ACCESS_TOKEN" = "SYNTHETIC_TEST_TOKEN_123456789" || exit 1; echo \'{"version":1,"success":true}\';;\n*) exit 1;;\nesac\n'
        );
        chmodSync(binary, 0o700);
        const player = await launchElectronApp(dataDir, {
            args: ['--ozone-platform=x11', '--disable-gpu'],
        });
        try {
            // Override after the app's deferred login-shell PATH hydration.
            await player.electronApp.evaluate((_, path) => {
                process.env['PATH'] = path + ':' + process.env['PATH'];
            }, binaryDir);
            await openSettings(player.mainWindow);
            await expect(
                player.mainWindow.getByTestId('vpn-settings')
            ).toBeVisible();
            const status = player.mainWindow.getByTestId('vpn-status');
            await expect(status).toHaveText('App VPN is off');
            const token = player.mainWindow.getByTestId('vpn-token');
            await expect(token).toHaveAttribute('type', 'password');
            await token.fill('SYNTHETIC_TEST_TOKEN_123456789');
            const setup = player.mainWindow.getByTestId('vpn-save-token');
            await expect(setup).toBeEnabled({ timeout: 15000 });
            await setup.click();
            await expect(token).toHaveValue('');
            await expect(
                player.mainWindow.getByTestId('vpn-connect')
            ).toBeEnabled();
            const saved = readFileSync(
                join(dataDir, 'user-data', 'linux-vpn.json'),
                'utf8'
            );
            expect(JSON.parse(saved)).toEqual({
                enabled: false,
                configured: true,
                server: 'canada',
            });
            expect(saved).not.toContain('SYNTHETIC_TEST_TOKEN');
            await expect(status).toHaveText('App VPN is off');
            const artifacts = join(
                process.cwd(),
                'dist/test-artifacts/linux-vpn'
            );
            mkdirSync(artifacts, { recursive: true });
            for (const theme of ['LIGHT_THEME', 'DARK_THEME']) {
                await player.mainWindow
                    .getByTestId('select-theme')
                    .getByTestId(theme)
                    .click();
                await expect(
                    player.mainWindow.getByTestId('vpn-connect')
                ).toBeDisabled();
                await saveSettings(player.mainWindow);
                await expect(
                    player.mainWindow.getByTestId('vpn-connect')
                ).toBeEnabled();
                await expect(
                    player.mainWindow.locator('.settings-snackbar')
                ).toHaveCount(0);
                await player.mainWindow
                    .getByTestId('vpn-settings')
                    .screenshot({ path: join(artifacts, theme + '.png') });
            }
        } finally {
            await closeElectronApp(player);
        }
    });
});
