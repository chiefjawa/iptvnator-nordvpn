import { inject, Injectable, OnDestroy } from '@angular/core';
import { Subject } from 'rxjs';
import { EpgItem } from '@iptvnator/shared/interfaces';
import {
    EpgPreferencesService,
    EpgSourceSettingsService,
    SettingsStore,
} from '@iptvnator/services';
import { XtreamApiService, XtreamCredentials } from './xtream-api.service';
import { XtreamXmltvFallbackService } from './xtream-xmltv-fallback.service';
import { firstProgramme, planNameMatches } from './epg-queue-name-plan.util';
import {
    applyManualEpgMappings,
    requestEpgPreviewWindow,
} from './epg-queue-requests.util';
import { createLogger } from '@iptvnator/portal/shared/util/logger';

interface CacheEntry {
    data: EpgItem[];
    timestamp: number;
    /** Name index an empty answer was reached under (`nameIndexKey`). */
    nameKey: string | null;
}

/**
 * Per-stream metadata supplied at enqueue time. The `epgChannelId` is the
 * key used to look the channel up in the locally-parsed XMLTV when the
 * Xtream provider returns no programs for that stream.
 */
export interface EpgQueueEntry {
    streamId: number;
    epgChannelId?: string | null;
    /** Owning playlist — required to resolve manual EPG mappings. */
    playlistId?: string | null;
    /**
     * Playlist channel name for the automatic XMLTV name match: the answer
     * for an entry without mapping and `epgChannelId`, the last resort for
     * one with an `epgChannelId`.
     */
    channelName?: string | null;
    /** Playlist category name, a country hint for the name match. */
    categoryName?: string | null;
}

/**
 * Throttled EPG request queue with concurrency control, inter-request
 * delay, and in-memory caching.  Prevents Xtream providers from
 * rate-limiting / banning the client when scrolling through large
 * channel lists.
 *
 * On each `enqueue()`, the service first batch-fetches the locally
 * parsed XMLTV current-program for every entry that has an
 * `epgChannelId` (one IPC, one SQL query). Hits are used immediately,
 * either as the answer (when `preferUploadedEpgOverXtream` is on) or as
 * a fallback when the per-stream Xtream API call returns no programs.
 *
 * Because the XMLTV pre-fetch is async, two overlapping `enqueue` calls
 * (e.g. fast viewport scroll) could otherwise interleave and let an
 * older call commit stale queue state. A generation counter gates every
 * shared-state write behind a "still latest" check so only the most
 * recent call's results are applied.
 *
 * Unmapped entries are also matched by name against the XMLTV channels
 * (`XtreamXmltvFallbackService.matchChannelNames`, an in-memory index);
 * the matched ids join the same batch IPC. For an entry without an
 * `epgChannelId` a matched programme is the answer, recorded at once and
 * kept even when a newer enqueue supersedes this one — no provider
 * request. Only entries with no XMLTV hit at all go to the provider, after
 * the entries with an `epgChannelId`. For an entry with one, the name
 * match is still the last resort after the provider.
 *
 * An empty answer is cached together with the name index it was reached
 * under; once a different index is ready, `getCached` no longer returns
 * it, so a name match that became available is not hidden for the TTL.
 */
@Injectable({ providedIn: 'root' })
export class EpgQueueService implements OnDestroy {
    private readonly apiService = inject(XtreamApiService);
    private readonly fallbackService = inject(XtreamXmltvFallbackService);
    private readonly settingsStore = inject(SettingsStore);
    private readonly epgPreferences = inject(EpgPreferencesService);
    private readonly sourceSubscription = inject(
        EpgSourceSettingsService
    ).changed$.subscribe(() => {
        this.enqueueGeneration++;
        this.queue = [];
        for (const id of new Set([
            ...this.cache.keys(),
            ...this.inFlight,
            ...this.visibleSet,
        ])) {
            this.invalidate(id);
            this.epgResult$.next({ streamId: id, items: [] });
        }
    });
    private readonly logger = createLogger('EpgQueueService');
    private readonly previewLimit = 3;

    private readonly cache = new Map<number, CacheEntry>();
    private queue: number[] = [];
    private readonly inFlight = new Set<number>();
    /** Bumped by invalidate() so a stale in-flight result is discarded. */
    private readonly invalidationEpoch = new Map<number, number>();
    private readonly epgChannelByStreamId = new Map<number, string>();
    private readonly xmltvPreviewByStreamId = new Map<number, EpgItem>();
    private readonly namePreviewByStreamId = new Map<number, EpgItem>();
    private visibleSet = new Set<number>();
    private processing = false;
    private enqueueGeneration = 0;
    private readonly failureTimestamps = new Map<number, number>();
    /** Display offset every per-stream memory below was recorded under. */
    private stateOffsetMinutes = this.epgOffsetMinutes();

