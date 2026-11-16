import { inject, Injectable } from '@angular/core';
import {
    EpgPreferencesService,
    EpgSourceSettingsService,
} from '@iptvnator/services';
import { buildEpgNameIndex, EpgNameIndex } from './epg-name-match.util';

/** `readyKey()` when name matching cannot run here (no bridge, EPG off). */
export const EPG_NAME_INDEX_UNAVAILABLE = 'unavailable';

/**
 * The name index over the stored XMLTV channels (`epg-name-match.util.ts`).
 *
 * Built lazily on the first lookup that needs it — never at startup — from
 * one `getEpgChannels` IPC, then reused until the XMLTV data can have
 * changed: an EPG source revision (settings save, reconciliation, the global
 * EPG toggle) or a completed import. Lookups against the built index are
 * synchronous map reads.
 */
@Injectable({ providedIn: 'root' })
export class XtreamEpgNameIndexService {
    private readonly sources = inject(EpgSourceSettingsService);
    private readonly preferences = inject(EpgPreferencesService);
    private importEpoch = 0;
    private listening = false;
    private current?: { key: string; index: Promise<EpgNameIndex | null> };
    /** Key of the last index that finished building, or failed to. */
    private settled?: { key: string; ok: boolean };

    /** The current index, or `null` without XMLTV support or with EPG off. */
    load(): Promise<EpgNameIndex | null> {
        const getEpgChannels = this.bridge();
        if (!getEpgChannels) return Promise.resolve(null);
        this.listenForImports();

        const key = this.key();
        if (this.current?.key === key) return this.current.index;
        const entry = {
            key,
            index: Promise.resolve()
                .then(() => getEpgChannels.call(window.electron))
                .then((result) => {
                    // A failed read is not an empty guide: retry it.
                    if (result?.error || !Array.isArray(result?.channels)) {
                        throw new Error('XMLTV channels unavailable');
                    }
                    const index = buildEpgNameIndex(result.channels);
                    if (this.current === entry) {
                        this.settled = { key, ok: true };
                    }
                    return index;
                })
                .catch(() => {
                    // Retry on the next lookup instead of caching a failure
                    // (a rejected read or an `error` answer alike).
                    if (this.current === entry) {
                        this.current = undefined;
                        this.settled = { key, ok: false };
                    }
                    return null;
                }),
        };
        this.current = entry;
        return entry.index;
    }

    /**
     * Which index a lookup made now would use, synchronously: its key once
     * built, `EPG_NAME_INDEX_UNAVAILABLE` when matching cannot run or the
     * build failed, `null` while it is not built yet. A result recorded
     * under one key says nothing about a name match under another.
     */
    readyKey(): string | null {
        if (!this.bridge()) return EPG_NAME_INDEX_UNAVAILABLE;
        const key = this.key();
        if (this.settled?.key !== key) return null;
        return this.settled.ok ? key : EPG_NAME_INDEX_UNAVAILABLE;
    }

    /** Drops the index; the next lookup rebuilds it. */
    invalidate(): void {
        this.importEpoch++;
        this.current = undefined;
    }

    private key(): string {
        return `${this.sources.revision()}:${this.importEpoch}`;
    }

    private bridge() {
        if (!this.preferences.enabled() || typeof window === 'undefined') {
            return null;
        }
        const getEpgChannels = window.electron?.getEpgChannels;
        return typeof getEpgChannels === 'function' ? getEpgChannels : null;
    }

    private listenForImports(): void {
        if (this.listening) return;
        const onEpgProgress = window.electron?.onEpgProgress;
        if (typeof onEpgProgress !== 'function') return;
        this.listening = true;
        onEpgProgress.call(window.electron, (progress) => {
            if (progress?.status === 'complete') this.invalidate();
        });
    }
}
