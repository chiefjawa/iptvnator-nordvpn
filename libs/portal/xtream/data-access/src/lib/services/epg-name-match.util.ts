/**
 * Automatic XMLTV channel matching by name, for Xtream live channels whose
 * provider sends no usable `epg_channel_id` guide. Names are analysed by
 * `analyzeEpgChannelName` (`epg-name-tokens.util.ts`); the tiers, strongest
 * first, are described on `EpgNameMatch['tier']`. The first tier with an
 * unambiguous answer wins; an ambiguous tier ends the search with no match,
 * because a wrong guide is worse than none.
 */
import {
    analyzeEpgChannelName,
    BROADCAST_NETWORKS,
    concatMap,
    EpgNameAnalysis,
    normalizeEpgChannelName,
} from './epg-name-tokens.util';
import {
    countrySuffixesForPrefix,
    epgChannelIdCountry,
} from './epg-name-country.util';

export { normalizeEpgChannelName } from './epg-name-tokens.util';

export interface EpgNameIndexChannel {
    readonly id: string;
    readonly displayName: string;
}

/** Context that narrows a match: the playlist category the channel is in. */
export interface EpgNameMatchHint {
    readonly categoryName?: string | null;
}

export interface EpgNameMatch {
    /**
     * Candidate XMLTV ids, best first (at most `MAX_CANDIDATES`). All are the
     * same channel as far as the name can tell — duplicates from several
     * sources — so a caller may take the first that has programmes.
     */
    readonly ids: readonly string[];
    /**
     * - `exact`: the whole normalized name equals a display name.
     * - `name`: the significant tokens are equal, in any order, or the
     *   squashed form equals a display name or the id (`SampleView.us`).
     * - `callSign`: a bracketed US/CA call sign names the guide channel.
     * - `partial`: one side's tokens contain the other's, covering at least
     *   `MIN_COVERAGE` of the longer name, numbers and feeds agreeing.
     * - `placeholder`: exact name of a `dummy-<n>` filler channel.
     */
    readonly tier: 'exact' | 'name' | 'callSign' | 'partial' | 'placeholder';
}

export interface EpgNameIndex {
    match(
        name: string | null | undefined,
        hint?: EpgNameMatchHint
    ): EpgNameMatch | null;
    /** First candidate of `match`, or `null`. */
    resolve(
        name: string | null | undefined,
        hint?: EpgNameMatchHint
    ): string | null;
}

interface Candidate {
    readonly id: string;
    readonly country: string | null;
    readonly name: EpgNameAnalysis;
}

type TierResult = EpgNameMatch | null | undefined;

/** Guide countries the playlist name points at, from its prefix or category. */
interface CountryHint {
    readonly suffixes: readonly string[];
    /**
     * Whether a guide channel of another country may still match: not when
     * the name's brand (first word) has guide channels in the hinted
     * countries or in more than `MAX_CROSS_COUNTRY_BRAND_SPREAD` countries,
     * because then the foreign one is likely a national variant.
     */
    readonly crossCountry: boolean;
}

