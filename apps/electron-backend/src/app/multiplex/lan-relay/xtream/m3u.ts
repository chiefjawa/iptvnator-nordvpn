/**
 * `get.php?type=m3u_plus`, generated from the cached catalogue.
 *
 * Live channels and movies are listed with relay URLs and the guide link
 * (`url-tvg`) pointing at the relay's `xmltv.php`. Series episodes are not
 * listed (a real panel expands every series, which needs one API request
 * per series); players that use the Xtream API get series from it instead.
 */

import { RenderContext, renderTemplate } from './sanitize';

type Json = Record<string, unknown>;

export interface CatalogueSource {
    template(action: string, params: Record<string, string>): Promise<string>;
}

export async function buildM3uPlus(
    source: CatalogueSource,
    context: RenderContext
): Promise<string> {
    const load = async (action: string): Promise<Json[]> => {
        const value = JSON.parse(
            renderTemplate(await source.template(action, {}), context)
        ) as unknown;
        return Array.isArray(value) ? (value as Json[]) : [];
    };
    const [liveCategories, live] = [
        await load('get_live_categories'),
        await load('get_live_streams'),
    ];
    let vodCategories: Json[] = [];
    let vod: Json[] = [];
    try {
        vodCategories = await load('get_vod_categories');
        vod = await load('get_vod_streams');
    } catch {
        // Live channels alone still make a usable playlist.
    }

    const user = encodeURIComponent(context.username);
    const pass = encodeURIComponent(context.password);
    const base = `${context.origin}`;
    const guide = `${base}/xmltv.php?username=${user}&password=${pass}`;
    const lines = [`#EXTM3U url-tvg="${guide}"`];

    const liveGroups = groupNames(liveCategories);
    for (const entry of live) {
        const id = Number(entry['stream_id']);
        if (!Number.isSafeInteger(id) || id <= 0) {
            continue;
        }
        lines.push(
            extinf(entry, liveGroups, String(entry['epg_channel_id'] ?? '')),
            `${base}/live/${user}/${pass}/${id}.ts`
        );
    }
    const vodGroups = groupNames(vodCategories);
    for (const entry of vod) {
        const id = Number(entry['stream_id']);
        const ext = String(entry['container_extension'] ?? 'mp4');
        if (
            !Number.isSafeInteger(id) ||
            id <= 0 ||
            !/^[a-z0-9]{1,5}$/i.test(ext)
        ) {
            continue;
        }
        lines.push(
            extinf(entry, vodGroups, ''),
            `${base}/movie/${user}/${pass}/${id}.${ext}`
        );
    }
    return `${lines.join('\n')}\n`;
}

function groupNames(categories: readonly Json[]): Map<string, string> {
    const names = new Map<string, string>();
    for (const category of categories) {
        const id = category['category_id'];
        const name = category['category_name'];
        if (
            (typeof id === 'string' || typeof id === 'number') &&
            typeof name === 'string'
        ) {
            names.set(String(id), name);
        }
    }
    return names;
}

function extinf(
    entry: Json,
    groups: Map<string, string>,
    tvgId: string
): string {
    const name = text(entry['name']);
    const logo = text(entry['stream_icon']);
    const group = text(groups.get(String(entry['category_id'] ?? '')) ?? '');
    return (
        `#EXTINF:-1 tvg-id="${attr(tvgId)}" tvg-name="${attr(name)}"` +
        ` tvg-logo="${attr(logo)}" group-title="${attr(group)}",${name}`
    );
}

function text(value: unknown): string {
    return typeof value === 'string'
        ? // eslint-disable-next-line no-control-regex
          value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
        : '';
}

function attr(value: string): string {
    return value.replace(/"/g, "'");
}
