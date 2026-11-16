/**
 * Opens a tile's live stream on the provider and closes it verifiably.
 *
 * `close()` resolves only when the response's socket has actually closed:
 * the scheduler waits for that before it may open the next connection, since
 * a provider that still counts the old one would refuse the new one.
 */

import { Readable } from 'node:stream';
import { XTREAM_CLIENT_USER_AGENT } from '@iptvnator/shared/interfaces';
import { requestWithValidatedRedirects } from '../../util/validated-axios';
import { OpenUpstream, UpstreamHandle } from './scheduler-types';

const CONNECT_TIMEOUT_MS = 15000;
const CLOSE_TIMEOUT_MS = 3000;

export const openTileUpstream: OpenUpstream = async (source, signal) => {
    const response = await requestWithValidatedRedirects<Readable>(
        source.url,
        {
            method: 'GET',
            responseType: 'stream',
            timeout: CONNECT_TIMEOUT_MS,
            signal,
            validateStatus: () => true,
            headers: {
                'User-Agent':
                    source.userAgent?.trim() || XTREAM_CLIENT_USER_AGENT,
                ...(source.referer?.trim()
                    ? { Referer: source.referer.trim() }
                    : {}),
                ...(source.origin?.trim()
                    ? { Origin: source.origin.trim() }
                    : {}),
            },
        },
        {
            allowPrivateNetworkRedirects: false,
            allowPrivateNetworks: true,
            pinAllowedPrivateNetworkHosts: true,
        }
    );

    const body = response.data;
    const ok = response.status >= 200 && response.status < 300;
    return toUpstreamHandle(response.status, body, ok);
};

export function toUpstreamHandle(
    status: number,
    body: Readable,
    ok: boolean
): UpstreamHandle {
    return {
        status,
        stream: ok ? body : null,
        close: () => closeStream(body),
    };
}

/** Destroys the response and waits until its socket is really closed. */
export async function closeStream(stream: Readable): Promise<void> {
    stream.removeAllListeners('data');
    // A late error after destroy must not surface as unhandled.
    stream.on('error', () => undefined);
    if (stream.closed) {
        return;
    }
    await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
        stream.once('close', () => {
            clearTimeout(timer);
            resolve();
        });
        stream.destroy();
    });
}
