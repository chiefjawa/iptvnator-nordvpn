import { inject, Injectable } from '@angular/core';
import {
    EpgPreferencesService,
    EpgSourceSettingsService,
} from '@iptvnator/services';
import { buildEpgNameIndex, EpgNameIndex } from './epg-name-match.util';

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

    /** The current index, or `null` without XMLTV support or with EPG off. */
    load(): Promise<EpgNameIndex | null> {
        if (!this.preferences.enabled()) return Promise.resolve(null);
        const bridge = typeof window === 'undefined' ? null : window.electron;
        const getEpgChannels = bridge?.getEpgChannels;
        if (typeof getEpgChannels !== 'function') return Promise.resolve(null);
        this.listenForImports();

        const key = `${this.sources.revision()}:${this.importEpoch}`;
        if (this.current?.key === key) return this.current.index;
        const entry = {
            key,
            index: Promise.resolve()
                .then(() => getEpgChannels.call(bridge))
                .then((result) =>
                    buildEpgNameIndex(
                        Array.isArray(result?.channels) ? result.channels : []
                    )
                )
                .catch(() => {
                    // Retry on the next lookup instead of caching a failure.
                    if (this.current === entry) this.current = undefined;
                    return null;
                }),
        };
        this.current = entry;
        return entry.index;
    }

    /** Drops the index; the next lookup rebuilds it. */
    invalidate(): void {
        this.importEpoch++;
        this.current = undefined;
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