const PLACEHOLDER_ID = /^dummy-\d+$/i;
export const MAX_CANDIDATES = 3;
/** Shared characters / characters of the longer name, for `partial`. */
export const MIN_COVERAGE = 0.6;
/** A `partial` runner-up this close to the best one makes it ambiguous. */
const COVERAGE_MARGIN = 0.15;
const MIN_SQUASHED = 2;
const CROSS_COUNTRY_MIN_SQUASHED = 6;
const MAX_CROSS_COUNTRY_BRAND_SPREAD = 2;
const MIN_PARTIAL_SQUASHED = 4;
const MIN_ID_SQUASHED = 6;
const CALL_SIGN = /^[kw][a-z]{2,3}$/u;
/** `##### SAMPLE #####`: a list section header, not a channel. */
const SEPARATOR_ROW = /^\s*[#=*]{3,}.*[#=*]{3,}\s*$/u;
const BRANDED_DISPLAY = /^[^\s-]{2,8} - (.+)$/u;

export function isPlaceholderEpgChannelId(id: string): boolean {
    return PLACEHOLDER_ID.test(id.trim());
}

/** Id without country suffix or bracketed code: `Sample(SMPL).us` → `sample`. */
function idSquashed(id: string): string {
    return id
        .toLowerCase()
        .replace(/\.[a-z0-9]+$/u, '')
        .replace(/\([^)]*\)/gu, '')
        .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function buildEpgNameIndex(
    channels: ReadonlyArray<EpgNameIndexChannel>
): EpgNameIndex {
    const exact = new Map<string, Candidate[]>();
    const byKey = new Map<string, Candidate[]>();
    const byCallSign = new Map<string, Candidate[]>();
    const postings = new Map<string, Candidate[]>();
    const placeholders = new Map<string, string>();
    /** Guide countries per brand (first token of a channel name). */
    const brandCountries = new Map<string, Set<string>>();

    for (const channel of channels) {
        const id = typeof channel?.id === 'string' ? channel.id.trim() : '';
        const display =
            typeof channel?.displayName === 'string' ? channel.displayName : '';
        if (!id || !display.trim()) continue;
        const normalized = normalizeEpgChannelName(display);
        if (isPlaceholderEpgChannelId(id)) {
            const current = placeholders.get(normalized);
            if (current === undefined || id < current) {
                placeholders.set(normalized, id);
            }
            continue;
        }
        const c: Candidate = {
            id,
            country: epgChannelIdCountry(id),
            name: analyzeEpgChannelName(display, { stripPrefix: false }),
        };
        addTo(exact, normalized, c);
        for (const key of equalityKeys(c.name)) addTo(byKey, key, c);
        // `LEAGUE - Sample Team`: also known by the part after the brand.
        const branded = BRANDED_DISPLAY.exec(normalized);
        if (branded) {
            for (const key of equalityKeys(
                analyzeEpgChannelName(branded[1], { stripPrefix: false })
            )) {
                addTo(byKey, key, c);
            }
        }
        const fromId = idSquashed(id);
        if (fromId.length >= MIN_ID_SQUASHED) {
            for (const key of squashedKeys(fromId)) addTo(byKey, key, c);
        }
        if (CALL_SIGN.test(fromId)) addTo(byCallSign, fromId, c);
        // An unbracketed call-sign-shaped word (`Sample Who`) counts only
        // in a station name that also names its network.
        for (const sign of [
            ...c.name.callSigns,
            ...(c.name.networks.length ? c.name.looseCallSigns : []),
        ]) {
            addTo(byCallSign, sign, c);
        }
        for (const token of c.name.tokens) addTo(postings, token, c);
        if (c.country && c.name.tokens.length) {
            const brand = c.name.tokens[0];
            const set = brandCountries.get(brand) ?? new Set<string>();
            set.add(c.country);
            brandCountries.set(brand, set);
        }
    }

    const memo = new Map<string, EpgNameMatch | null>();
    const index: EpgNameIndex = {
        match(name, hint) {
            if (typeof name !== 'string' || !name.trim()) return null;
            if (SEPARATOR_ROW.test(name)) return null;
            const memoKey = `${name}\u0000${hint?.categoryName ?? ''}`;
            let result = memo.get(memoKey);
            if (result === undefined) {
                result = matchName(name, hint);
                memo.set(memoKey, result);
            }
            return result;
        },
        resolve(name, hint) {
            return index.match(name, hint)?.ids[0] ?? null;
        },
    };
    return index;

    function matchName(
        name: string,
        hint: EpgNameMatchHint | undefined
    ): EpgNameMatch | null {
        const query = analyzeEpgChannelName(name);
        const normalized = normalizeEpgChannelName(name);
        // The category (`US| Sample`) is the steadier hint — a two-letter
        // name prefix is often a package tag (`XY: Sample`) — unless the
        // name narrows a regional list (`CO: Sample` in `LA| …`) or spells
        // its country out (`ARG: Sample` in an `AR| …` list).
        const own = countrySuffixesForPrefix(query.prefix);
        const listed = hint?.categoryName
            ? countrySuffixesForPrefix(
                  analyzeEpgChannelName(hint.categoryName).prefix
              )
            : null;
        const narrows =
            own &&
            listed &&
            own.length < listed.length &&
            own.every((country) => listed.includes(country));
        const suffixes =
            own && (narrows || (query.prefix?.length ?? 0) > 2)
                ? own
                : (listed ?? own);
        const brandIn = brandCountries.get(query.tokens[0]);
        const countries: CountryHint | null = suffixes && {
            suffixes,
            crossCountry:
                (brandIn?.size ?? 0) <= MAX_CROSS_COUNTRY_BRAND_SPREAD &&
                !suffixes.some((suffix) => brandIn?.has(suffix)),
        };
        const pick = (
            found: Candidate[] | undefined,
            tier: EpgNameMatch['tier']
        ) => choose(found, tier, query, countries);

        const tiers: Array<() => TierResult> = [
            () => pick(exact.get(normalized), 'exact'),
            () =>
                pick(
                    concatMap(
                        equalityKeys(query),
                        (key) => byKey.get(key) ?? []
                    ),
                    'name'
                ),
            () => pick(callSignCandidates(query), 'callSign'),
            () => partial(query, countries),
        ];
        for (const tier of tiers) {
            const result = tier();
            // `undefined`: nothing here, try the next tier; `null`: ambiguous.
            if (result !== undefined) return result;
        }
        const placeholder = placeholders.get(normalized);
        return placeholder ? { ids: [placeholder], tier: 'placeholder' } : null;
    }

    /**
     * Guide channels of the call signs in `query`. An unbracketed call sign
     * counts only next to a network name; a guide channel of another network
     * (a subchannel's affiliate) is not the same channel.
     */
    function callSignCandidates(query: EpgNameAnalysis): Candidate[] {
        const signs = query.networks.length
            ? [...query.callSigns, ...query.looseCallSigns]
            : query.callSigns;
        return concatMap(signs, (sign) =>
            (byCallSign.get(sign) ?? []).filter(
                (c) =>
                    (c.country === null ||
                        c.country === 'us' ||
                        c.country === 'ca') &&
                    (!query.networks.length ||
                        !c.name.networks.length ||
                        c.name.networks.some((n) => query.networks.includes(n)))
            )
        );
    }

    function partial(
        query: EpgNameAnalysis,
        countries: CountryHint | null
    ): TierResult {
        // Without a country hint a partial name is too weak to go on.
        if (!countries || query.squashed.length < MIN_PARTIAL_SQUASHED) {
            return undefined;
        }
        const scored: Array<[Candidate, number]> = [];
        const seen = new Set<Candidate>();
        for (const token of query.tokens) {
            for (const c of postings.get(token) ?? []) {
                if (seen.has(c)) continue;
                seen.add(c);
                const coverage = coverageOf(query, c.name);
                if (
                    coverage >= MIN_COVERAGE &&
                    countryRank(c, countries, query, 'partial') < EXCLUDED &&
                    feedsAgree(query, c.name) &&
                    kindsAgree(query, c.name)
                ) {
                    scored.push([c, coverage]);
                }
            }
        }
        if (scored.length === 0) return undefined;
        scored.sort((a, b) => b[1] - a[1]);
        const [best, bestCoverage] = scored[0];
        const close = scored
            .filter(
                ([, coverage]) => coverage >= bestCoverage - COVERAGE_MARGIN
            )
            .map(([c]) => c);
        // Two different channels both fit about as well: no clear winner.
        if (close.some((c) => c.name.bag !== best.name.bag)) return null;
        return choose(close, 'partial', query, countries);
    }
}

/**
 * The `name` tier's keys: the squashed form (also without a trailing
 * `tv`/`channel`/`network`, so `SampleTV` = `Sample`), the sorted token bag,
 * and the bag before a trailing `by <brand>` (`Sample Show by Studio`).
 */
function equalityKeys(name: EpgNameAnalysis): string[] {
    if (name.squashed.length < MIN_SQUASHED) return [];
    const keys = [...squashedKeys(name.squashed), `b:${name.bag}`];
    const before = name.unbranded;
    if (before && before.join('').length >= MIN_ID_SQUASHED) {
        keys.push(`b:${[...before].sort().join(' ')}`);
    }
    return keys;
}

function squashedKeys(squashed: string): string[] {
    const keys = [`s:${squashed}`];
    const bare = squashed.replace(/(?:tv|channel|network)$/u, '');
    if (bare !== squashed && bare.length >= 4) keys.push(`s:${bare}`);
    return keys;
}

function addTo(map: Map<string, Candidate[]>, key: string, c: Candidate): void {
    const list = map.get(key);
    if (!list) map.set(key, [c]);
    else if (!list.includes(c)) list.push(c);
}

/**
 * The candidates of one tier, best first; `undefined` when none is allowed,
 * `null` when the allowed ones are different channels.
 */
function choose(
    found: Candidate[] | undefined,
    tier: EpgNameMatch['tier'],
    query: EpgNameAnalysis,
    countries: CountryHint | null
): TierResult {
    const rankOf = (c: Candidate) => countryRank(c, countries, query, tier);
    const allowed = [...new Set(found ?? [])].filter(
        (c) =>
            rankOf(c) < EXCLUDED &&
            feedsAgree(query, c.name) &&
            (tier === 'exact' || kindsAgree(query, c.name))
    );
    if (allowed.length === 0) return undefined;
    allowed.sort(
        (a, b) =>
            rankOf(a) - rankOf(b) ||
            feedRank(a.name) - feedRank(b.name) ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
    const rank = rankOf(allowed[0]);
    // (`rank` groups the best fits: home, then no country, then abroad.)
    const top = allowed.filter((c) => rankOf(c) === rank);
    // One name in several guide countries is a different channel in each
    // (schedule, time zone) — also within a hinted region: no answer.
    if (new Set(top.map((c) => c.country)).size > 1) return null;
    const ids = [...new Set(top.map((c) => c.id))].slice(0, MAX_CANDIDATES);
    return { ids, tier };
}

const IN_COUNTRY = 0;
const NO_COUNTRY = 1;
const OTHER_COUNTRY = 2;
const EXCLUDED = 3;

/**
 * How well a candidate's guide country fits the hint. Outside the hinted
 * countries only a distinctive name (two words, `CROSS_COUNTRY_MIN_SQUASHED`
 * characters) whose brand the hinted countries do not carry may match, with
 * the very same words: an international channel carried abroad. A generic
 * name (`TV 1`) needs the hinted country.
 */
function countryRank(
    c: Candidate,
    countries: CountryHint | null,
    query: EpgNameAnalysis,
    tier: EpgNameMatch['tier']
): number {
    const generic = query.generic && tier !== 'exact';
    if (!countries) return generic ? EXCLUDED : IN_COUNTRY;
    if (c.country !== null && countries.suffixes.includes(c.country)) {
        return IN_COUNTRY;
    }
    if (generic) return EXCLUDED;
    if (c.country === null) return NO_COUNTRY;
    const distinctive =
        countries.crossCountry &&
        (tier === 'exact' ||
            (tier === 'name' && query.fullSquashed === c.name.fullSquashed)) &&
        query.tokens.length >= 2 &&
        query.squashed.length >= CROSS_COUNTRY_MIN_SQUASHED;
    return distinctive ? OTHER_COUNTRY : EXCLUDED;
}

/**
 * `Sample Network` and `Sample Channel` are different channels; either may
 * equal a plain `Sample`.
 */
function kindsAgree(
    query: EpgNameAnalysis,
    candidate: EpgNameAnalysis
): boolean {
    return (
        !query.kinds.length ||
        !candidate.kinds.length ||
        query.kinds.some((kind) => candidate.kinds.includes(kind))
    );
}

/** An unmarked feed is the east feed; a west/pacific one must say so. */
function feedsAgree(
    query: EpgNameAnalysis,
    candidate: EpgNameAnalysis
): boolean {
    return (query.feed ?? 'east') === (candidate.feed ?? 'east');
}

function feedRank(name: EpgNameAnalysis): number {
    return name.feed ? 1 : 0;
}

/**
 * For `partial`: the share of the longer name's characters covered by the
 * shorter one when one token set strictly contains the other, numbers agree
 * and the shorter side has two tokens and a real word; otherwise 0. A local
 * station's channel number may be missing on the shorter side
 * (`NET 5 City` ↔ `NET City`) when both name the same network.
 */
function coverageOf(
    query: EpgNameAnalysis,
    candidate: EpgNameAnalysis
): number {
    const [short, long] =
        query.tokens.length <= candidate.tokens.length
            ? [query, candidate]
            : [candidate, query];
    if (short.tokens.length < 2 || short.tokens.length === long.tokens.length) {
        return 0;
    }
    if (
        !short.tokens.some((token) => token.length >= 3 && /\p{L}/u.test(token))
    ) {
        return 0;
    }
    const longTokens = new Set(long.tokens);
    if (!short.tokens.every((token) => longTokens.has(token))) return 0;
    // Only detail may be extra: bracketed words, a network name, `show`
    // (`The Sample Show` = `Sample`) or a local station's number. Any other word (`Sample Sports Golf`) is likely a
    // sibling channel of the same brand.
    const shortTokens = new Set(short.tokens);
    const extra = long.tokens.filter((token) => !shortTokens.has(token));
    if (
        !extra.every(
            (token) =>
                // `(City)` or a one-letter tag; `(XY)` is a regional feed.
                (long.bracketed.includes(token) && token.length !== 2) ||
                BROADCAST_NETWORKS.has(token) ||
                token === 'show' ||
                /^\p{N}+$/u.test(token)
        )
    ) {
        return 0;
    }
    let longLength = long.squashed.length;
    if (query.numbers !== candidate.numbers) {
        const stationNumber = !short.numbers && short.networks.length > 0;
        if (!stationNumber) return 0;
        longLength -= long.numbers.replace(/ /gu, '').length;
    }
    return short.squashed.length / longLength;
}
