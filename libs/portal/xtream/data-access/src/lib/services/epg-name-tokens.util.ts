/**
 * Channel-name analysis for the automatic XMLTV name match
 * (`epg-name-match.util.ts`). Pure functions; both playlist names and XMLTV
 * display names go through `analyzeEpgChannelName`, so every rule applies to
 * both sides alike.
 */

import { countrySuffixesForPrefix } from './epg-name-country.util';

export interface EpgNameAnalysis {
    /** Distinct significant tokens, in name order. */
    readonly tokens: readonly string[];
    /** `tokens` joined without spaces: `SampleView` equals `SAMPLE VIEW`. */
    readonly squashed: string;
    /** Sorted `tokens`, space-joined: word order does not matter. */
    readonly bag: string;
    /** Sorted number tokens, space-joined; must agree for a loose match. */
    readonly numbers: string;
    /** Regional feed (`east`, `west`, `pacific`, `mountain`, `central`). */
    readonly feed: string | null;
    /** US/CA call signs written in brackets: `(KXYZ)`, `[WXYZ-TV]`. */
    readonly callSigns: readonly string[];
    /** Unbracketed call-sign-shaped tokens (`WXYZ`), a weaker signal. */
    readonly looseCallSigns: readonly string[];
    /**
     * Lower-case first token of a stripped `XX:`/`XX|` prefix, if any; of
     * the second prefix when only that one names a country (`VIP: US: `).
     */
    readonly prefix: string | null;
    /**
     * Only channel words and numbers (`TV 1`, `Channel 4`): the noise words
     * had to stay, so the name says little on its own.
     */
    readonly generic: boolean;
    /** Every token before the noise words were dropped, in order, joined. */
    readonly fullSquashed: string;
    /** Kinds of dropped noise words: `tv` (also `television`), `channel`, `network`. */
    readonly kinds: readonly string[];
    /** Broadcast networks named (`abc`, `nbc`, `telemundo`…). */
    readonly networks: readonly string[];
    /** Tokens found only in brackets (`Sample (City)`): extra detail. */
    readonly bracketed: readonly string[];
    /** `tokens` before a trailing `by <brand>` (`Sample Quest by Studio`). */
    readonly unbranded: readonly string[] | null;
}

/** Superscript / modifier letters, spaced out so `Sampleᴴᴰ` keeps a `HD` word. */
const SUPERSCRIPT_RUN =
    /[\u02B0-\u02B8\u02E0-\u02E4\u1D2C-\u1D6A\u1D9B-\u1DBF\u2070-\u209C\u2C7C\u2C7D\uA7F8\uA7F9]+/gu;

/** One or two short tokens followed by `:`, `|`, a bar glyph or ` - `. */
const PREFIX =
    /^([\p{L}\p{N}&+._'/-]{1,8}(?: [\p{L}\p{N}&+._'-]{1,6})?) ?(?:[:|\u00A6\u258F\u258E\u258D\u258C\u2502\u2503\u00BB]+|- )\s*/u;

const SECOND_PREFIX = /^\p{L}{2} ?[:|]/u;

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
    'multi',
    'multiaudio',
]);
const QUALITY_TAG_PATTERN =
    /^(?:\d{3,4}[pi]|\d{2,3}fps|(?:backup|bk)\d+|[48]k\d*)$/u;

/**
 * Words that say "this is a channel" rather than which one. Dropped unless
 * nothing with a letter would be left (`Channel 4`, `TV 2` keep them).
 */
