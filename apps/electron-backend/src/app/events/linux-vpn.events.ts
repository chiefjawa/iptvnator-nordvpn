import { ipcMain } from 'electron';
import {
    configureLinuxVpn,
    getLinuxVpnStatus,
    changeLinuxVpn,
} from '../services/linux-vpn.service';
import type { LinuxVpnConnectionRequest } from '@iptvnator/shared/interfaces';
import type { WindowCloseGuard } from '../services/window-close-guard.service';

export function registerLinuxVpnEvents(
    guard: Pick<WindowCloseGuard, 'requestQuit'>
): void {
    ipcMain.handle('VPN:STATUS', () => getLinuxVpnStatus());
    ipcMain.handle(
        'VPN:CONFIGURE',
        (_event, payload: { token?: unknown } | null) =>
            configureLinuxVpn(payload?.token)
    );
    ipcMain.handle(
        'VPN:CONNECT',
        (_event, request: LinuxVpnConnectionRequest) =>
            changeLinuxVpn(request, (commit) => guard.requestQuit(commit))
    );
}
