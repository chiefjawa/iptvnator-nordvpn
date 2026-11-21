/**
 * `player_api.php` and `get.php` of the relay, answered from the provider's
 * API through the sanitizer and the disk cache.
 *
 * The provider is asked with the real account; the client sees its local
 * login, the relay's address, the relay's capacity and connection count,
 * and stream URLs that point at the relay. Stream ids are the provider's,
 * so a player's favourites keep working after it is re-pointed here.
 */

import { RelayConfig } from '../relay-config';
import { RelayLogger } from '../relay-log';
import { DiskCache } from './api-cache';
import { ProviderApi, ProviderRequestError } from './provider-api';
import { ProviderSanitizer, RenderContext, renderTemplate } from './sanitize';

const CATALOGUE_ACTIONS = new Set([
    'get_live_categories',
    'get_live_streams',
    'get_vod_categories',
    'get_vod_streams',
    'get_vod_info',
    'get_series_categories',
    'get_series',
    'get_series_info',
]);
const SHORT_ACTIONS = new Set(['get_short_epg', 'get_simple_data_table']);
const PARAM_NAME = /^[a-z_]{1,32}$/;
const ACTION_NAME = /^[a-z_]{1,48}$/;

export const BAD_LOGIN = JSON.stringify({ user_info: { auth: 0 } });

export interface LiveCounts {
    /** Live clients plus one while a movie streams. */
    activeConnections(): number;
}

export interface FrontAnswer {
    readonly status: number;
    readonly body: string;
}

type Json = Record<string, unknown>;

export class XtreamFront {
    private readonly names = new Map<number, string>();
    private namesLoaded = false;

    constructor(
        private readonly config: RelayConfig,
        private readonly api: ProviderApi,
        private readonly cache: DiskCache,
        private readonly sanitizer: ProviderSanitizer,
        private readonly counts: LiveCounts,
        private readonly log?: RelayLogger
    ) {}

    /** Channel name for logs and status, from the cached catalogue. */
    nameOf(streamId: number): string | undefined {
        return this.names.get(streamId);
    }

    /** Loads the live catalogue (from disk, or the provider) for names. */
    async warm(): Promise<void> {
        try {
            await this.template('get_live_streams', {});
        } catch (error) {
            this.log?.warn(`catalogue warm-up failed: ${kindOf(error)}`);
        }
    }

    /** Answers one `player_api.php` request from an authenticated client. */
    async playerApi(
        query: URLSearchParams,
        context: RenderContext
    ): Promise<FrontAnswer> {
        const action = query.get('action') ?? '';
        if (action && !ACTION_NAME.test(action)) {
            return { status: 400, body: '[]' };
        }
        const params = forwardedParams(query);
        try {
            if (!action) {
                return { status: 200, body: await this.login(context) };
            }
            const template = await this.template(action, params);
            return { status: 200, body: renderTemplate(template, context) };
        } catch (error) {
            const kind = kindOf(error);
            this.log?.warn(`player_api ${action || 'login'} failed: ${kind}`);
            // A refused provider login looks like a bad login to the player.
            return {
                status: kind === 'auth' ? 200 : 502,
                body: action ? '[]' : BAD_LOGIN,
            };
        }
    }

    /** Sanitized template of an action, through the cache. */
    async template(
        action: string,
        params: Record<string, string>
    ): Promise<string> {
        const key = cacheKey(action, params);
        const catalogue = CATALOGUE_ACTIONS.has(action);
        const ttlSec = catalogue
            ? this.config.cache.catalogueTtlSec
            : this.config.cache.shortTtlSec;
        const group = catalogue || SHORT_ACTIONS.has(action) ? action : 'other';
        const hit = await this.cache.get(
            group,
            key,
            ttlSec * 1000,
            async () => {
                const value = await this.api.playerApi({ action, ...params });
                if (isBadLogin(value)) {
                    throw new ProviderRequestError('auth');
                }
                return Buffer.from(this.sanitizer.templateJson(value));
            }
        );
        const text = hit.body.toString('utf8');
        if (action === 'get_live_streams' && !params['category_id']) {
            this.indexNames(text, hit.state !== 'fresh' || !this.namesLoaded);
        }
        return text;
    }

    private async login(context: RenderContext): Promise<string> {
        const hit = await this.cache.get(
            'login',
            'login',
            this.config.cache.loginTtlSec * 1000,
            async () => {
                const value = await this.api.playerApi({});
                if (
                    isBadLogin(value) ||
                    !isRecord(value) ||
                    !isRecord(value['user_info'])
                ) {
                    throw new ProviderRequestError('auth');
                }
                return Buffer.from(this.sanitizer.templateJson(value));
            }
        );
        const value = JSON.parse(
            renderTemplate(hit.body.toString('utf8'), context)
        ) as Json;
        const port = portOf(context.origin);
        const user = { ...(value['user_info'] as Json) };
        user['username'] = context.username;
        user['password'] = context.password;
        user['max_connections'] = String(this.config.maxLiveChannels);
        user['active_cons'] = String(this.counts.activeConnections());
        user['allowed_output_formats'] = ['ts'];
        const server = isRecord(value['server_info'])
            ? { ...value['server_info'] }
            : {};
        server['url'] = context.host;
        server['port'] = port;
        server['https_port'] = port;
        server['server_protocol'] = 'http';
        server['rtmp_port'] = port;
        return JSON.stringify({
            ...value,
            user_info: user,
            server_info: server,
        });
    }

    private indexNames(template: string, rebuild: boolean): void {
        if (!rebuild) {
            return;
        }
        try {
            const list = JSON.parse(template) as unknown;
            if (!Array.isArray(list)) {
                return;
            }
            this.names.clear();
            for (const entry of list) {
                if (isRecord(entry)) {
                    const id = Number(entry['stream_id']);
                    const name = entry['name'];
                    if (Number.isSafeInteger(id) && typeof name === 'string') {
                        this.names.set(id, cleanName(name));
                    }
                }
            }
            this.namesLoaded = true;
        } catch {
            this.log?.warn('live catalogue could not be indexed');
        }
    }
}

/** Query parameters passed on to the provider: everything but the login. */
export function forwardedParams(
    query: URLSearchParams
): Record<string, string> {
    const params: Record<string, string> = {};
    for (const [name, value] of query) {
        if (
            name !== 'username' &&
            name !== 'password' &&
            name !== 'action' &&
            PARAM_NAME.test(name) &&
            value.length <= 256
        ) {
            params[name] = value;
        }
    }
    return params;
}

function cacheKey(action: string, params: Record<string, string>): string {
    const sorted = Object.keys(params)
        .sort()
        .map((name) => `${name}=${params[name]}`);
    return [action, ...sorted].join('&');
}

function isBadLogin(value: unknown): boolean {
    if (!isRecord(value) || !isRecord(value['user_info'])) {
        return false;
    }
    const auth = value['user_info']['auth'];
    return auth === 0 || auth === '0' || auth === false;
}

function portOf(origin: string): string {
    try {
        const url = new URL(origin);
        return url.port || '80';
    } catch {
        return '80';
    }
}

function cleanName(name: string): string {
    return name
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f"]/g, ' ')
        .trim()
        .slice(0, 120);
}

function isRecord(value: unknown): value is Json {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function kindOf(error: unknown): string {
    return error instanceof ProviderRequestError
        ? error.kind
        : ((error as Error)?.name ?? 'Error');
}
