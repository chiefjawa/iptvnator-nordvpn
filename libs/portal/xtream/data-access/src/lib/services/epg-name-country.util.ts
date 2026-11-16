/**
 * Country hints for the automatic XMLTV name match: a playlist prefix
 * (`US: `, `UK| `) or category prefix maps to the XMLTV id suffixes
 * (`.us`, `.uk`) a matching guide channel may carry.
 */

/**
 * Playlist/category prefixes whose region differs from the two-letter
 * code they look like, or that cover several guide countries. Any other
 * two-letter prefix stands for itself.
 */
const LATIN_AMERICA = [
    'latino',
    ...'mx ar co cl pe ve ec cr pa gt hn sv ni do pr bo py uy cu'.split(' '),
];

const REGION_SUFFIXES: Readonly<Record<string, readonly string[]>> = {
    usa: ['us'],
    gb: ['uk'],
    uk: ['uk'],
    // `AR` in playlists is mostly Arabic, not Argentina (`ARG`).
    ar: ['sa', 'ae', 'qa', 'eg', 'lb', 'kw', 'jo', 'iq', 'om', 'bh'],
    arg: ['ar'],
    arab: ['sa', 'ae', 'qa', 'eg', 'lb', 'kw', 'jo', 'iq', 'om', 'bh'],
    la: LATIN_AMERICA,
    latino: LATIN_AMERICA,
    afr: ['za', 'ng', 'ke', 'gh', 'tz', 'ug', 'zw', 'zm', 'mz', 'na', 'bw'],
    exyu: ['hr', 'rs', 'ba', 'si', 'mk', 'me'],
    sr: ['rs'],
    de: ['de', 'at', 'ch'],
    at: ['at', 'de'],
    ch: ['ch', 'de', 'fr', 'it'],
    be: ['be', 'nl', 'fr'],
    nl: ['nl', 'be'],
    ie: ['ie', 'uk'],
    gr: ['gr', 'cy'],
    cy: ['cy', 'gr'],
};

/**
 * ISO 3166-1 alpha-2 codes (plus `uk`): any other two-letter prefix
 * (`XY: `) is a provider or package tag, not a country.
 */
const COUNTRY_CODES = new Set(
    (
        'ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh ' +
        'bi bj bl bm bn bo bq br bs bt bv bw by bz ca cc cd cf cg ch ci ck cl ' +
        'cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg eh er es et ' +
        'fi fj fk fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu ' +
        'gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke ' +
        'kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc ' +
        'md me mf mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ' +
        'ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt ' +
        'pw py qa re ro rs ru rw sa sb sc sd se sg sh si sj sk sl sm sn so sr ' +
        'ss st sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ' +
        'ug um us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw uk'
    ).split(' ')
);
/** Country codes that playlists use as other tags (`TV: `). */
const NOT_COUNTRIES = new Set(['tv']);

/**
 * Guide country of an XMLTV id (`sample.us` → `us`, `sample.uk.plus1` →
 * `uk`, `sample.latino` → `latino`), or `null`.
 */
export function epgChannelIdCountry(id: string): string | null {
    const match = /\.([a-z]{2}|latino)(?:\.plus\d)?$/iu.exec(id.trim());
    return match ? match[1].toLowerCase() : null;
}

/** Guide countries a playlist prefix stands for, or `null` without a hint. */
export function countrySuffixesForPrefix(
    prefix: string | null | undefined
): readonly string[] | null {
    const key = (prefix ?? '').toLowerCase();
    if (!key) return null;
    const mapped = REGION_SUFFIXES[key];
    if (mapped) return mapped;
    return COUNTRY_CODES.has(key) && !NOT_COUNTRIES.has(key) ? [key] : null;
}
