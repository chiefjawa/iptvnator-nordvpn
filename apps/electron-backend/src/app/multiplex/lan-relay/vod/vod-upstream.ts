/**
 * Opens a movie, episode or catch-up byte range on the provider.
 *
 * The request carries the client's Range/If-Range and follows redirects
 * under the same validated host policy as the live opener. Only a fixed
 * set of response headers is ever passed back to the client, so no
 * provider address, cookie or redirect target can reach it.
 */

import { IncomingHttpHeaders } from 'node:http';
import { Readable } from 'node:stream';
import { XTREAM_CLIENT_USER_AGENT } from '@iptvnator/shared/interfaces';
import { requestWithValidatedRedirects } from '../../../util/validated-axios';

const CONNECT_TIMEOUT_MS = 20_000;

/** Headers a client may see from a byte-range answer. */
export const PASSED_HEADERS = [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'last-modified',
    'etag',
] as const;

export interface VodUpstreamRequest {
    readonly url: string;
    readonly method: 'GET' | 'HEAD';
    readonly range?: string;
    readonly ifRange?: string;
    readonly userAgent?: string;
}

export interface VodUpstreamResponse {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    /** Null for HEAD and error statuses (already drained). */
    readonly body: Readable | null;
    /** Destroys the response; resolves once its socket closed. */
    close(): Promise<void>;
}

export type OpenVod = (
    request: VodUpstreamRequest,
    signal: AbortSignal
) => Promise<VodUpstreamResponse>;

export const openVodUpstream: OpenVod = async (request, signal) => {
    const response = await requestWithValidatedRedirects<Readable>(
        request.url,
        {
            method: request.method,
            responseType: 'stream',
            timeout: CONNECT_TIMEOUT_MS,
            signal,
            decompress: false,
            validateStatus: () => true,
            headers: {
                'User-Agent':
                    request.userAgent?.trim() || XTREAM_CLIENT_USER_AGENT,
                // No pooled socket may outlive the transfer.
                Connection: 'close',
                ...(request.range ? { Range: request.range } : {}),
                ...(request.ifRange ? { 'If-Range': request.ifRange } : {}),
            },
        },
        {
            allowPrivateNetworkRedirects: false,
            allowPrivateNetworks: true,
            pinAllowedPrivateNetworkHosts: true,
        }
    );
    const stream = response.data;
    const ok = response.status >= 200 && response.status < 300;
    return {
        status: response.status,
        headers: pickHeaders(response.headers as IncomingHttpHeaders),
        body: ok && request.method === 'GET' ? stream : null,
        close: () => closeReadable(stream),
    };
};

export function pickHeaders(
    headers: IncomingHttpHeaders | Record<string, unknown>
): Record<string, string> {
    const picked: Record<string, string> = {};
    for (const name of PASSED_HEADERS) {
        const value = (headers as Record<string, unknown>)[name];
        if (typeof value === 'string' && value.length < 512) {
            picked[name] = value;
        } else if (typeof value === 'number') {
            picked[name] = String(value);
        }
    }
    return picked;
}

/** Destroys a response and waits until its socket is really closed. */
export async function closeReadable(stream: Readable): Promise<void> {
    stream.on('error', () => undefined);
    if (stream.closed) {
        return;
    }
    await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        stream.once('close', () => {
            clearTimeout(timer);
            resolve();
        });
        if (!stream.destroyed) {
            stream.destroy();
        }
    });
}
