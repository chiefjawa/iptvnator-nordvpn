import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** No shell, token arguments, raw subprocess errors or diagnostic output at IPC. */
export async function runVpnHelper(
    args: string[],
    token?: string
): Promise<string> {
    const env = { ...process.env };
    delete env.NORDVPN_ACCESS_TOKEN;
    if (token) env.NORDVPN_ACCESS_TOKEN = token;
    try {
        const { stdout } = await execute('vopono', args, {
            env,
            timeout: token ? 120_000 : 10_000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
        });
        return stdout;
    } catch {
        throw new Error(
            token
                ? 'NordVPN setup failed. Check your access token and the VPN helper installation.'
                : 'VPN helper unavailable. Install the token-capable vopono helper and start its service.'
        );
    } finally {
        delete env.NORDVPN_ACCESS_TOKEN;
    }
}

export function daemonIsReady(document: unknown): boolean {
    const value = document as { available?: unknown; compatible?: unknown };
    return value?.available === true && value?.compatible === true;
}
