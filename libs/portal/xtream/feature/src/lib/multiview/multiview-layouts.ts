/**
 * Named multiview layouts of a playlist: a name and the tiles' stream ids,
 * in order. Like the last-used set (multiview-persistence.ts) they hold
 * stream ids only, never URLs, and live in localStorage per playlist.
 */

const STORAGE_PREFIX = 'iptvnator-multiview-layouts:';

export const MAX_MULTIVIEW_LAYOUTS = 12;
export const MAX_MULTIVIEW_LAYOUT_NAME = 40;
const MAX_TILES = 4;

export interface MultiviewLayout {
    readonly name: string;
    readonly xtreamIds: readonly number[];
}

export interface SaveLayoutResult {
    readonly layouts: MultiviewLayout[];
    /** Why nothing was saved: no name or tiles, or the cap is reached. */
    readonly error?: 'full' | 'empty';
}

export function normalizeLayoutName(name: string): string {
    return name.trim().replace(/\s+/g, ' ').slice(0, MAX_MULTIVIEW_LAYOUT_NAME);
}

function sameName(a: string, b: string): boolean {
    return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}

function isLayout(value: unknown): value is MultiviewLayout {
    const candidate = value as Partial<MultiviewLayout> | null;
    return (
        typeof candidate?.name === 'string' &&
        normalizeLayoutName(candidate.name).length > 0 &&
        Array.isArray(candidate.xtreamIds)
    );
}

export function readMultiviewLayouts(playlistId: string): MultiviewLayout[] {
    try {
        const value: unknown = JSON.parse(
            localStorage.getItem(STORAGE_PREFIX + playlistId) ?? '[]'
        );
        if (!Array.isArray(value)) {
            return [];
        }
        return value
            .filter(isLayout)
            .map((layout) => ({
                name: normalizeLayoutName(layout.name),
                xtreamIds: layout.xtreamIds
                    .filter((id): id is number => Number.isInteger(id))
                    .slice(0, MAX_TILES),
            }))
            .slice(0, MAX_MULTIVIEW_LAYOUTS);
    } catch {
        return [];
    }
}

export function writeMultiviewLayouts(
    playlistId: string,
    layouts: readonly MultiviewLayout[]
): void {
    try {
        localStorage.setItem(
            STORAGE_PREFIX + playlistId,
            JSON.stringify(
                layouts.map(({ name, xtreamIds }) => ({ name, xtreamIds }))
            )
        );
    } catch {
        // Storage can be full or disabled; layouts then last for the session.
    }
}

/** Saves under a name; an existing layout of that name is overwritten. */
export function saveLayout(
    layouts: readonly MultiviewLayout[],
    name: string,
    xtreamIds: readonly number[]
): SaveLayoutResult {
    const normalized = normalizeLayoutName(name);
    if (!normalized || xtreamIds.length === 0) {
        return { layouts: [...layouts], error: 'empty' };
    }
    const layout = { name: normalized, xtreamIds: xtreamIds.slice(0, MAX_TILES) };
    const index = layouts.findIndex((item) => sameName(item.name, normalized));
    if (index >= 0) {
        return {
            layouts: layouts.map((item, i) => (i === index ? layout : item)),
        };
    }
    if (layouts.length >= MAX_MULTIVIEW_LAYOUTS) {
        return { layouts: [...layouts], error: 'full' };
    }
    return { layouts: [...layouts, layout] };
}

/** Renames; refused (unchanged) when the new name is empty or taken. */
export function renameLayout(
    layouts: readonly MultiviewLayout[],
    from: string,
    to: string
): MultiviewLayout[] | null {
    const normalized = normalizeLayoutName(to);
    const taken = layouts.some(
        (item) => sameName(item.name, normalized) && !sameName(item.name, from)
    );
    if (!normalized || taken) {
        return null;
    }
    return layouts.map((item) =>
        sameName(item.name, from) ? { ...item, name: normalized } : item
    );
}

export function deleteLayout(
    layouts: readonly MultiviewLayout[],
    name: string
): MultiviewLayout[] {
    return layouts.filter((item) => !sameName(item.name, name));
}

/** The layout's channels that still exist, and how many are gone. */
export function resolveLayoutChannels<T>(
    layout: MultiviewLayout,
    byId: ReadonlyMap<number, T>
): { channels: T[]; missing: number } {
    const channels = layout.xtreamIds
        .map((id) => byId.get(id))
        .filter((channel): channel is T => channel !== undefined);
    return { channels, missing: layout.xtreamIds.length - channels.length };
}

export function layoutMatches(
    layout: MultiviewLayout,
    xtreamIds: readonly number[]
): boolean {
    return (
        layout.xtreamIds.length === xtreamIds.length &&
        layout.xtreamIds.every((id, index) => id === xtreamIds[index])
    );
}