    private readonly maxConcurrency = 2;
    private readonly delayMs = 200;
    private readonly cacheTtlMs = 5 * 60 * 1000; // 5 minutes
    private readonly failureCooldownMs = 60 * 1000;

    /** Emits EPG results as they arrive. */
    readonly epgResult$ = new Subject<{ streamId: number; items: EpgItem[] }>();

    getCached(streamId: number): EpgItem[] | null {
        if (!this.epgPreferences.enabled()) return null;
        this.retireStateOfPreviousOffset();
        const entry = this.cache.get(streamId);
        if (!entry) return null;
        if (
            Date.now() - entry.timestamp > this.cacheTtlMs ||
            (entry.data.length === 0 && !this.emptyStillValid(entry))
        ) {
            this.cache.delete(streamId);
            return null;
        }
        return entry.data;
    }

    private epgOffsetMinutes(): number {
        return this.settingsStore.resolvedEpgOffsetMinutes();
    }

    /**
     * Every per-stream memory here — cut windows, cached empty results and
     * failure cooldowns — answers "what is on at the provider clock", so a
     * changed display offset retires all of it at once instead of letting
     * one map or another keep steering the reload. Run on every entry point
     * (`enqueue`, `getCached`, `fetchEpg`); in-flight requests are retired by
     * `fetchEpg` itself when they land.
     */
    private retireStateOfPreviousOffset(): void {
        const current = this.epgOffsetMinutes();
        if (current === this.stateOffsetMinutes) {
            return;
        }
        this.stateOffsetMinutes = current;
        this.cache.clear();
        this.failureTimestamps.clear();
    }

    /**
     * Drop every cached artifact for a stream so the next enqueue refetches
     * it. Used when a manual EPG mapping for the stream changes, since the
     * cached preview/resolution was computed for the previous mapping.
     *
     * Also bumps an invalidation epoch and clears `inFlight`: a request that
     * was already running when the mapping changed carries the pre-change
     * resolution, so its result is discarded (epoch mismatch in `fetchEpg`)
     * and clearing `inFlight` lets the immediate re-enqueue schedule a fresh
     * fetch through the mapping-aware `enqueue()` path.
     */
    invalidate(streamId: number): void {
        this.cache.delete(streamId);
        this.failureTimestamps.delete(streamId);
        this.epgChannelByStreamId.delete(streamId);
        this.xmltvPreviewByStreamId.delete(streamId);
        this.namePreviewByStreamId.delete(streamId);
        this.inFlight.delete(streamId);
        this.invalidationEpoch.set(
            streamId,
            (this.invalidationEpoch.get(streamId) ?? 0) + 1
        );
    }

    private isFailureCoolingDown(streamId: number): boolean {
        const timestamp = this.failureTimestamps.get(streamId);
        if (timestamp == null) {
            return false;
        }

        if (Date.now() - timestamp > this.failureCooldownMs) {
            this.failureTimestamps.delete(streamId);
            return false;
        }

        return true;
    }

    private shouldFetch(streamId: number): boolean {
        return (
            this.epgPreferences.enabled() &&
            this.getCached(streamId) === null &&
            !this.isFailureCoolingDown(streamId) &&
            !this.inFlight.has(streamId)
        );
    }

