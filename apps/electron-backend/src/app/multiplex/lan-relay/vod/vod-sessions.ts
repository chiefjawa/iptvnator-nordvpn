/**
 * Movies, episodes and catch-up on an account with one connection.
 *
 * A VOD stream needs the connection to itself. The rules, kept simple:
 *
 * - No live channel has clients: idle channels are dropped, the live
 *   rotation has nothing to do, and the movie gets the connection.
 * - Live channels have clients: `refuse` (default) answers 503; `preempt`
 *   suspends the live rotation (its clients play out their reserve, then
 *   get keep-alive and finally a clean end) and resumes it after the movie.
 * - While a movie session exists, new live requests get 503 (see
 *   `LanRelay.attach`), and so does a second movie.
 *
 * Players open several ranged requests for one movie (probe, play, seek).
 * Requests for the same item from the same address form one session; a
 * newer one cancels the older upstream request and waits until its socket
 * is closed before opening, so there is never more than one connection.
 * The session ends `lingerMs` after its last request finished.
 */

import { ServerResponse } from 'node:http';
import { RelayLogger } from '../relay-log';
import { UpstreamGate } from '../upstream-gate';
import { errorKind } from '../upstream-guard';
import {
    OpenVod,
    VodUpstreamRequest,
    VodUpstreamResponse,
} from './vod-upstream';

export interface LiveControl {
    hasClients(): boolean;
    dropIdleChannels(): void;
    suspendLive(): Promise<void>;
    resumeLive(): void;
}

export interface VodRequest extends VodUpstreamRequest {
    /** Same item from the same address: `<remote>|<kind>|<item>`. */
    readonly sessionKey: string;
    /** Item description for logs and status (kind and id, no URL). */
    readonly label: string;
    readonly remote: string;
}

export interface VodCounters {
    sessions: number;
    requests: number;
    superseded: number;
    refusedLive: number;
    refusedBusy: number;
    upstreamErrors: number;
    bytes: number;
}

export interface VodStatus extends VodCounters {
    policy: 'refuse' | 'preempt';
    session: {
        label: string;
        remote: string;
        ageSec: number;
        requests: number;
        streaming: boolean;
        preemptedLive: boolean;
    } | null;
}

interface Transfer {
    readonly abort: AbortController;
    readonly done: Promise<void>;
}

interface Session {
    readonly key: string;
    readonly label: string;
    readonly remote: string;
    readonly startedAtMs: number;
    readonly preempted: boolean;
    requests: number;
    current: Transfer | null;
    linger: NodeJS.Timeout | null;
}

export interface VodArbiterDeps {
    readonly gate: UpstreamGate;
    readonly live: LiveControl;
    readonly open: OpenVod;
    readonly policy: 'refuse' | 'preempt';
    readonly log?: RelayLogger;
    readonly lingerMs?: number;
    readonly gateTimeoutMs?: number;
}

export class VodArbiter {
    private session: Session | null = null;
    private readonly counters: VodCounters = {
        sessions: 0,
        requests: 0,
        superseded: 0,
        refusedLive: 0,
        refusedBusy: 0,
        upstreamErrors: 0,
        bytes: 0,
    };

    constructor(private readonly deps: VodArbiterDeps) {}

    /** True while a session owns (or is about to own) the connection. */
    get active(): boolean {
        return this.session !== null;
    }

    async handle(request: VodRequest, response: ServerResponse): Promise<void> {
        this.counters.requests += 1;
        const session = await this.sessionFor(request, response);
        if (!session) {
            return;
        }
        if (session.linger) {
            clearTimeout(session.linger);
            session.linger = null;
        }
        session.requests += 1;
        // Claim the session at once: a newer request supersedes this one
        // even while it is still waiting for the previous one to close.
        const previous = session.current;
        let finished!: () => void;
        const transfer: Transfer = {
            abort: new AbortController(),
            done: new Promise<void>((resolve) => (finished = resolve)),
        };
        session.current = transfer;
        const signal = transfer.abort.signal;
        response.once('close', () => transfer.abort.abort());
        let entered = false;
        try {
            if (previous) {
                this.counters.superseded += 1;
                previous.abort.abort();
                await previous.done;
            }
            if (!signal.aborted && !response.destroyed) {
                entered = await this.enterGate(signal);
                if (entered) {
                    await this.transfer(request, response, signal);
                } else if (!signal.aborted) {
                    this.deps.log?.warn(
                        `vod ${session.label}: the connection did not become free`
                    );
                }
            }
            refuse(response, 503);
        } finally {
            if (entered) {
                this.deps.gate.leave();
            }
            if (session.current === transfer) {
                session.current = null;
            }
            finished();
            this.scheduleEnd(session);
        }
    }

    /** Aborts the session's transfer (shutdown); resolves once closed. */
    async stop(): Promise<void> {
        const session = this.session;
        if (session?.current) {
            session.current.abort.abort();
            await session.current.done;
        }
        if (session?.linger) {
            clearTimeout(session.linger);
        }
        this.session = null;
    }

