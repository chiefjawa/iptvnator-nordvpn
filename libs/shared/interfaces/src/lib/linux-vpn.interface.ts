/** Desktop Linux only. Account tokens never appear in status or saved settings. */
export interface LinuxVpnStatus {
    supported: boolean;
    helperAvailable: boolean;
    daemonAvailable: boolean;
    configured: boolean;
    enabled: boolean;
    connected: boolean;
    server: string;
}

export interface LinuxVpnConnectionRequest {
    enabled: boolean;
    server: string;
}
