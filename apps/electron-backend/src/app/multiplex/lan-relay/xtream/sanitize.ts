/**
 * Removes every trace of the provider from its API answers.
 *
 * Provider JSON is turned into a template once, when it is fetched: string
 * values that are provider URLs become relay URLs with placeholders for the
 * relay's address and the local login, other provider URLs and every
 * `direct_source` are blanked, and any remaining occurrence of the provider
 * host or account is replaced. Only templates are stored on disk, so the
 * cache never holds the account either. `renderTemplate` fills in the
 * placeholders for the client that asked.
 */

export const PLACEHOLDER = {
    origin: '@@relay-origin@@',
    host: '@@relay-host@@',
    user: '@@relay-user@@',
    pass: '@@relay-pass@@',
} as const;

/** Path kinds of Xtream stream URLs that the relay serves itself. */
const STREAM_KINDS = new Set(['live', 'movie', 'series', 'timeshift']);
/** Credentials this short are only replaced inside URLs (see docs). */
const MIN_FREE_TEXT_SECRET = 6;

export interface ProviderIdentity {
    /** Hostnames (lower case) that belong to the provider. */
    readonly hostnames: readonly string[];
    readonly username: string;
    readonly password: string;
}

export interface RenderContext {
    /** `http://<host>:<port>` as the client reached the relay. */
    readonly origin: string;
    readonly host: string;
    readonly username: string;
    readonly password: string;
}

export class ProviderSanitizer {
    /** Provider URLs and direct sources removed since start. */
    blanked = 0;
    private readonly hosts: Set<string>;
    private readonly freeText: [string, string][];

    constructor(private readonly provider: ProviderIdentity) {
        this.hosts = new Set(provider.hostnames.map((h) => h.toLowerCase()));
        const pairs: [string, string][] = [];
        for (const host of this.hosts) {
            pairs.push([host, PLACEHOLDER.host]);
        }
        for (const [value, placeholder] of [
            [provider.username, PLACEHOLDER.user],
            [provider.password, PLACEHOLDER.pass],
        ] as const) {
            if (value.length >= MIN_FREE_TEXT_SECRET) {
                pairs.push([value, placeholder]);
                pairs.push([encodeURIComponent(value), placeholder]);
            }
        }
        // Longest first, so a value containing another is replaced whole.
        this.freeText = pairs.sort((a, b) => b[0].length - a[0].length);
    }

    /** Provider JSON to a template string. */
    templateJson(value: unknown): string {
        return JSON.stringify(this.clean(value, ''));
    }

    /** Free text (XMLTV): provider host and account replaced by neutral text. */
    scrubText(text: string): string {
        let result = text;
        for (const [secret, placeholder] of this.freeText) {
            const neutral =
                placeholder === PLACEHOLDER.host ? 'relay.invalid' : 'x';
            result = result.split(secret).join(neutral);
        }
        return result;
    }

    /** Longest secret, for scrubbing text that arrives in chunks. */
    get longestSecret(): number {
        return this.freeText[0]?.[0].length ?? 0;
    }

    private clean(value: unknown, key: string): unknown {
        if (typeof value === 'string') {
            return this.cleanString(value, key);
        }
        if (Array.isArray(value)) {
            return value.map((entry) => this.clean(entry, key));
        }
        if (value && typeof value === 'object') {
            const out: Record<string, unknown> = {};
            for (const [name, entry] of Object.entries(value)) {
                out[name] = this.clean(entry, name);
            }
            return out;
        }
        return value;
    }

    private cleanString(value: string, key: string): string {
        if (key === 'direct_source') {
            if (value) {
                this.blanked += 1;
            }
            return '';
        }
        if (value.includes('://')) {
            const rewritten = this.rewriteUrl(value);
            if (rewritten !== null) {
                return rewritten;
            }
        }
        return this.replaceFreeText(value);
    }

    /** A relay URL, '' for a provider URL it cannot serve, null otherwise. */
    private rewriteUrl(value: string): string | null {
        let url: URL;
        try {
            url = new URL(value.trim());
        } catch {
            return null;
        }
        const own = this.hosts.has(url.hostname.toLowerCase());
        const segments = url.pathname.split('/').slice(1).map(safeDecode);
        const credentialAt = this.credentialIndex(segments);
        if (!own && credentialAt < 0 && !this.hasAccount(value)) {
            return null;
        }
        // Any server of the account (panels often have several names).
        if (credentialAt >= 0 && !url.search) {
            const kind = segments.slice(0, credentialAt);
            const rest = segments.slice(credentialAt + 2);
            const plain =
                kind.length === 0 ||
                (kind.length === 1 && STREAM_KINDS.has(kind[0]));
            if (plain && rest.length > 0) {
                return [
                    PLACEHOLDER.origin,
                    ...kind,
                    PLACEHOLDER.user,
                    PLACEHOLDER.pass,
                    ...rest.map((part) => encodeURIComponent(part)),
                ].join('/');
            }
        }
        // Provider-hosted artwork or any URL carrying the account: the
        // relay does not serve it, and it must not reach the client.
        this.blanked += 1;
        return '';
    }

    private credentialIndex(segments: readonly string[]): number {
        for (let i = 0; i + 1 < segments.length && i <= 1; i += 1) {
            if (
                segments[i] === this.provider.username &&
                segments[i + 1] === this.provider.password
            ) {
                return i;
            }
        }
        return -1;
    }

    private hasAccount(value: string): boolean {
        const { username, password } = this.provider;
        return [username, password].some(
            (secret) =>
                secret.length >= 3 &&
                (value.includes(secret) ||
                    value.includes(encodeURIComponent(secret)))
        );
    }

    private replaceFreeText(value: string): string {
        let result = value;
        for (const [secret, placeholder] of this.freeText) {
            if (result.includes(secret)) {
                result = result.split(secret).join(placeholder);
            }
        }
        return result;
    }
}

/** Fills a template's placeholders for one client. */
export function renderTemplate(
    template: string,
    context: RenderContext
): string {
    const json = (text: string) => JSON.stringify(text).slice(1, -1);
    return template
        .split(PLACEHOLDER.origin)
        .join(json(context.origin))
        .split(PLACEHOLDER.host)
        .join(json(context.host))
        .split(PLACEHOLDER.user)
        .join(json(encodeURIComponent(context.username)))
        .split(PLACEHOLDER.pass)
        .join(json(encodeURIComponent(context.password)));
}

function safeDecode(part: string): string {
    try {
        return decodeURIComponent(part);
    } catch {
        return part;
    }
}
