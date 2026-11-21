/**
 * The standalone relay: one provider connection shared by every channel a
 * LAN player is watching.
 *
 * All channels form one group on one `GroupScheduler`, so the scheduler's
 * guarantees hold unchanged — close, confirm closed, gap, open; backoff on
 * refusal; never a second connection. A channel becomes a tile when its
 * first client arrives and stops being one a grace period after its last
 * client leaves. The relay holds each tile's reserve itself and feeds it to
 * the scheduler in place of a player's buffer report.
 *
 * Any stream id can be requested; names for logs come from `nameOf` (the
 * cached catalogue). Every connection passes the shared `UpstreamGate`, so a
 * movie and a live visit can never be open at once.
 */

import { GroupScheduler } from '../scheduler/group-scheduler';
import {
    MultiplexClock,
    OpenUpstream,
    systemClock,
} from '../scheduler/scheduler-types';
import { LiveRefusals, ZapTracker } from './live-admission';
import { buildLiveUrl, RelayConfig } from './relay-config';
import { RelayChannel } from './relay-channel';
import { ClientOutput, RelayClient } from './relay-client';
import { formatStatusLine, RelayLogger } from './relay-log';
import { channelStatus, RelayStatus, UpstreamStatus } from './relay-status';
import { guardedOpen } from './upstream-guard';
import { UpstreamGate } from './upstream-gate';

export interface LanRelayDeps {
    readonly config: RelayConfig;
    readonly open: OpenUpstream;
    readonly clock?: MultiplexClock;
    readonly log?: RelayLogger;
    readonly gate?: UpstreamGate;
    /** Channel name for a stream id, e.g. from the cached catalogue. */
    readonly nameOf?: (streamId: number) => string | undefined;
    /** True while a movie or catch-up stream owns the connection. */
    readonly vodActive?: () => boolean;
    /** Extra fields for the periodic log line. */
    readonly statusExtra?: () => string;
}

export type AttachResult =
    | { readonly client: RelayClient; readonly refused?: undefined }
    | {
          readonly client?: undefined;
          readonly refused: 'capacity' | 'vod' | 'stopped';
      };

/** A tick longer than this (a stalled event loop) is not paid out at once. */
const MAX_TICK_MS = 1000;

export class LanRelay {
    readonly gate: UpstreamGate;
    private readonly clock: MultiplexClock;
    private readonly channels = new Map<number, RelayChannel>();
    private readonly names = new Map<number, string>();
    private readonly scheduler: GroupScheduler;
    private readonly startedAtMs: number;
    private readonly zap: ZapTracker;
    private readonly refusals: LiveRefusals = { capacity: 0, vodActive: 0 };
    private readonly upstream: UpstreamStatus;
    private readonly urlIds = new Map<string, number>();
    private nextClientId = 1;
    private loop: Promise<void> | null = null;
    private stopped = false;

    constructor(private readonly deps: LanRelayDeps) {
        this.clock = deps.clock ?? systemClock;
        this.gate = deps.gate ?? new UpstreamGate();
        this.startedAtMs = this.clock.now();
        this.zap = new ZapTracker(deps.config.tuning.zapWindowSec * 1000);
        for (const channel of deps.config.channels) {
            this.names.set(channel.streamId, channel.name);
        }
        const guarded = guardedOpen({
            open: deps.open,
            gate: this.gate,
            clock: this.clock,
            stallMs: deps.config.tuning.upstreamStallSec * 1000,
            idOf: (url) => this.urlIds.get(url) ?? null,
            log: deps.log,
        });
        this.upstream = guarded.status;
        this.scheduler = new GroupScheduler({
            open: guarded.open,
            clock: this.clock,
            config: deps.config.scheduler,
            onVisitEnd: (tileId, summary) =>
                this.channels.get(Number(tileId))?.noteVisit(summary),
        });
    }

    /** Clients on live channels right now. */
    get clientCount(): number {
        let count = 0;
        for (const channel of this.channels.values()) {
            count += channel.clients.size;
        }
        return count;
    }

    nameOf(streamId: number): string {
        return (
            this.names.get(streamId) ??
            this.deps.nameOf?.(streamId) ??
            `Channel ${streamId}`
        );
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
    ): AttachResult {
        if (this.stopped) {
            return { refused: 'stopped' };
        }
        if (this.deps.vodActive?.()) {
            this.refusals.vodActive += 1;
            this.deps.log?.warn(
                `live ${streamId} from ${remote} refused: a movie holds the connection`
            );
            return { refused: 'vod' };
        }
        const now = this.clock.now();
        let channel = this.channels.get(streamId);
        if (!channel) {
            if (!this.makeRoom()) {
                this.refusals.capacity += 1;
                this.deps.log?.warn(
                    `live ${streamId} from ${remote} refused: ${this.channels.size} channels at capacity`
                );
                return { refused: 'capacity' };
            }
            channel = this.addChannel(streamId, now);
        }
        const left = this.zap.arrived(remote, streamId, now);
        if (left !== null) {
            this.shortenGrace(left, now);
        }
        const client = channel.addClient(
            this.nextClientId++,
            remote,
            output,
            now
        );
        this.deps.log?.info(
            `client ${client.id} on ${streamId} from ${remote} (clients=${channel.clients.size})`
        );
        return { client };
    }

