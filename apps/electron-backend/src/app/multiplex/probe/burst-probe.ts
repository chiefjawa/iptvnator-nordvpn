/**
 * Provider burst probe for connection multiplexing.
 *
 * Opens one live MPEG-TS channel, measures the opening burst, then closes
 * and reopens it after growing pauses — the same pattern the multiplexer
 * would impose on the server while it visits other tiles. The report says
 * whether that server can support sharing one connection at all.
 *
 * Exactly one connection is ever open: each is fully closed before the next
 * pause starts. The report holds measurements only, never the URL.
 */

import { Readable } from 'node:stream';
import { XTREAM_CLIENT_USER_AGENT } from '@iptvnator/shared/interfaces';
import { requestWithValidatedRedirects } from '../../util/validated-axios';
import {
    BurstAnalyzer,
    compareReopen,
    ConnectionSummary,
} from './burst-analyzer';

const CONNECT_TIMEOUT_MS = 15000;
const CLOSE_TIMEOUT_MS = 3000;
/** Keep reading this long after pacing settles, to be sure it has. */
const SETTLED_MS = 3000;

export const DEFAULT_BURST_PROBE_HOLD_MS = 25000;
export const DEFAULT_BURST_PROBE_REOPEN_DELAYS_MS = [2000, 5000, 10000, 20000];

export interface BurstProbeRequest {
    readonly url: string;
    readonly userAgent?: string | null;
    readonly referer?: string | null;
    readonly origin?: string | null;
    /** Longest time one connection is read. */
    readonly holdMs?: number;
    readonly reopenDelaysMs?: readonly number[];
}

export interface BurstProbeReopen {
    readonly delayMs: number;
    readonly status: number;
    readonly connectMs: number;
    readonly burstMediaSec: number;
    readonly burstMbit: number;
    readonly overlapSec: number;
    readonly timestampsContinuous: boolean;
    readonly fingerprintMatched: boolean;
}

export interface BurstProbeReport {
    readonly status: number;
    readonly connectMs: number;
    readonly redirected: boolean;
    readonly burstMediaSec: number;
    readonly burstWallMs: number;
    readonly burstMbit: number;
    readonly mediaBitrateMbit: number;
    readonly realtimeAfterMs: number | null;
    readonly gopSec: number;
    readonly codecs: { readonly video: string; readonly audio: string };
    readonly reopens: readonly BurstProbeReopen[];
}

export interface OpenedUpstream {
    readonly status: number;
    readonly redirected: boolean;
    readonly stream: Readable;
}

export interface BurstProbeDeps {
    open(request: BurstProbeRequest): Promise<OpenedUpstream>;
    sleep(ms: number): Promise<void>;
    now(): number;
}

interface Measured {
    readonly status: number;
    readonly connectMs: number;
    readonly redirected: boolean;
    readonly summary: ConnectionSummary | null;
}

export async function openLiveUpstream(
    request: BurstProbeRequest
): Promise<OpenedUpstream> {
    const response = await requestWithValidatedRedirects<Readable>(
        request.url,
        {
            method: 'GET',
            responseType: 'stream',
            timeout: CONNECT_TIMEOUT_MS,
            validateStatus: () => true,
            headers: {
                'User-Agent':
                    request.userAgent?.trim() || XTREAM_CLIENT_USER_AGENT,
                ...(request.referer?.trim()
                    ? { Referer: request.referer.trim() }
                    : {}),
                ...(request.origin?.trim()
                    ? { Origin: request.origin.trim() }
                    : {}),
            },
        },
        {
            allowPrivateNetworkRedirects: false,
            allowPrivateNetworks: true,
            pinAllowedPrivateNetworkHosts: true,
        }
    );

    return {
        status: response.status,
        redirected: isRedirected(request.url, response.config?.url),
        stream: response.data,
    };
}

const defaultDeps: BurstProbeDeps = {
    open: openLiveUpstream,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => performance.now(),
};

