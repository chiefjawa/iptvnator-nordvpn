/**
 * Wires the relay's parts together: the live relay, the VOD arbiter, the
 * Xtream front with its caches, the guide proxy and the status page. Used
 * by `main.ts` and by the end-to-end specs, which inject fake openers.
 */

import { normalizeXtreamServerUrl } from '@iptvnator/shared/interfaces';
import { MultiplexClock, OpenUpstream } from '../scheduler/scheduler-types';
import { LanRelay } from './lan-relay';
import { RelayConfig } from './relay-config';
import { RelayLogger } from './relay-log';
import { RelayStatus } from './relay-status';
import { VodArbiter, VodStatus } from './vod/vod-sessions';
import { OpenVod, openVodUpstream } from './vod/vod-upstream';
import { CacheClassStats, DiskCache } from './xtream/api-cache';
import {
    ProviderApi,
    ProviderApiStats,
    ProviderRequest,
} from './xtream/provider-api';
import { ProviderSanitizer } from './xtream/sanitize';
import { XmltvProxy } from './xtream/xmltv';
import { XtreamFront } from './xtream/xtream-front';

declare const RELAY_VERSION: string | undefined;
declare const RELAY_COMMIT: string | undefined;

export const RELAY_BUILD = {
    version: typeof RELAY_VERSION === 'string' ? RELAY_VERSION : 'dev',
    commit: typeof RELAY_COMMIT === 'string' ? RELAY_COMMIT : 'unknown',
};

export interface HttpCounters {
    unauthorized: number;
    notFound: number;
    m3u8Refused: number;
    errors: number;
}

export interface FullStatus extends RelayStatus {
    version: string;
    commit: string;
    vod: VodStatus;
    api: {
        cache: Record<string, CacheClassStats>;
        provider: ProviderApiStats;
        blankedProviderUrls: number;
    };
    http: HttpCounters;
    /** Every HTTP 503 answered, by reason. */
    refused503: {
        liveCapacity: number;
        liveWhileVod: number;
        vodWhileLive: number;
        vodBusy: number;
    };
}

export interface RelayAppDeps {
    readonly config: RelayConfig;
    readonly open: OpenUpstream;
    readonly openVod?: OpenVod;
    readonly request?: ProviderRequest;
    readonly clock?: MultiplexClock;
    readonly log?: RelayLogger;
    readonly vodLingerMs?: number;
    /** Wall clock for cache ages (tests move it forward). */
    readonly now?: () => number;
}

export class RelayApp {
    readonly relay: LanRelay;
    readonly vod: VodArbiter;
    readonly front: XtreamFront;
    readonly xmltv: XmltvProxy;
    readonly cache: DiskCache;
    readonly api: ProviderApi;
    readonly sanitizer: ProviderSanitizer;
    readonly http: HttpCounters = {
        unauthorized: 0,
        notFound: 0,
        m3u8Refused: 0,
        errors: 0,
    };

    constructor(readonly deps: RelayAppDeps) {
        const { config, log } = deps;
        const now = deps.now ?? Date.now;
        this.sanitizer = new ProviderSanitizer({
            hostnames: [
                new URL(normalizeXtreamServerUrl(config.serverUrl)).hostname,
            ],
            username: config.username.trim(),
            password: config.password.trim(),
        });
        this.cache = new DiskCache(
            config.cacheDir,
            config.cache.maxCacheMb * 1024 * 1024,
            now,
            (what) => log?.warn(what)
        );
        this.api = new ProviderApi(config, deps.request);
        let vod: VodArbiter | null = null;
        let front: XtreamFront | null = null;
        this.relay = new LanRelay({
            config,
            open: deps.open,
            clock: deps.clock,
            log,
            nameOf: (id) => front?.nameOf(id),
            vodActive: () => vod?.active ?? false,
            statusExtra: () => this.statusLine(),
        });
        const relay = this.relay;
        vod = new VodArbiter({
            gate: relay.gate,
            policy: config.vodPolicy,
            open: deps.openVod ?? openVodUpstream,
            log,
            lingerMs: deps.vodLingerMs,
            live: {
                hasClients: () => relay.clientCount > 0,
                dropIdleChannels: () => relay.dropIdleChannels(),
                suspendLive: () => relay.suspendLive(),
                resumeLive: () => relay.resumeLive(),
            },
        });
        this.vod = vod;
        front = new XtreamFront(
            config,
            this.api,
            this.cache,
            this.sanitizer,
            {
                activeConnections: () =>
                    relay.clientCount + (vod?.active ? 1 : 0),
            },
            log
        );
        this.front = front;
        this.xmltv = new XmltvProxy(
            this.api,
            this.cache,
            this.sanitizer,
            config.cache.xmltvTtlSec * 1000,
            log,
            now
        );
    }

    /** Starts the relay; the promise settles once the catalogue is warm. */
    start(): Promise<void> {
        this.relay.start();
        return this.deps.config.clients.length > 0
            ? this.front.warm()
            : Promise.resolve();
    }

    /** Ends VOD and live upstream connections first, then the clients. */
    async stop(): Promise<void> {
        await this.vod.stop();
        await this.relay.stop();
    }

    status(): FullStatus {
        const live = this.relay.status();
        const vod = this.vod.status();
        return {
            version: RELAY_BUILD.version,
            commit: RELAY_BUILD.commit,
            ...live,
            vod,
            api: {
                cache: this.cache.status(),
                provider: this.api.status(),
                blankedProviderUrls: this.sanitizer.blanked,
            },
            http: { ...this.http },
            refused503: {
                liveCapacity: live.refused.capacity,
                liveWhileVod: live.refused.vodActive,
                vodWhileLive: vod.refusedLive,
                vodBusy: vod.refusedBusy,
            },
        };
    }

    private statusLine(): string {
        const vod = this.vod.status();
        const api = this.api.status();
        const session = vod.session
            ? `${vod.session.label}${vod.session.streaming ? ':streaming' : ':idle'}`
            : 'none';
        return (
            `vod=${session} vodReq=${vod.requests} vodRefused=${vod.refusedLive}/${vod.refusedBusy}` +
            ` api=${api.requests}/${api.failures}fail http401=${this.http.unauthorized}`
        );
    }
}
