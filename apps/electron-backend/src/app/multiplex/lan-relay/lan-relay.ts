/**
 * The standalone relay: one provider connection shared by every channel a
 * LAN player is watching.
 *
 * All configured channels form one group on one `GroupScheduler`, so the
 * scheduler's guarantees hold unchanged — close, confirm closed, gap, open;
 * backoff on refusal; never a second connection. A channel becomes a tile
 * when its first client arrives and stops being one a grace period after
 * its last client leaves. The relay holds each tile's reserve itself and
 * feeds it to the scheduler in place of a player's buffer report.
 */

import { GroupScheduler } from '../scheduler/group-scheduler';
import {
    MultiplexClock,
    OpenUpstream,
    systemClock,
    UpstreamHandle,
} from '../scheduler/scheduler-types';
import { buildLiveUrl, RelayConfig } from './relay-config';
import { RelayChannel } from './relay-channel';
import { ClientOutput, RelayClient } from './relay-client';
import { formatStatusLine, RelayLogger } from './relay-log';
import { channelStatus, RelayStatus, UpstreamStatus } from './relay-status';

export interface LanRelayDeps {
    readonly config: RelayConfig;
    readonly open: OpenUpstream;
    readonly clock?: MultiplexClock;
    readonly log?: RelayLogger;
}

/** A tick longer than this (a stalled event loop) is not paid out at once. */
const MAX_TICK_MS = 1000;

export class LanRelay {
    private readonly clock: MultiplexClock;
    private readonly channels = new Map<number, RelayChannel>();
    private readonly names = new Map<number, string>();
    /** Upstream URL to stream id; the URLs never leave this object. */
    private readonly urlIds = new Map<string, number>();
    private readonly scheduler: GroupScheduler;
    private readonly startedAtMs: number;
    private readonly upstream: UpstreamStatus = {
        open: false,
        streamId: null,
        opens: 0,
        attempts: 0,
        refusals: 0,
        errors: 0,
        lastStatus: null,
        maxOpenAtOnce: 0,
    };
    private openNow = 0;
    private nextClientId = 1;
    private loop: Promise<void> | null = null;
    private stopped = false;

    constructor(private readonly deps: LanRelayDeps) {
        this.clock = deps.clock ?? systemClock;
        this.startedAtMs = this.clock.now();
        for (const channel of deps.config.channels) {
            this.names.set(channel.streamId, channel.name);
            this.urlIds.set(
                buildLiveUrl(deps.config, channel.streamId),
                channel.streamId
            );
        }
        this.scheduler = new GroupScheduler({
            open: this.countingOpen,
            clock: this.clock,
            config: deps.config.scheduler,
            onVisitEnd: (tileId, summary) =>
                this.channels.get(Number(tileId))?.noteVisit(summary),
        });
    }

    get channelIds(): number[] {
        return [...this.names.keys()];
    }

    hasChannel(streamId: number): boolean {
        return this.names.has(streamId);
    }

    /** Starts the output pump. */
    start(): void {
        this.loop ??= this.run();
    }

    /** Connects a client to a channel; creates the channel's tile if needed. */
    attach(
        streamId: number,
        output: ClientOutput,
        remote: string
    ): RelayClient | null {
        const name = this.names.get(streamId);
        if (name === undefined || this.stopped) {
            return null;
        }
        let channel = this.channels.get(streamId);
        if (!channel) {
            channel = new RelayChannel(streamId, name, this.deps.config.tuning);
            this.channels.set(streamId, channel);
            this.scheduler.setTile(
                String(streamId),
                {
                    url: buildLiveUrl(this.deps.config, streamId),
                    userAgent: this.deps.config.userAgent,
                },
                channel
            );
            this.deps.log?.info(`channel ${streamId} "${name}" added`);
        }
        const client = channel.addClient(
            this.nextClientId++,
            remote,
            output,
            this.clock.now()
        );
        this.deps.log?.info(
            `client ${client.id} on ${streamId} from ${remote} (clients=${channel.clients.size})`
        );
        return client;
    }

    detach(streamId: number, client: RelayClient): void {
        const channel = this.channels.get(streamId);
        if (channel?.clients.has(client)) {
            channel.removeClient(client, this.clock.now());
            this.deps.log?.info(
                `client ${client.id} left ${streamId} after ${(client.counters.sentMediaMs / 1000).toFixed(1)}s (clients=${channel.clients.size})`
            );
        }
    }

    status(): RelayStatus {
        const now = this.clock.now();
        const states = new Map(
            this.scheduler.status().map((tile) => [tile.tileId, tile.state])
        );
        const channels = [...this.channels.values()].map((channel) =>
            channelStatus(
                channel,
                states.get(String(channel.streamId)) ?? 'idle',
                now
            )
        );
        return {
            uptimeSec: Math.round((now - this.startedAtMs) / 1000),
            upstream: { ...this.upstream },
            queueBytes: channels.reduce((sum, c) => sum + c.queueBytes, 0),
            channels,
        };
    }