export async function runBurstProbe(
    request: BurstProbeRequest,
    deps: BurstProbeDeps = defaultDeps
): Promise<BurstProbeReport> {
    const holdMs = request.holdMs ?? DEFAULT_BURST_PROBE_HOLD_MS;
    const delays =
        request.reopenDelaysMs ?? DEFAULT_BURST_PROBE_REOPEN_DELAYS_MS;

    const first = await measureConnection(request, holdMs, deps);
    const reopens: BurstProbeReopen[] = [];
    let previous = first.summary;

    for (const delayMs of previous ? delays : []) {
        await deps.sleep(delayMs);
        const next = await measureConnection(request, holdMs, deps);
        const comparison =
            previous && next.summary
                ? compareReopen(previous, next.summary, delayMs / 1000)
                : {
                      overlapSec: 0,
                      timestampsContinuous: false,
                      fingerprintMatched: false,
                  };
        reopens.push({
            delayMs,
            status: next.status,
            connectMs: next.connectMs,
            burstMediaSec: next.summary?.burstMediaSec ?? 0,
            burstMbit: next.summary?.burstMbit ?? 0,
            ...comparison,
        });
        previous = next.summary ?? previous;
    }

    const summary = first.summary;
    return {
        status: first.status,
        connectMs: first.connectMs,
        redirected: first.redirected,
        burstMediaSec: summary?.burstMediaSec ?? 0,
        burstWallMs: summary?.burstWallMs ?? 0,
        burstMbit: summary?.burstMbit ?? 0,
        mediaBitrateMbit: summary?.mediaBitrateMbit ?? 0,
        realtimeAfterMs: summary?.realtimeAfterMs ?? null,
        gopSec: summary?.gopSec ?? 0,
        codecs: {
            video: summary?.videoCodec ?? 'none',
            audio: summary?.audioCodec ?? 'none',
        },
        reopens,
    };
}

async function measureConnection(
    request: BurstProbeRequest,
    holdMs: number,
    deps: BurstProbeDeps
): Promise<Measured> {
    const startedAt = deps.now();
    let opened: OpenedUpstream;
    try {
        opened = await deps.open(request);
    } catch {
        // No response at all (timeout, refused, unsafe redirect).
        return {
            status: 0,
            connectMs: Math.round(deps.now() - startedAt),
            redirected: false,
            summary: null,
        };
    }

    const connectMs = Math.round(deps.now() - startedAt);
    const { status, redirected, stream } = opened;
    if (status < 200 || status >= 300) {
        await closeStream(stream);
        return { status, connectMs, redirected, summary: null };
    }

    const analyzer = new BurstAnalyzer();
    await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, holdMs);
        const finish = () => {
            clearTimeout(timer);
            resolve();
        };
        stream.on('data', (chunk: Buffer) => {
            const now = deps.now();
            analyzer.push(chunk, now);
            if (analyzer.hasSettled(now, SETTLED_MS)) {
                finish();
            }
        });
        stream.once('end', finish);
        stream.once('error', finish);
    });
    await closeStream(stream);

    const summary = analyzer.summarize();
    return {
        status,
        connectMs,
        redirected,
        summary: summary.firstPts === null ? null : summary,
    };
}

/** Destroys the response and waits until its socket is really closed. */
async function closeStream(stream: Readable): Promise<void> {
    stream.removeAllListeners('data');
    if (stream.closed) {
        return;
    }
    await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
        stream.once('close', () => {
            clearTimeout(timer);
            resolve();
        });
        // A late error after destroy must not surface as unhandled.
        stream.on('error', () => undefined);
        stream.destroy();
    });
}

function isRedirected(requested: string, final: string | undefined): boolean {
    if (!final) {
        return false;
    }
    try {
        return new URL(requested).host !== new URL(final).host;
    } catch {
        return false;
    }
}