    status(nowMs = Date.now()): VodStatus {
        const session = this.session;
        return {
            policy: this.deps.policy,
            ...this.counters,
            session: session
                ? {
                      label: session.label,
                      remote: session.remote,
                      ageSec: Math.round((nowMs - session.startedAtMs) / 1000),
                      requests: session.requests,
                      streaming: session.current !== null,
                      preemptedLive: session.preempted,
                  }
                : null,
        };
    }

    private async sessionFor(
        request: VodRequest,
        response: ServerResponse
    ): Promise<Session | null> {
        const previous = this.session;
        if (previous?.key === request.sessionKey) {
            return previous;
        }
        if (previous && previous.remote === request.remote) {
            // The same player moved to another item: it has left the old one.
            return this.replaceSession(previous, request);
        }
        if (previous) {
            this.counters.refusedBusy += 1;
            this.deps.log?.warn(
                `vod ${request.label} from ${request.remote} refused: another stream (${previous.label}) holds the connection`
            );
            refuse(response, 503);
            return null;
        }
        const live = this.deps.live.hasClients();
        if (live && this.deps.policy === 'refuse') {
            this.counters.refusedLive += 1;
            this.deps.log?.warn(
                `vod ${request.label} from ${request.remote} refused: live channels are being watched (vodPolicy refuse)`
            );
            refuse(response, 503);
            return null;
        }
        const session: Session = {
            key: request.sessionKey,
            label: request.label,
            remote: request.remote,
            startedAtMs: Date.now(),
            preempted: live,
            requests: 0,
            current: null,
            linger: null,
        };
        // Set before any await, so live requests are refused from now on.
        this.session = session;
        this.counters.sessions += 1;
        this.deps.log?.info(
            `vod session ${session.label} from ${session.remote}${live ? ' (live suspended)' : ''}`
        );
        if (live) {
            await this.deps.live.suspendLive();
        } else {
            this.deps.live.dropIdleChannels();
        }
        return session;
    }

    /** Waits (abortably) for the connection to be free, then takes it. */
    private async enterGate(signal: AbortSignal): Promise<boolean> {
        const deadline = Date.now() + (this.deps.gateTimeoutMs ?? 10_000);
        while (!signal.aborted && Date.now() < deadline) {
            if (this.deps.gate.tryEnter('vod')) {
                return true;
            }
            await this.deps.gate.whenIdle(250);
        }
        return false;
    }

    private async replaceSession(
        previous: Session,
        request: VodRequest
    ): Promise<Session> {
        const session: Session = {
            ...previous,
            key: request.sessionKey,
            label: request.label,
            startedAtMs: Date.now(),
            requests: 0,
            current: previous.current,
            linger: null,
        };
        if (previous.linger) {
            clearTimeout(previous.linger);
        }
        this.session = session;
        this.counters.sessions += 1;
        this.deps.log?.info(
            `vod session ${session.label} from ${session.remote} replaces ${previous.label}`
        );
        return session;
    }

    private async transfer(
        request: VodRequest,
        response: ServerResponse,
        signal: AbortSignal
    ): Promise<void> {
        let upstream: VodUpstreamResponse | null = null;
        try {
            upstream = await this.deps.open(request, signal);
        } catch (error) {
            if (!signal.aborted) {
                this.counters.upstreamErrors += 1;
                this.deps.log?.warn(
                    `vod ${request.label} upstream failed: ${errorKind(error)}`
                );
            }
            refuse(response, signal.aborted ? 503 : 502);
            return;
        }
        try {
            if (response.destroyed || signal.aborted) {
                return;
            }
            response.writeHead(upstream.status, {
                ...upstream.headers,
                'Cache-Control': 'no-store',
            });
            const body = upstream.body;
            if (!body || request.method === 'HEAD') {
                response.end();
                return;
            }
            await new Promise<void>((resolve) => {
                const done = () => resolve();
                signal.addEventListener('abort', done, { once: true });
                response.once('close', done);
                body.once('end', done);
                body.once('error', done);
                body.on('data', (chunk: Buffer) => {
                    this.counters.bytes += chunk.length;
                });
                body.pipe(response);
            });
        } finally {
            await upstream.close();
            if (!response.writableEnded) {
                response.destroy();
            }
        }
    }

    private scheduleEnd(session: Session): void {
        if (session.current || session.linger || this.session !== session) {
            return;
        }
        session.linger = setTimeout(() => {
            session.linger = null;
            if (session.current || this.session !== session) {
                return;
            }
            this.session = null;
            this.deps.log?.info(
                `vod session ${session.label} ended after ${session.requests} request(s)`
            );
            if (session.preempted) {
                this.deps.live.resumeLive();
            }
        }, this.deps.lingerMs ?? 3000);
    }
}

function refuse(response: ServerResponse, status: number): void {
    if (!response.headersSent && !response.destroyed) {
        response.writeHead(status, { 'Cache-Control': 'no-store' });
        response.end();
    } else if (!response.writableEnded) {
        response.destroy();
    }
}
