import type { SettingsSearchEntry } from './settings-search.types';
export const APP_VPN_SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
    {
        id: 'app-vpn-connection',
        section: 'general',
        labelKey: 'VPN.CONNECTION',
        descriptionKey: 'VPN.DESCRIPTION',
        keywords: ['nordvpn', 'vpn', 'wireguard', 'connection', 'public ip'],
        requires: ['app-vpn'],
    },
    {
        id: 'app-vpn-token',
        section: 'general',
        labelKey: 'VPN.TOKEN',
        descriptionKey: 'VPN.TOKEN_DESCRIPTION',
        keywords: ['nordvpn', 'vpn', 'access token', 'account'],
        requires: ['app-vpn'],
    },
    {
        id: 'app-vpn-server',
        section: 'general',
        labelKey: 'VPN.REGION',
        keywords: ['nordvpn', 'vpn', 'server', 'country', 'canada'],
        requires: ['app-vpn'],
    },
];
