/**
 * Remembers which channels a playlist's multiview showed, by stream id only
 * (never URLs), so reopening the multiview brings the same tiles back.
 */

const STORAGE_PREFIX = 'iptvnator-multiview-channels:';

export function readSavedMultiviewChannels(playlistId: string): number[] {
    try {
        const value: unknown = JSON.parse(
            localStorage.getItem(STORAGE_PREFIX + playlistId) ?? '[]'
        );
        return Array.isArray(value)
            ? value.filter((id): id is number => Number.isInteger(id))
            : [];
    } catch {
        return [];
    }
}

export function saveMultiviewChannels(
    playlistId: string,
    xtreamIds: readonly number[]
): void {
    try {
        localStorage.setItem(
            STORAGE_PREFIX + playlistId,
            JSON.stringify(xtreamIds)
        );
    } catch {
        // Storage can be full or disabled; the multiview works without it.
    }
}