    detach(streamId: number, client: RelayClient): void {
        const channel = this.channels.get(streamId);
        if (!channel?.clients.has(client)) {
            return;
        }
        const now = this.clock.now();
        channel.removeClient(client, now);
        const zapped = this.zap.departed(client.remote, streamId, now);
        if (zapped) {
            this.shortenGrace(streamId, now);
        }
        this.deps.log?.info(
            `client ${client.id} left ${streamId} after ${(client.counters.sentMediaMs / 1000).toFixed(1)}s (clients=${channel.clients.size}${zapped ? ', zap' : ''})`
        );
    }

    /** Removes every channel without clients (a movie wants the connection). */
    dropIdleChannels(): void {
        for (const channel of [...this.channels.values()]) {
            if (channel.clients.size === 0) {
                this.removeChannel(channel, 'for a movie');
            }
        }
    }

    /** Stops opening live connections; resolves once the current one closed. */
    suspendLive(): Promise<void> {
        this.deps.log?.info('live rotation suspended');
        return this.scheduler.suspend();
    }

    resumeLive(): void {
        if (this.scheduler.isSuspended) {
            this.deps.log?.info('live rotation resumed');
            this.scheduler.resume();
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
            upstream: { ...this.upstream, gate: this.gate.status() },
            queueBytes: channels.reduce((sum, c) => sum + c.queueBytes, 0),
            maxLiveChannels: this.deps.config.maxLiveChannels,
            suspended: this.scheduler.isSuspended,
            zaps: this.zap.zaps,
            refused: { ...this.refusals },
            channels,
        };
    }

    /** Closes the upstream connection first, then every client. */
    async stop(): Promise<void> {
        this.stopped = true;
        await this.scheduler.stop();
        await this.loop;
        for (const channel of this.channels.values()) {
            channel.close();
        }
        this.channels.clear();
    }

    private addChannel(streamId: number, now: number): RelayChannel {
        const name = this.nameOf(streamId);
        const channel = new RelayChannel(
            streamId,
            name,
            this.deps.config.tuning
        );
        channel.lastInputAtMs = now;
        this.channels.set(streamId, channel);
        const url = buildLiveUrl(this.deps.config, streamId);
        this.urlIds.set(url, streamId);
        this.scheduler.setTile(
            String(streamId),
            { url, userAgent: this.deps.config.userAgent },
            {
                write: (packets, mediaMs) => {
                    channel.lastInputAtMs = this.clock.now();
                    channel.write(packets, mediaMs);
                },
            }
        );
        this.deps.log?.info(`channel ${streamId} "${name}" added`);
        return channel;
    }

    private removeChannel(channel: RelayChannel, why: string): void {
        this.scheduler.removeTile(String(channel.streamId));
        channel.close();
        this.channels.delete(channel.streamId);
        this.urlIds.delete(buildLiveUrl(this.deps.config, channel.streamId));
        this.deps.log?.info(
            `channel ${channel.streamId} "${channel.name}" removed ${why}`
        );
    }

    /** Frees a slot for a new channel by evicting an unwatched one. */
    private makeRoom(): boolean {
        if (this.channels.size < this.deps.config.maxLiveChannels) {
            return true;
        }
        const idle = [...this.channels.values()]
            .filter((channel) => channel.clients.size === 0)
            .sort((a, b) => (a.graceUntilMs ?? 0) - (b.graceUntilMs ?? 0))[0];
        if (!idle) {
            return false;
        }
        this.removeChannel(idle, 'to make room');
        return true;
    }

    private shortenGrace(streamId: number, now: number): void {
        const channel = this.channels.get(streamId);
        if (
            channel &&
            channel.clients.size === 0 &&
            channel.graceUntilMs !== null
        ) {
            const until = now + this.deps.config.tuning.zapGraceSec * 1000;
            channel.graceUntilMs = Math.min(channel.graceUntilMs, until);
        }
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
            this.endStarved(now);
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
                const extra = this.deps.statusExtra?.();
                this.deps.log?.info(
                    formatStatusLine(this.status()) +
                        (extra ? ` | ${extra}` : '')
                );
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
                this.removeChannel(channel, 'after grace');
            }
        }
    }

    /**
     * A channel that got no media for `endAfterStarveSec` (provider or VPN
     * down, or a movie holding the connection) ends its clients cleanly
     * once they have nothing left to send, rather than feeding them null
     * packets forever; the player reconnects when it is ready.
     */
    private endStarved(now: number): void {
        const limitMs = this.deps.config.tuning.endAfterStarveSec * 1000;
        if (limitMs <= 0) {
            return;
        }
        for (const channel of this.channels.values()) {
            if (
                channel.clients.size === 0 ||
                now - channel.lastInputAtMs < limitMs
            ) {
                continue;
            }
            for (const client of [...channel.clients]) {
                if (client.aheadMs(channel.queue) <= 0) {
                    channel.starvedEnds += 1;
                    this.deps.log?.warn(
                        `client ${client.id} on ${channel.streamId} ended: no media for ${Math.round((now - channel.lastInputAtMs) / 1000)}s`
                    );
                    this.detach(channel.streamId, client);
                }
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
}
