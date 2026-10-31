import { statSync } from 'node:fs';
import { createHash } from 'node:crypto';

export interface LinuxVpnConfig {
    enabled: boolean;
    configured: boolean;
    server: string;
}

export const DEFAULT_LINUX_VPN: LinuxVpnConfig = {
    enabled: false,
    configured: false,
    server: 'canada',
};

export function normalizeVpnConfig(value: unknown): LinuxVpnConfig {
    if (
        value !== undefined &&
        (!value || typeof value !== 'object' || Array.isArray(value))
    ) {
        throw new Error('Invalid VPN settings.');
    }
    const input = value as Partial<LinuxVpnConfig> | undefined;
    if (
        (input?.enabled !== undefined && typeof input.enabled !== 'boolean') ||
        (input?.configured !== undefined &&
            typeof input.configured !== 'boolean') ||
        (input?.server !== undefined && !validVpnServer(input.server))
    ) {
        throw new Error('Invalid VPN settings.');
    }
    return {
        enabled: input?.enabled === true,
        configured: input?.configured === true,
        server: validVpnServer(input?.server) ? input.server : 'canada',
    };
}

export function validVpnServer(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value)
    );
}

export function vpnNamespaceName(profile: string): string {
    return `iptvnator-${createHash('sha256').update(profile).digest('hex').slice(0, 10)}`;
}

/** Environment flags alone must never make an ordinary process look protected. */
export function inVpnNamespace(
    namespace: string,
    env: NodeJS.ProcessEnv = process.env,
    inode: (path: string) => number = (path) => statSync(path).ino
): boolean {
    const owned = `${namespace}-u${process.getuid?.()}`;
    if (process.platform !== 'linux' || env.VOPONO_NS !== owned) return false;
    try {
        const host = Number(env.IPTVNATOR_VPN_HOST_NETNS);
        if (!Number.isSafeInteger(host) || host <= 0) return false;
        const current = inode('/proc/self/ns/net');
        return current === inode(`/run/netns/${owned}`) && current !== host;
    } catch {
        return false;
    }
}

/** vopono accepts one shell command; quote every argument, including playlist URLs. */
export function quoteVpnCommand(args: string[]): string {
    return args.map((arg) => `'${arg.replace(/'/g, `'\\''`)}'`).join(' ');
}

export function vpnLaunchArguments(
    server: string,
    namespace: string,
    args: string[]
): string[] {
    if (!validVpnServer(server))
        throw new Error('Invalid VPN server selection.');
    return [
        'exec',
        '--provider',
        'nordvpn',
        '--protocol',
        'wireguard',
        '--server',
        server,
        '--custom-netns-name',
        namespace,
        '--json',
        quoteVpnCommand(args),
    ];
}