const NOISE_TOKENS = new Set([
    'the',
    'and',
    'tv',
    'channel',
    'channels',
    'network',
    'television',
    'local',
    'ch',
    // `Sample Show by Studio` = `SAMPLE SHOW STUDIO`.
    'by',
]);
const NOISE_KINDS: Readonly<Record<string, string>> = {
    tv: 'tv',
    television: 'tv',
    channel: 'channel',
    channels: 'channel',
    network: 'network',
};
/** US broadcast networks, for local stations and their call signs. */
export const BROADCAST_NETWORKS = new Set([
    'abc',
    'cbs',
    'nbc',
    'fox',
    'cw',
    'pbs',
    'ion',
    'telemundo',
    'univision',
    'unimas',
    'mytv',
    'mynetworktv',
    // A station's own programming: not the network on its subchannel.
    'independent',
]);
const NETWORK_PHRASES: ReadonlyArray<[RegExp, string]> = [
    [/\bnational broadcasting company\b/gu, 'nbc'],
    [/\bamerican broadcasting company\b/gu, 'abc'],
    [/\bcolumbia broadcasting system\b/gu, 'cbs'],
    [/\bpublic broadcasting service\b/gu, 'pbs'],
];
const REGION_WORDS = new Set(['north', 'south']);
const FEEDS = new Set(['east', 'west', 'pacific', 'mountain', 'central']);
const NUMBER_WORDS: Readonly<Record<string, string>> = {
    zero: '0',
    one: '1',
    two: '2',
    three: '3',
    four: '4',
    five: '5',
    six: '6',
    seven: '7',
    eight: '8',
    nine: '9',
    ten: '10',
};

const BRACKETED_CALL_SIGN =
    /[([]\s*([kw][a-z]{2,3})(?:[- ]?(?:tv|dt|cd|lp|ld|ca)\d?)?\s*[)\]]/gu;
/** Fewer core characters than this keep the noise words (`WE TV`). */
const MIN_CORE_LENGTH = 3;
const CALL_SIGN_SHAPE = /^[kw][a-z]{2,3}$/u;

export function normalizeEpgChannelName(name: string): string {
    return name.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/**
 * `stripPrefix: false` for XMLTV display names: a guide name such as
 * `Sample News - Austin` has no provider prefix to drop.
 */
export function analyzeEpgChannelName(
    name: string,
    { stripPrefix = true }: { stripPrefix?: boolean } = {}
): EpgNameAnalysis {
    let value = normalizeEpgChannelName(name.replace(SUPERSCRIPT_RUN, ' $& '))
        // `## US: NEWS ##`-style decorations around the whole name.
        .replace(/^[^\p{L}\p{N}]+/u, '')
        .replace(/[^\p{L}\p{N}+)\]]+$/u, '');

    let prefix: string | null = null;
    for (let pass = 0; stripPrefix && pass < 2; pass++) {
        const match = PREFIX.exec(value);
        if (!match) break;
        // A second prefix (`VIP: US: Sample`) is a country code before `:`
        // or `|`; `Sample Show: Part` or `SMPL - Sample` keep their words.
        if (pass === 1 && !SECOND_PREFIX.test(match[0])) break;
        const rest = value.slice(match[0].length);
        // A "prefix" that leaves only tags (`Sample One | HD`) was the name.
        if (significantTokens(rest).length === 0) break;
        const token = match[1].split(/[ -]/u)[0];
        // A package tag yields the hint to a country after it (`VIP: US: `).
        if (
            pass === 0 ||
            (!countrySuffixesForPrefix(prefix) &&
                countrySuffixesForPrefix(token))
        ) {
            prefix = token;
        }
        value = rest;
    }

    const callSigns = groupMatches(BRACKETED_CALL_SIGN, value);
    const all = significantTokens(value);
    // A feed word ends the name (`Sample East`); elsewhere, or after
    // `north`/`south`, it is part of the name (`Wild East Sample`).
    const last = all.length - 1;
    const feedAt =
        FEEDS.has(all[last]) && !REGION_WORDS.has(all[last - 1]) ? last : -1;
    const feed = feedAt >= 0 ? all[feedAt] : null;
    const withoutFeed = all.filter((_, at) => at !== feedAt);
    const named = withoutFeed.length ? withoutFeed : all;
    const core = named.filter((token) => !NOISE_TOKENS.has(token));
    const generic = !(
        core.some((token) => /\p{L}/u.test(token)) &&
        core.join('').length >= MIN_CORE_LENGTH
    );
    const tokens = [...new Set(generic ? named : core)];
    return {
        tokens,
        squashed: tokens.join(''),
        bag: [...tokens].sort().join(' '),
        numbers: tokens
            .filter((token) => /^\p{N}+$/u.test(token))
            .sort()
            .join(' '),
        feed: withoutFeed.length ? feed : null,
        callSigns: [...new Set(callSigns)],
        looseCallSigns: tokens.filter(
            (token) => CALL_SIGN_SHAPE.test(token) && !callSigns.includes(token)
        ),
        prefix,
        generic: generic && named.length > 0,
        fullSquashed: named.join(''),
        kinds: [
            ...new Set(
                named
                    .map((token) => NOISE_KINDS[token])
                    .filter((kind): kind is string => Boolean(kind))
            ),
        ],
        networks: tokens.filter((token) => BROADCAST_NETWORKS.has(token)),
        bracketed: bracketedOnly(value, tokens),
        unbranded: unbranded(named),
    };
}

