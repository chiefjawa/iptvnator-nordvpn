import { inject, Injectable } from '@angular/core';
import {
    EpgItem,
    EpgProgram,
    epgProviderClockMs,
} from '@iptvnator/shared/interfaces';
import { createLogger } from '@iptvnator/portal/shared/util/logger';
import {
    EpgPreferencesService,
    EpgSourceSettingsService,
    SettingsStore,
} from '@iptvnator/services';
import { XtreamEpgNameIndexService } from './xtream-epg-name-index.service';
import type { EpgNameMatch, EpgNameMatchHint } from './epg-name-match.util';

type ElectronEpgBridge = {
    getChannelPrograms?: (
        channelId: string,
        options: { rejectOnError: boolean }
    ) => Promise<EpgProgram[]>;
    getCurrentProgramsBatch?: (
        channelIds: string[],
        options?: { nowMs?: number }
    ) => Promise<Record<string, EpgProgram | null>>;
};

@Injectable({ providedIn: 'root' })
export class XtreamXmltvFallbackService {
    private readonly logger = createLogger('XtreamXmltvFallback');
    private readonly settingsStore = inject(SettingsStore);
    private readonly sources = inject(EpgSourceSettingsService);
    private readonly preferences = inject(EpgPreferencesService);
    private readonly nameIndex = inject(XtreamEpgNameIndexService);

    /**
     * `DataService.isElectron` is intentionally not consulted here: it
     * checks `window.process?.type`, which contextBridge isolation hides
     * from the renderer. Each method below gates on the specific bridge
     * function it needs, so a partial preload (e.g. `getChannelPrograms`
     * present but `getCurrentProgramsBatch` missing) only disables the
     * affected path.
     */
    private get bridge(): ElectronEpgBridge | null {
        if (typeof window === 'undefined') return null;
        const candidate = (
            window as unknown as { electron?: ElectronEpgBridge }
        ).electron;
        return candidate ?? null;
    }

    /**
     * Returns the full schedule for a channel from local XMLTV, mapped into
     * the `EpgItem` shape the Xtream UI consumes. Returns `[]` when nothing
     * is found or the bridge function is unavailable.
     */
    async getProgramsForChannel(
        epgChannelId: string | null | undefined
    ): Promise<EpgItem[]> {
        if (!this.preferences.enabled()) return [];
        const revision = this.sources.revision();
        const id = (epgChannelId ?? '').trim();
        if (!id) return [];

        const fn = this.bridge?.getChannelPrograms;
        if (typeof fn !== 'function') return [];

        const programs = await fn.call(this.bridge, id, {
            rejectOnError: true,
        });
        if (revision !== this.sources.revision()) return [];
        return programs.map((p) => mapEpgProgramToEpgItem(p, id));
    }

    async getCurrentProgramsBatch(
        epgChannelIds: ReadonlyArray<string | null | undefined>
    ): Promise<Record<string, EpgItem>> {
        if (!this.preferences.enabled()) return {};
        const revision = this.sources.revision();
        const fn = this.bridge?.getCurrentProgramsBatch;
        if (typeof fn !== 'function') return {};

        const ids = Array.from(
            new Set(
                epgChannelIds
                    .map((id) => (id ?? '').trim())
                    .filter((id): id is string => id.length > 0)
            )
        );
        if (ids.length === 0) return {};

        try {
            // "Now" in the provider's EPG clock (`epg-display-offset.util.ts`,
            // clock form), like every other current-programme lookup.
            const rows = await fn.call(this.bridge, ids, {
                nowMs: epgProviderClockMs(
                    Date.now(),
                    this.settingsStore.resolvedEpgOffsetMinutes()
                ),
            });
            if (revision !== this.sources.revision()) return {};
            const out: Record<string, EpgItem> = {};
            for (const id of ids) {
                const row = rows?.[id];
                if (row) {
                    out[id] = mapEpgProgramToEpgItem(row, id);
                }
            }
            return out;
        } catch (error) {
            this.logger.error(
                'Failed to load XMLTV current-programs batch',
                error
            );
            return {};
        }
    }

    /**
     * The automatic name match for a playlist channel
     * (`epg-name-match.util.ts`), or `null`.
     */
    async matchChannelByName(
        channelName: string | null | undefined,
        hint?: EpgNameMatchHint
    ): Promise<EpgNameMatch | null> {
        if (!this.preferences.enabled() || !channelName?.trim()) return null;
        const index = await this.nameIndex.load();
        return index?.match(channelName, hint) ?? null;
    }

    /**
     * Batch form of `matchChannelByName` for a viewport: one index load, then
     * synchronous lookups, in request order. `indexKey` identifies the index
     * used (`XtreamEpgNameIndexService.readyKey`).
     */
    async matchChannelNames(
        requests: ReadonlyArray<{
            channelName?: string | null;
            categoryName?: string | null;
        }>
    ): Promise<{
        matches: Array<EpgNameMatch | null>;
        indexKey: string | null;
    }> {
        const named = requests.some((request) => request.channelName?.trim());
        const index =
            named && this.preferences.enabled()
                ? await this.nameIndex.load()
                : null;
        return {
            matches: requests.map((request) =>
                index && request.channelName
                    ? index.match(request.channelName, request)
                    : null
            ),
            indexKey: this.nameIndex.readyKey(),
        };
    }

