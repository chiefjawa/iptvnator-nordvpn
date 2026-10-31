import { net } from 'electron';
import { isIP } from 'node:net';

let cached: { ip?: string; expires: number } | undefined;
let pending: Promise<string | undefined> | undefined;

/** Runs in the verified player's namespace; never sends account credentials. */
export async function getVpnPublicIp(): Promise<string | undefined> {
    if (cached && cached.expires > Date.now()) return cached.ip;
    if (pending) return pending;
    pending = (async () => {
        let ip: string | undefined;
        try {
            const response = await net.fetch(
                'https://api.ipify.org?format=json',
                {
                    signal: AbortSignal.timeout(5000),
                    credentials: 'omit',
                    cache: 'no-store',
                }
            );
            if (!response.ok) throw new Error('IP check unavailable');
            const reader = response.body?.getReader();
            if (!reader) throw new Error('IP check unavailable');
            let body = '';
            try {
                for (;;) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    body += new TextDecoder().decode(chunk.value);
                    if (body.length > 1024)
                        throw new Error('IP response too large');
                }
                const value = JSON.parse(body).ip;
                if (typeof value === 'string' && isIP(value)) ip = value;
            } finally {
                await reader.cancel();
            }
        } catch {
            /* Keep protection active; IP lookup failure is not a fallback. */
        }
        cached = { ip, expires: Date.now() + (ip ? 30_000 : 5000) };
        return ip;
    })().finally(() => {
        pending = undefined;
    });
    return pending;
}