    /** Closes every client and the upstream connection. */
    async stop(): Promise<void> {
        this.stopped = true;
        await this.scheduler.stop();
        await this.loop;
        for (const channel of this.channels.values()) {
            channel.close();
        }
        this.channels.clear();
    }

    private async run(): Promise<void> {
        const tuning = this.deps.config.tuning;
        let last = this.clock.now();
        let lastReport = Number.NEGATIVE_INFINITY;
        let lastLog = last;
        while (!this.stopped) {
            await this.clock.sleep(tuning.tickMs);
            if (this.stopped) {
                break;
            }
            const now = this.clock.now();
            const dt = Math.min(MAX_TICK_MS, Math.max(0, now - last));
            last = now;
            for (const channel of this.channels.values()) {
                channel.pump(now, dt);
            }
            this.expireChannels(now);
            this.enforceTotalCap();
            if (now - lastReport >= tuning.reportIntervalMs) {
                lastReport = now;
                this.reportReserves();
            }
            if (
                tuning.statusLogSec > 0 &&
                now - lastLog >= tuning.statusLogSec * 1000
            ) {
                lastLog = now;
                this.deps.log?.info(formatStatusLine(this.status()));
            }
        }
    }

    private reportReserves(): void {
        for (const channel of this.channels.values()) {
            this.scheduler.reportProgress(String(channel.streamId), {
                bufferedAheadSec: channel.reserveSec(),
                playing: channel.clients.size > 0,
                focused: false,
            });
        }
    }

    private expireChannels(now: number): void {
        for (const channel of [...this.channels.values()]) {
            if (channel.graceUntilMs !== null && now >= channel.graceUntilMs) {
                this.scheduler.removeTile(String(channel.streamId));
                channel.close();
                this.channels.delete(channel.streamId);
                this.deps.log?.info(
                    `channel ${channel.streamId} "${channel.name}" removed after grace`
                );
            }
        }
    }

    private enforceTotalCap(): void {
        const maxBytes = this.deps.config.tuning.maxTotalQueueMb * 1024 * 1024;
        let total = 0;
        for (const channel of this.channels.values()) {
            total += channel.queue.bytes;
        }
        while (total > maxBytes) {
            const largest = [...this.channels.values()].sort(
                (a, b) => b.queue.bytes - a.queue.bytes
            )[0];
            const before = largest?.queue.bytes ?? 0;
            if (!largest?.dropOldest()) {
                return;
            }
            total -= before - largest.queue.bytes;
        }
    }

    /** Opens through the real opener, counting and guarding every connection. */
    private readonly countingOpen: OpenUpstream = async (source, signal) => {
        const streamId = this.urlIds.get(source.url) ?? null;
        this.upstream.attempts += 1;
        if (this.openNow > 0) {
            // The scheduler never does this; refuse rather than open a second.
            this.deps.log?.warn(
                `refused to open a second connection for ${streamId}`
            );
            return { status: 0, stream: null, close: async () => undefined };
        }
        let handle: UpstreamHandle;
        try {
            handle = await this.deps.open(source, signal);
        } catch (error) {
            this.upstream.errors += 1;
            this.upstream.lastStatus = 0;
            this.deps.log?.warn(
                `upstream open failed for ${streamId}: ${errorKind(error)}`
            );
            throw error;
        }
        this.upstream.lastStatus = handle.status;
        if (!handle.stream) {
            this.upstream.refusals += 1;
            this.deps.log?.warn(
                `upstream refused ${streamId} with HTTP ${handle.status}`
            );
            return handle;
        }
        this.openNow += 1;
        this.upstream.opens += 1;
        this.upstream.maxOpenAtOnce = Math.max(
            this.upstream.maxOpenAtOnce,
            this.openNow
        );
        this.upstream.open = true;
        this.upstream.streamId = streamId;
        let closed = false;
        return {
            ...handle,
            close: async () => {
                await handle.close();
                if (!closed) {
                    closed = true;
                    this.openNow -= 1;
                    this.upstream.open = this.openNow > 0;
                    this.upstream.streamId = this.upstream.open
                        ? this.upstream.streamId
                        : null;
                }
            },
        };
    };
}

/** An error's code or class, never its message (it may hold the URL). */
function errorKind(error: unknown): string {
    if (typeof error === 'object' && error !== null) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code)) {
            return code;
        }
        return (error as { name?: string }).name ?? 'Error';
    }
    return 'Error';
}
