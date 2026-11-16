import { protectedVpnSession } from '../services/linux-vpn-session';
import { store } from '../services/store.service';

/**
 * App-VPN policy for a fresh external-player launch. A Flatpak host spawn
 * would leave the protected network namespace, so it is refused; reuse could
 * hand the stream to an instance running outside the namespace, so a
 * protected session always reports the saved reuse preference as off.
 */
export function vpnReuse(isFlatpak: boolean, reuseKey: string): boolean {
    if (isFlatpak && protectedVpnSession())
        throw new Error('Use the built-in player while app VPN is on.');
    return (
        !protectedVpnSession() && store.get(reuseKey, false as boolean) === true
    );
}
