import type { EpgItem } from '@iptvnator/shared/interfaces';
import type { EpgNameMatch } from './epg-name-match.util';

/** What the name matches of one enqueue contribute to the queue. */
export interface EpgQueueNamePlan {
    /** XMLTV ids for the one current-programme batch IPC. */
    readonly batchIds: readonly string[];
    /**
     * Entries without mapping and `epgChannelId`: their candidate ids, best
     * first. A candidate with a current programme is the answer.
     */
    readonly answers: ReadonlyMap<number, readonly string[]>;
    /**
     * Candidates used only when the provider answers empty: the name match
     * of an entry with an `epgChannelId`, and any placeholder match.
     */
    readonly fallbacks: ReadonlyMap<number, readonly string[]>;
}

/**
 * Sorts the name matches of an enqueue (`matches[i]` for `entries[i]`).
 * Manually mapped entries never use one; the entry's own `epgChannelId`
 * is left out of its candidates, since the batch reads it anyway.
 */
export function planNameMatches(
    entries: ReadonlyArray<{ streamId: number; epgChannelId?: string | null }>,
    mapped: ReadonlySet<number>,
    names: { matches: ReadonlyArray<EpgNameMatch | null> } | null
): EpgQueueNamePlan {
    const batchIds = new Set<string>();
    const answers = new Map<number, readonly string[]>();
    const fallbacks = new Map<number, readonly string[]>();
    entries.forEach((entry, index) => {
        const match = names?.matches[index];
        if (!match || mapped.has(entry.streamId)) return;
        const own = entry.epgChannelId?.trim();
        const ids = match.ids.filter((id) => id !== own);
        if (ids.length === 0) return;
        ids.forEach((id) => batchIds.add(id));
        const target =
            own || match.tier === 'placeholder' ? fallbacks : answers;
        target.set(entry.streamId, ids);
    });
    return { batchIds: [...batchIds], answers, fallbacks };
}

/** The current programme of the first candidate that has one. */
export function firstProgramme(
    ids: readonly string[],
    batch: Readonly<Record<string, EpgItem>>
): EpgItem | undefined {
    for (const id of ids) {
        const item = batch[id];
        if (item) return item;
    }
    return undefined;
}