    /**
     * Enqueue stream IDs for EPG fetching.
     *
     * Accepts the legacy `number[]` shape (without `epgChannelId`) for
     * backward compatibility — those entries skip the XMLTV fallback.
     */
    async enqueue(
        streams: ReadonlyArray<EpgQueueEntry | number>,
        visibleIds: Set<number>,
        credentials: XtreamCredentials
    ): Promise<void> {
        if (!this.epgPreferences.enabled()) return;
        this.retireStateOfPreviousOffset();
        const generation = ++this.enqueueGeneration;
        const offsetMinutes = this.stateOffsetMinutes;

        const normalized: EpgQueueEntry[] = streams.map((entry) =>
            typeof entry === 'number' ? { streamId: entry } : { ...entry }
        );
        const epochs = new Map(
            normalized.map((entry) => [entry.streamId, this.epochOf(entry)])
        );
        // Started now so the index load overlaps the mapping IPC.
        const names = normalized.some((entry) => entry.channelName?.trim())
            ? this.fallbackService.matchChannelNames(normalized)
            : null;

        // Resolve manual EPG mappings before building the per-EPG-id index.
        // When the user has right-clicked a channel and created a mapping,
        // the stored key is the playlist-scoped Xtream key, not the
        // provider's epg_channel_id.  By resolving upfront we get the
        // correct EPG channel ID for the XMLTV batch call that follows.
        // Guarded so environments without the bridge (PWA) skip the await
        // entirely and the enqueue keeps its original microtask timing.
        const mapped =
            typeof window.electron?.getEpgMappingsBatch === 'function'
                ? await applyManualEpgMappings(normalized, this.logger)
                : new Set<number>();

        const streamsByEpgId = new Map<string, number[]>();
        for (const entry of normalized) {
            const id = entry.epgChannelId?.trim();
            if (!id) continue;
            const list = streamsByEpgId.get(id) ?? [];
            list.push(entry.streamId);
            streamsByEpgId.set(id, list);
        }

        // Make the latest viewport visible to any currently running queue
        // before the async XMLTV prefetch returns, so stale queued provider
        // requests are dropped immediately on fast scroll.
        this.visibleSet = new Set(visibleIds);
        this.queue = [];

        const plan = planNameMatches(
            normalized,
            mapped,
            names ? await names : null
        );
        const batchResult = await this.fetchXmltvCurrentPure([
            ...new Set([...streamsByEpgId.keys(), ...plan.batchIds]),
        ]);

        // A name-matched programme for an entry without `epgChannelId` is
        // a fact about that stream, not queue state: record it even when a
        // newer enqueue superseded this one (fast scroll), unless the
        // stream or the display offset changed meanwhile.
        const resolved = new Set<number>();
        if (offsetMinutes === this.epgOffsetMinutes()) {
            for (const [streamId, ids] of plan.answers) {
                const item = firstProgramme(ids, batchResult);
                if (
                    !item ||
                    this.epochOf({ streamId }) !== epochs.get(streamId)
                )
                    continue;
                resolved.add(streamId);
                if (!this.hasCachedProgramme(streamId)) {
                    this.recordSuccess(streamId, [item]);
                }
            }
        }

        if (generation !== this.enqueueGeneration) return;

        // Atomic commit block — no awaits below.
        this.pruneEphemeralMaps(this.visibleSet);

        for (const entry of normalized) {
            const id = entry.epgChannelId?.trim();
            if (id) {
                this.epgChannelByStreamId.set(entry.streamId, id);
            } else {
                this.epgChannelByStreamId.delete(entry.streamId);
            }
            this.xmltvPreviewByStreamId.delete(entry.streamId);
            this.namePreviewByStreamId.delete(entry.streamId);
        }
        for (const [epgChannelId, item] of Object.entries(batchResult)) {
            const streams = streamsByEpgId.get(epgChannelId) ?? [];
            for (const streamId of streams) {
                this.xmltvPreviewByStreamId.set(streamId, item);
            }
        }
        for (const [streamId, ids] of plan.fallbacks) {
            const item = firstProgramme(ids, batchResult);
            if (item) this.namePreviewByStreamId.set(streamId, item);
        }

        const preferUploaded =
            this.settingsStore.preferUploadedEpgOverXtream?.() ?? false;

        // Entries with an `epgChannelId` (or a mapping) first; entries the
        // XMLTV knows nothing about last, so they cannot starve the rest.
        const ids: number[] = [];
        const unknown: number[] = [];
        for (const entry of normalized) {
            if (resolved.has(entry.streamId)) continue;
            if (!this.shouldFetch(entry.streamId)) continue;

            if (preferUploaded) {
                const xmltv = this.xmltvPreviewByStreamId.get(entry.streamId);
                if (xmltv) {
                    this.recordSuccess(entry.streamId, [xmltv]);
                    continue;
                }
            }

            (entry.epgChannelId?.trim() ? ids : unknown).push(entry.streamId);
        }

        this.queue = [...ids, ...unknown];

        if (!this.processing) {
            this.processQueue(credentials);
        }
    }

    /**
     * An empty answer stands only under the name index it was reached
     * under; one recorded before any index was ready stands under none.
     */
    private emptyStillValid(entry: CacheEntry): boolean {
        return (
            entry.nameKey !== null &&
            entry.nameKey === this.fallbackService.nameIndexKey()
        );
    }

    private epochOf(entry: { streamId: number }): number {
        return this.invalidationEpoch.get(entry.streamId) ?? 0;
    }

    /** A cached, non-empty answer is never replaced by a name match. */
    private hasCachedProgramme(streamId: number): boolean {
        return (this.getCached(streamId)?.length ?? 0) > 0;
    }

    /**
     * Pure XMLTV batch fetch. Runs the IPC and returns the result without
     * mutating any shared state — keeping the await out of the commit
     * path so an older overlapping enqueue cannot pollute the maps after
     * a newer one has already committed.
     */
    private async fetchXmltvCurrentPure(
        epgChannelIds: ReadonlyArray<string>
    ): Promise<Record<string, EpgItem>> {
        if (epgChannelIds.length === 0) return {};
        return this.fallbackService.getCurrentProgramsBatch(epgChannelIds);
    }

