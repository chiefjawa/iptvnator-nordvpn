import { ipcMain } from 'electron';
import {
    configureLinuxVpn,
    getLinuxVpnStatus,
    changeLinuxVpn,
} from '../services/linux-vpn.service';
import type { LinuxVpnConnectionRequest } from '@iptvnator/shared/interfaces';

export function registerLinuxVpnEvents(): void {
    ipcMain.handle('VPN:STATUS', () => getLinuxVpnStatus());
    ipcMain.handle(
        'VPN:CONFIGURE',
        (_event, payload: { token?: unknown } | null) =>
            configureLinuxVpn(payload?.token)
    );
    ipcMain.handle(
        'VPN:CONNECT',
        (_event, request: LinuxVpnConnectionRequest) => changeLinuxVpn(request)
    );
}