    /** `XtreamEpgNameIndexService.readyKey`. */
    nameIndexKey(): string | null {
        return this.nameIndex.readyKey();
    }

    /**
     * Resolve EPG for a single channel under the user's source-priority
     * setting. The Xtream provider's call is supplied by the caller via
     * `fetchProvider` so this service stays unaware of credentials. When
     * `preferUploaded` is true and XMLTV has data, the provider is not
     * called at all.
     *
     * A channel with neither a manual mapping nor an `epgChannelId` reads
     * the name-matched XMLTV schedule first and asks the provider only when
     * that is empty: such providers return nothing for those channels. With
     * an `epgChannelId` the name match is the last resort. A placeholder
     * (`dummy-<n>`) match always comes after the provider.
     */
    async resolveCurrentEpg(args: {
        epgChannelId: string | null | undefined;
        preferUploaded: boolean;
        fetchProvider: () => Promise<EpgItem[]>;
        signal?: AbortSignal;
        /** Playlist channel name for the automatic name match. */
        channelName?: string | null;
        /** Playlist category name: a country hint for the name match. */
        categoryName?: string | null;
        /** `epgChannelId` comes from a manual mapping: no name match. */
        mapped?: boolean;
    }): Promise<EpgItem[]> {
        if (args.mapped) {
            return resolveByIdOrProvider(args, (id) =>
                this.getProgramsForChannel(id)
            );
        }
        let match: Promise<EpgNameMatch | null> | undefined;
        const readByName = (tiers: 'real' | 'placeholder' | 'all') => {
            match ??= this.matchChannelByName(args.channelName, args).catch(
                () => null
            );
            return this.readMatched(match, tiers, args);
        };

        const withoutId = !(args.epgChannelId ?? '').trim();
        if (withoutId) {
            const named = await readByName('real');
            if (named.length) return named;
        }
        const late = withoutId ? 'placeholder' : 'all';
        let programs: EpgItem[];
        try {
            programs = await resolveByIdOrProvider(args, (id) =>
                this.getProgramsForChannel(id)
            );
        } catch (error) {
            if (isAbortError(error)) throw error;
            const named = await readByName(late);
            if (!named.length) throw error;
            return named;
        }
        return programs.length ? programs : readByName(late);
    }

    /**
     * The schedule of the first matched candidate that has one, skipping
     * the channel's own `epgChannelId` (already read). `tiers` picks real
     * matches, the placeholder (`dummy-<n>`) match, or either.
     */
    private async readMatched(
        pending: Promise<EpgNameMatch | null>,
        tiers: 'real' | 'placeholder' | 'all',
        args: { epgChannelId?: string | null; signal?: AbortSignal }
    ): Promise<EpgItem[]> {
        try {
            args.signal?.throwIfAborted();
            const match = await pending;
            args.signal?.throwIfAborted();
            const isPlaceholder = match?.tier === 'placeholder';
            if (
                !match ||
                (tiers === 'real' && isPlaceholder) ||
                (tiers === 'placeholder' && !isPlaceholder)
            ) {
                return [];
            }
            const own = (args.epgChannelId ?? '').trim();
            for (const id of match.ids) {
                if (id === own) continue;
                const programs = await this.getProgramsForChannel(id);
                args.signal?.throwIfAborted();
                if (programs.length) return programs;
            }
            return [];
        } catch (error) {
            if (isAbortError(error)) throw error;
            return [];
        }
    }
}

/** Manual mapping or provider id first, under the source-priority setting. */
async function resolveByIdOrProvider(
    args: {
        epgChannelId: string | null | undefined;
        preferUploaded: boolean;
        fetchProvider: () => Promise<EpgItem[]>;
        signal?: AbortSignal;
    },
    readXmltvById: (id: string) => Promise<EpgItem[]>
): Promise<EpgItem[]> {
    args.signal?.throwIfAborted();
    const id = (args.epgChannelId ?? '').trim();

    if (!id) return args.fetchProvider();
    const readXmltv = () => {
        args.signal?.throwIfAborted();
        return readXmltvById(id);
    };

    const primary = args.preferUploaded ? readXmltv : args.fetchProvider;
    const fallback = args.preferUploaded ? args.fetchProvider : readXmltv;

    try {
        const programs = await primary();
        if (programs.length) return programs;
    } catch (error) {
        if (isAbortError(error)) throw error;
        const programs = await fallback();
        if (!programs.length) throw error;
        return programs;
    }
    return fallback();
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

function mapEpgProgramToEpgItem(
    program: EpgProgram,
    channelId: string
): EpgItem {
    const startMs = program.startTimestamp
        ? program.startTimestamp * 1000
        : Date.parse(program.start);
    const stopMs = program.stopTimestamp
        ? program.stopTimestamp * 1000
        : Date.parse(program.stop);
    const startTimestamp = Number.isFinite(startMs)
        ? Math.floor(startMs / 1000)
        : 0;
    const stopTimestamp = Number.isFinite(stopMs)
        ? Math.floor(stopMs / 1000)
        : 0;

    return {
        id: `${channelId}|${program.start}`,
        epg_id: '',
        title: program.title ?? '',
        lang: '',
        start: program.start,
        end: program.stop,
        stop: program.stop,
        description: program.desc ?? '',
        channel_id: channelId,
        start_timestamp: String(startTimestamp),
        stop_timestamp: String(stopTimestamp),
    };
}
