import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { quoteVpnCommand } from './linux-vpn-policy';
import { runVpnHelper } from './linux-vpn-helper';

/** A late daemon launch must not open a viewer after cancellation. */
export function createVpnLaunchGuard(directory: string, args: string[]) {
    const permit = join(directory, 'launch.allowed');
    const script = join(directory, 'launch.sh');
    writeFileSync(permit, '', { mode: 0o600 });
    writeFileSync(
        script,
        `#!/bin/sh\n[ -f ${quoteVpnCommand([permit])} ] || exit 125\nexec ${quoteVpnCommand(args)}\n`,
        { mode: 0o600 }
    );
    return {
        args: ['/bin/sh', script],
        script,
        cancel: () => rmSync(permit, { force: true }),
        allowed: () => existsSync(permit),
    };
}

/** Stop only this launch: another player may already share the namespace. */
export async function stopVpnLaunch(
    namespace: string,
    script: string,
    stopped: () => boolean
): Promise<boolean> {
    const deadline = Date.now() + 20_000;
    do {
        try {
            const result = JSON.parse(
                await runVpnHelper(['list', 'namespaces', '--json'])
            );
            if (!Array.isArray(result.namespaces))
                throw new Error('Unknown helper state');
            const entry = result.namespaces.find(
                (value: { id?: string }) => value.id === namespace
            );
            if (entry && !Array.isArray(entry.applications))
                throw new Error('Unknown helper state');
            const owned = (entry?.applications ?? []).filter(
                (value: { argv?: unknown }) =>
                    Array.isArray(value.argv) && value.argv.includes(script)
            );
            if (stopped() && owned.length === 0) return true;
            for (const application of owned) {
                if (
                    Number.isSafeInteger(application.pid) &&
                    application.pid > 0
                )
                    await runVpnHelper([
                        'stop',
                        'application',
                        String(application.pid),
                        '--json',
                    ]);
            }
        } catch {
            /* Unknown cleanup state must never permit a host relaunch. */
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    return false;
}
