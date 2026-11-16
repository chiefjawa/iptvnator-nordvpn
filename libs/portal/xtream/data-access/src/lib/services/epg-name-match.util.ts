/**
 * Automatic XMLTV channel matching by name, for Xtream live channels whose
 * provider sends no usable `epg_channel_id` guide.
 *
 * Matching, in order:
 * 1. Exact: both names normalized (NFKC, lower-case, collapsed whitespace)
 *    and equal, against XMLTV channels with a real id.
 * 2. Loose: both names reduced to a key without a leading provider/country
 *    prefix (`US: `, `XY&Z: `, `UK ▎ `), quality tags (`RAW`, `HD`, `4K`…)
 *    and punctuation. A key needs at least three characters, and placeholder
 *    channels (`dummy-<n>`, filler programmes) never take part.
 * 3. Exact against placeholder channels, as a last resort.
 *
 * Several distinct XMLTV channels sharing a key resolve to the lowest id
 * (code-unit order), so a channel always gets the same guide; the manual EPG
 * mapping overrides it.
 */

export interface EpgNameIndexChannel {
    readonly id: string;
    readonly displayName: string;
}

export interface EpgNameIndex {
    /** XMLTV channel id for a playlist channel name, or `null`. */
    resolve(name: string | null | undefined): string | null;
}

const PLACEHOLDER_ID = /^dummy-\d+$/i;

/** Superscript / modifier letters, spaced out so `CNNᴴᴰ` keeps a `HD` word. */
const SUPERSCRIPT_RUN =
    /[\u02B0-\u02B8\u02E0-\u02E4\u1D2C-\u1D6A\u1D9B-\u1DBF\u2070-\u209C\uA7F8\uA7F9]+/gu;

/** One or two short tokens followed by `:`, `|` or a bar glyph. */
const PREFIX =
    /^[\p{L}\p{N}&+._'-]{1,6}(?: [\p{L}\p{N}&+._'-]{1,6})? ?(?:[:|\u00A6\u258F\u258E\u258D\u258C\u2502\u2503\u00BB]+|- )\s*/u;

const QUALITY_TAGS = new Set([
    'raw',
    'sd',
    'hd',
    'fhd',
    'uhd',
    'qhd',
    'hdr',
    'hdr10',
    '4k',
    '8k',
    'hevc',
    'h264',
    'h265',
    'x264',
    'x265',
    'fps',
    'vip',
    'lq',
    'hq',
    'backup',
    'bk',
]);
const QUALITY_TAG_PATTERN = /^(?:\d{3,4}[pi]|\d{2,3}fps|(?:backup|bk)\d+)$/u;
const MIN_LOOSE_KEY_LENGTH = 3;

export function isPlaceholderEpgChannelId(id: string): boolean {
    return PLACEHOLDER_ID.test(id.trim());
}

/** Tier 1 key: NFKC, lower-case, single spaces, trimmed. */
export function normalizeEpgChannelName(name: string): string {
    return name.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/** Tier 2 key, or `''` when fewer than three characters remain. */
export function looseEpgChannelKey(name: string): string {
    // `## US: NEWS ##`-style decorations around the whole name.
    const value = normalizeEpgChannelName(name.replace(SUPERSCRIPT_RUN, ' $& '))
        .replace(/^[^\p{L}\p{N}]+/u, '')
        .replace(/[^\p{L}\p{N}+]+$/u, '');
    const once = value.replace(PREFIX, '');
    const twice = once.replace(PREFIX, '');
    // A "prefix" that leaves nothing but tags (`BBC One | HD`) was the name.
    for (const candidate of [twice, once, value]) {
        const tokens = nameTokens(candidate);
        if (tokens.length === 0) continue;
        return [...tokens.join('')].length >= MIN_LOOSE_KEY_LENGTH
            ? tokens.join(' ')
            : '';
    }
    return '';
}

function nameTokens(value: string): string[] {
    return value
        .replace(/\bh\.26([45])\b/gu, 'h26$1')
        .replace(/\b(\d{2,3}) fps\b/gu, '$1fps')
        .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
        .split(' ')
        .filter(
            (token) =>
                token.length > 0 &&
                !QUALITY_TAGS.has(token) &&
                !QUALITY_TAG_PATTERN.test(token)
        );
}

export function buildEpgNameIndex(
    channels: ReadonlyArray<EpgNameIndexChannel>
): EpgNameIndex {
    const exact = new Map<string, string>();
    const loose = new Map<string, string>();
    const exactPlaceholder = new Map<string, string>();

    for (const channel of channels) {
        const id = typeof channel?.id === 'string' ? channel.id.trim() : '';
        const name =
            typeof channel?.displayName === 'string' ? channel.displayName : '';
        if (!id || !name.trim()) continue;
        const normalized = normalizeEpgChannelName(name);
        if (isPlaceholderEpgChannelId(id)) {
            keepLowest(exactPlaceholder, normalized, id);
            continue;
        }
        keepLowest(exact, normalized, id);
        const key = looseEpgChannelKey(name);
        if (key) keepLowest(loose, key, id);
    }

    const memo = new Map<string, string | null>();
    return {
        resolve(name) {
            if (typeof name !== 'string' || !name.trim()) return null;
            const cached = memo.get(name);
            if (cached !== undefined) return cached;
            const normalized = normalizeEpgChannelName(name);
            const key = looseEpgChannelKey(name);
            const id =
                exact.get(normalized) ??
                (key ? loose.get(key) : undefined) ??
                exactPlaceholder.get(normalized) ??
                null;
            memo.set(name, id);
            return id;
        },
    };
}

function keepLowest(map: Map<string, string>, key: string, id: string): void {
    const current = map.get(key);
    if (current === undefined || id < current) map.set(key, id);
}
