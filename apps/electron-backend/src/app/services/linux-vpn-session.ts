import { app } from 'electron';
import { inVpnNamespace, vpnNamespaceName } from './linux-vpn-policy';

/** Pure session detection: importing a playback owner never loads the VPN CLI. */
export function protectedVpnSession(): boolean {
    if (process.platform !== 'linux' || !process.env.VOPONO_NS) return false;
    return inVpnNamespace(vpnNamespaceName(app.getPath('userData')));
}
