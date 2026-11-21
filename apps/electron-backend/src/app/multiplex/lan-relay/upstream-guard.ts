/**
 * Wraps the live opener: every attempt passes the shared `UpstreamGate`,
 * is counted for `/status`, and a connection that stops delivering (a
 * dropped VPN tunnel often leaves a silent socket rather than an error) is
 * destroyed after `stallMs`, so the scheduler backs off and reconnects.
 */

import { PassThrough } from 'node:stream';
import {
    MultiplexClock,
    OpenUpstream,
    UpstreamHandle,
} from '../scheduler/scheduler-types';
import { RelayLogger } from './relay-log';
import { UpstreamStatus } from './relay-status';
import { UpstreamGate } from './upstream-gate';

export interface GuardDeps {
    readonly open: OpenUpstream;
    readonly gate: UpstreamGate;
    readonly clock: MultiplexClock;
    readonly stallMs: number;
    /** Stream id for a URL, for logs; the URL itself is never logged. */
    readonly idOf: (url: string) => number | null;
    readonly log?: RelayLogger;
}

export function guardedOpen(deps: GuardDeps): {
    open: OpenUpstream;
    status: UpstreamStatus;
} {
    const status: UpstreamStatus = {
        open: false,
        streamId: null,
        opens: 0,
        attempts: 0,
        refusals: 0,
        errors: 0,
        lastStatus: null,
        maxOpenAtOnce: 0,
        stalls: 0,
    };
    let openNow = 0;

    const open: OpenUpstream = async (source, signal) => {
        const streamId = deps.idOf(source.url);
        status.attempts += 1;
        if (!deps.gate.tryEnter('live')) {
            // The scheduler never does this while VOD is idle; refuse rather
            // than open a second connection.
            deps.log?.warn(
                `refused to open a second connection for ${streamId}`
            );
            return { status: 0, stream: null, close: async () => undefined };
        }
        let handle: UpstreamHandle;
        try {
            handle = await deps.open(source, signal);
        } catch (error) {
            deps.gate.leave();
            status.errors += 1;
            status.lastStatus = 0;
            deps.log?.warn(
                `upstream open failed for ${streamId}: ${errorKind(error)}`
            );
            throw error;
        }
        status.lastStatus = handle.status;
        let left = false;
        const leave = () => {
            if (!left) {
                left = true;
                deps.gate.leave();
            }
        };
        if (!handle.stream) {
            status.refusals += 1;
            deps.log?.warn(
                `upstream refused ${streamId} with HTTP ${handle.status}`
            );
            return {
                ...handle,
                close: async () => {
                    await handle.close();
                    leave();
                },
            };
        }
        openNow += 1;
        status.opens += 1;
        status.maxOpenAtOnce = Math.max(status.maxOpenAtOnce, openNow);
        status.open = true;
        status.streamId = streamId;
        const watched = watchStalls(handle, deps, () => {
            status.stalls += 1;
            deps.log?.warn(
                `upstream for ${streamId} delivered nothing for ${Math.round(deps.stallMs / 1000)}s; dropping it`
            );
        });
        let closed = false;
        return {
            status: handle.status,
            stream: watched.stream,
            close: async () => {
                watched.stop();
                await handle.close();
                if (!closed) {
                    closed = true;
                    openNow -= 1;
                    status.open = openNow > 0;
                    status.streamId = status.open ? status.streamId : null;
                    leave();
                }
            },
        };
    };
    return { open, status };
}

/** Passes the body through, ending it if nothing arrives for `stallMs`. */
function watchStalls(
    handle: UpstreamHandle,
    deps: GuardDeps,
    onStall: () => void
): { stream: PassThrough; stop(): void } {
    const source = handle.stream as NonNullable<UpstreamHandle['stream']>;
    const output = new PassThrough();
    let lastAt = deps.clock.now();
    let stopped = false;
    source.on('data', (chunk: Buffer) => {
        lastAt = deps.clock.now();
        if (!output.write(chunk)) {
            source.pause();
            output.once('drain', () => source.resume());
        }
    });
    const end = () => {
        if (!output.destroyed) {
            output.end();
            // The scheduler listens for 'close'; ending alone is not enough.
            output.destroy();
        }
    };
    source.once('end', end);
    source.once('error', end);
    source.once('close', end);
    const check = async () => {
        while (!stopped && deps.stallMs > 0) {
            await deps.clock.sleep(Math.min(1000, deps.stallMs / 4));
            if (!stopped && deps.clock.now() - lastAt >= deps.stallMs) {
                onStall();
                end();
                return;
            }
        }
    };
    void check();
    return {
        stream: output,
        stop: () => {
            stopped = true;
            end();
        },
    };
}

/** An error's code or class, never its message (it may hold the URL). */
export function errorKind(error: unknown): string {
    if (typeof error === 'object' && error !== null) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code)) {
            return code;
        }
        return (error as { name?: string }).name ?? 'Error';
    }
    return 'Error';
}
