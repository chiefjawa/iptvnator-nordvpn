import {
    buildXtreamEpgMappingKey,
    EpgItem,
    windowEpgItemsAtProviderClock,
} from '@iptvnator/shared/interfaces';
import type { XtreamApiService, XtreamCredentials } from './xtream-api.service';

/**
 * Resolve manual EPG mappings for queued entries, in place; returns the
 * stream ids that have one.
 *
 * The user may have opened the mapping dialog (right-click → "Map EPG")
 * from any channel list; the stored key is the playlist-scoped Xtream
 * key, which does not match the provider's epg_channel_id, so the batch
 * IPC handler's resolveChannelIds() would miss it.  We resolve here,
 * upfront, so the XMLTV batch call later uses the *mapped* epgChannelId
 * — the actual EPG channel that carries the XMLTV data. A mapping also
 * supplies an epgChannelId to entries whose provider did not send one.
 */
export async function applyManualEpgMappings(
    entries: Array<{
        streamId: number;
        epgChannelId?: string | null;
        playlistId?: string | null;
    }>,
    logger: { info(message: string): void }
): Promise<Set<number>> {
    const mapped = new Set<number>();
    const getEpgMappingsBatch =
        typeof window.electron?.getEpgMappingsBatch === 'function'
            ? window.electron.getEpgMappingsBatch
            : null;
    if (!getEpgMappingsBatch) {
        return mapped;
    }

    const keyByStreamId = new Map<number, string>();
    for (const entry of entries) {
        if (!entry.playlistId) continue;
        keyByStreamId.set(
            entry.streamId,
            buildXtreamEpgMappingKey(entry.playlistId, entry.streamId)
        );
    }
    if (keyByStreamId.size === 0) {
        return mapped;
    }

    try {
        // One IPC round-trip for the whole viewport — a per-entry
        // lookup would put O(N) IPC calls on every scroll event.
        const mappings = await getEpgMappingsBatch([...keyByStreamId.values()]);
        for (const entry of entries) {
            const key = keyByStreamId.get(entry.streamId);
            const mappedId = key ? mappings[key]?.trim() : undefined;
            if (mappedId) {
                logger.info(
                    `Mapped stream ${entry.streamId}: ${entry.epgChannelId ?? '(none)'} → ${mappedId}`
                );
                entry.epgChannelId = mappedId;
                mapped.add(entry.streamId);
            }
        }
    } catch {
        // Mapping lookup failure is non-fatal; keep the original
        // epgChannelId values and proceed.
    }
    return mapped;
}

/**
 * The provider round-trip for one stream, settled into a value so the
 * caller decides once — for success and failure alike — whether the
 * result is still wanted. Without an offset the cheap short EPG is
 * enough; with one, the short EPG cannot reach the programme on air
 * (it starts at the provider's own "now"), so the same window is cut
 * from the full guide at the provider clock
 * (`windowEpgItemsAtProviderClock`).
 */
export async function requestEpgPreviewWindow(
    api: Pick<XtreamApiService, 'getShortEpg' | 'getFullEpg'>,
    credentials: XtreamCredentials,
    streamId: number,
    offsetMinutes: number,
    limit: number
): Promise<{ items: EpgItem[] } | { error: unknown }> {
    try {
        if (offsetMinutes === 0) {
            return {
                items: await api.getShortEpg(credentials, streamId, limit, {
                    suppressErrorLog: true,
                }),
            };
        }
        return {
            items: windowEpgItemsAtProviderClock(
                await api.getFullEpg(credentials, streamId, {
                    suppressErrorLog: true,
                }),
                offsetMinutes,
                limit
            ),
        };
    } catch (error) {
        return { error };
    }
}