    private pruneEphemeralMaps(visibleIds: Set<number>): void {
        for (const id of new Set([
            ...this.epgChannelByStreamId.keys(),
            ...this.namePreviewByStreamId.keys(),
        ])) {
            // getCached() honors TTL and lazily evicts expired entries;
            // a raw cache.has() would keep stale previews alive forever.
            if (!visibleIds.has(id) && this.getCached(id) === null) {
                this.epgChannelByStreamId.delete(id);
                this.xmltvPreviewByStreamId.delete(id);
                this.namePreviewByStreamId.delete(id);
            }
        }
    }

    private async processQueue(credentials: XtreamCredentials): Promise<void> {
        this.processing = true;

        while (this.queue.length > 0) {
            if (this.inFlight.size >= this.maxConcurrency) {
                await this.delay(this.delayMs);
                continue;
            }

            const streamId = this.queue.shift();
            if (streamId == null) {
                continue;
            }

            if (!this.visibleSet.has(streamId)) continue;
            if (!this.shouldFetch(streamId)) continue;

            this.inFlight.add(streamId);
            this.fetchEpg(credentials, streamId);

            await this.delay(this.delayMs);
        }

        this.processing = false;
    }

    private async fetchEpg(
        credentials: XtreamCredentials,
        streamId: number
    ): Promise<void> {
        const startEpoch = this.invalidationEpoch.get(streamId) ?? 0;
        const isStale = (): boolean =>
            (this.invalidationEpoch.get(streamId) ?? 0) !== startEpoch;
        // Captured before the request so the result can be told apart from
        // the offset current when it lands.
        this.retireStateOfPreviousOffset();
        const offsetMinutes = this.epgOffsetMinutes();
        const outcome = await requestEpgPreviewWindow(
            this.apiService,
            credentials,
            streamId,
            offsetMinutes,
            this.previewLimit
        );
        try {
            // A mapping change during the request invalidated this result.
            if (isStale()) {
                return;
            }

            // The setting changed while the request was on the wire, so this
            // window — or its failure — belongs to the previous provider
            // clock. The reload the change triggered skipped the stream
            // because it was in flight, so retire the request whatever its
            // outcome and fetch again if the row is still visible.
            if (offsetMinutes !== this.epgOffsetMinutes()) {
                this.supersedeForOffsetChange(
                    credentials,
                    streamId,
                    startEpoch
                );
                return;
            }

            if ('error' in outcome) {
                this.failureTimestamps.set(streamId, Date.now());
                this.logger.error(
                    `Failed to load EPG for stream ${streamId}`,
                    outcome.error
                );
                return;
            }

            if (outcome.items.length > 0) {
                this.recordSuccess(streamId, outcome.items);
                return;
            }

            // `epgChannelId` XMLTV first, the name match last.
            const xmltv =
                this.xmltvPreviewByStreamId.get(streamId) ??
                this.namePreviewByStreamId.get(streamId);
            this.recordSuccess(streamId, xmltv ? [xmltv] : []);
        } finally {
            // Only release the in-flight marker if this request still owns it.
            // When invalidate() cleared it mid-flight, a later re-enqueue may
            // already have started a new request for the same stream; an
            // unconditional delete here would drop that request's marker and
            // let a third concurrent fetch start.
            if (!isStale()) {
                this.inFlight.delete(streamId);
            }
        }
    }

    /**
     * Retire the in-flight request of `streamId` whose window predates an
     * offset change and queue a fresh fetch. Bumping the epoch first makes the
     * old request's `finally` leave the marker alone, so the replacement it
     * starts here cannot lose its own in-flight marker.
     */
    private supersedeForOffsetChange(
        credentials: XtreamCredentials,
        streamId: number,
        epoch: number
    ): void {
        this.invalidationEpoch.set(streamId, epoch + 1);
        this.inFlight.delete(streamId);
        if (!this.visibleSet.has(streamId) || this.queue.includes(streamId)) {
            return;
        }
        this.queue.push(streamId);
        if (!this.processing) {
            this.processQueue(credentials);
        }
    }

    private recordSuccess(streamId: number, items: EpgItem[]): void {
        const previous = this.cache.get(streamId)?.data;
        this.cache.set(streamId, {
            data: items,
            timestamp: Date.now(),
            nameKey: this.fallbackService.nameIndexKey(),
        });
        this.failureTimestamps.delete(streamId);

        if (previous && previous.length === 0 && items.length === 0) {
            return;
        }
        this.epgResult$.next({ streamId, items });
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    ngOnDestroy(): void {
        this.sourceSubscription.unsubscribe();
        this.epgResult$.complete();
    }
}