function unbranded(named: readonly string[]): string[] | null {
    const by = named.lastIndexOf('by');
    if (by <= 0 || named.length - by > 3) return null;
    const before = [
        ...new Set(
            named.slice(0, by).filter((token) => !NOISE_TOKENS.has(token))
        ),
    ];
    // One word before `by` is too little to name the channel.
    return before.length >= 2 ? before : null;
}

function bracketedOnly(value: string, tokens: readonly string[]): string[] {
    const inside = concatMap(
        groupMatches(/[([]([^)\]]*)[)\]]/gu, value),
        (text) => significantTokens(text)
    );
    if (inside.length === 0) return [];
    const outside = new Set(
        significantTokens(value.replace(/[([][^)\]]*[)\]]/gu, ' '))
    );
    return tokens.filter(
        (token) => inside.includes(token) && !outside.has(token)
    );
}

/** Tokens after punctuation, `&`/`+` handling, tags and number words. */
function significantTokens(value: string): string[] {
    const named = NETWORK_PHRASES.reduce(
        (text, [phrase, short]) => text.replace(phrase, short),
        value
    );
    const words = named
        .replace(/\bh\.26([45])\b/gu, 'h26$1')
        .replace(/\b(\d{2,3}) fps\b/gu, '$1fps')
        // `F.B.I.`, `America's`: joined, not split.
        .replace(/(?<=\p{L})[.'\u2019](?=\p{L})/gu, '')
        // `&` is a connector (dropped as noise); `+` always reads
        // `plus`, so `Sample+` and `SAMPLE +` agree.
        .replace(/&/gu, ' and ')
        .replace(/\+/gu, ' plus ')
        .split(/[^\p{L}\p{N}\p{M}]+/u)
        .filter(
            (token) =>
                token.length > 0 &&
                !QUALITY_TAGS.has(token) &&
                !QUALITY_TAG_PATTERN.test(token)
        );
    // `Sample11` and `Sample 11` are one name.
    return concatMap(words, (token) =>
        token.split(/(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u)
    )
        .map((token) => NUMBER_WORDS[token] ?? token)
        .filter((token) => !QUALITY_TAGS.has(token));
}

/** The first capture group of every match of a global `pattern`. */
function groupMatches(pattern: RegExp, value: string): string[] {
    const out: string[] = [];
    const re = new RegExp(pattern.source, pattern.flags);
    for (let match = re.exec(value); match; match = re.exec(value)) {
        out.push(match[1]);
    }
    return out;
}

/** `Array.prototype.flatMap`, which the web build's ES target lacks. */
export function concatMap<T, U>(
    items: ReadonlyArray<T>,
    map: (item: T) => ReadonlyArray<U>
): U[] {
    const out: U[] = [];
    for (const item of items) out.push(...map(item));
    return out;
}
