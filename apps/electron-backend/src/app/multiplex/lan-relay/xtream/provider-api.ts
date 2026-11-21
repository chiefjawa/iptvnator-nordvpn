/**
 * Requests to the provider's panel API (`player_api.php`, `xmltv.php`).
 *
 * These are not stream connections on Xtream panels, so they do not pass
 * the stream gate, but they are kept polite: at most two run at once and
 * the rest wait their turn. Redirects are followed under the same policy
 * as the live opener. Errors carry a status or a code, never the URL.
 */

import { Readable } from 'node:stream';
import { XTREAM_CLIENT_USER_AGENT } from '@iptvnator/shared/interfaces';
import { requestWithValidatedRedirects } from '../../../util/validated-axios';
import { buildProviderQueryUrl, RelayConfig } from '../relay-config';
import { errorKind } from '../upstream-guard';

const API_TIMEOUT_MS = 60_000;
const MAX_API_BYTES = 256 * 1024 * 1024;

export class ProviderRequestError extends Error {
    constructor(readonly kind: string) {
        super(`provider request failed (${kind})`);
    }
}

export type ProviderRequest = typeof requestWithValidatedRedirects;

export interface ProviderApiStats {
    requests: number;
    failures: number;
    inFlight: number;
    queued: number;
}

/** A counting semaphore. */
export class Limiter {
    private active = 0;
    private readonly queue: (() => void)[] = [];

    constructor(private readonly max: number) {}

    get inFlight(): number {
        return this.active;
    }

    get waiting(): number {
        return this.queue.length;
    }

    async run<T>(task: () => Promise<T>): Promise<T> {
        if (this.active >= this.max) {
            await new Promise<void>((resolve) => this.queue.push(resolve));
        } else {
            this.active += 1;
        }
        try {
            return await task();
        } finally {
            const next = this.queue.shift();
            if (next) {
                next();
            } else {
                this.active -= 1;
            }
        }
    }
}

export class ProviderApi {
    private readonly limiter = new Limiter(2);
    private readonly stats = { requests: 0, failures: 0 };

    constructor(
        private readonly config: RelayConfig,
        private readonly request: ProviderRequest = requestWithValidatedRedirects
    ) {}

    /** `player_api.php` with the real account and `params`; parsed JSON. */
    async playerApi(
        params: Readonly<Record<string, string>>
    ): Promise<unknown> {
        const body = await this.fetchBuffer('player_api.php', params);
        try {
            return JSON.parse(body.toString('utf8'));
        } catch {
            throw new ProviderRequestError('not-json');
        }
    }

    /**
     * `xmltv.php` as a stream, decoded (axios undoes gzip/deflate), so the
     * caller can scrub it. The slot is held until the stream ends.
     */
    async xmltv(): Promise<Readable> {
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => (release = resolve));
        let started!: (stream: Readable) => void;
        let failed!: (error: unknown) => void;
        const result = new Promise<Readable>((resolve, reject) => {
            started = resolve;
            failed = reject;
        });
        void this.limiter
            .run(async () => {
                const stream = await this.send<Readable>(
                    'xmltv.php',
                    {},
                    'stream'
                );
                stream.once('close', release);
                started(stream);
                await held;
            })
            .catch((error) => failed(error));
        return result;
    }

    status(): ProviderApiStats {
        return {
            ...this.stats,
            inFlight: this.limiter.inFlight,
            queued: this.limiter.waiting,
        };
    }

    private fetchBuffer(
        file: string,
        params: Readonly<Record<string, string>>
    ): Promise<Buffer> {
        return this.limiter.run(async () =>
            Buffer.from(
                await this.send<ArrayBuffer>(file, params, 'arraybuffer')
            )
        );
    }

    private async send<T>(
        file: string,
        params: Readonly<Record<string, string>>,
        responseType: 'arraybuffer' | 'stream'
    ): Promise<T> {
        this.stats.requests += 1;
        let response;
        try {
            response = await this.request<T>(
                buildProviderQueryUrl(this.config, file, params),
                {
                    method: 'GET',
                    responseType,
                    timeout: API_TIMEOUT_MS,
                    maxContentLength: MAX_API_BYTES,
                    validateStatus: () => true,
                    headers: {
                        'User-Agent':
                            this.config.userAgent?.trim() ||
                            XTREAM_CLIENT_USER_AGENT,
                        'Accept-Encoding': 'gzip, deflate',
                    },
                },
                {
                    allowPrivateNetworkRedirects: false,
                    allowPrivateNetworks: true,
                    pinAllowedPrivateNetworkHosts: true,
                }
            );
        } catch (error) {
            this.stats.failures += 1;
            throw new ProviderRequestError(errorKind(error));
        }
        if (response.status < 200 || response.status >= 300) {
            this.stats.failures += 1;
            if (responseType === 'stream') {
                (response.data as unknown as Readable).destroy();
            }
            throw new ProviderRequestError(`HTTP ${response.status}`);
        }
        return response.data;
    }
}
