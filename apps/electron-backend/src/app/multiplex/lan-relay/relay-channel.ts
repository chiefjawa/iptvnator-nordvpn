/**
 * One configured channel while it is wanted: the scheduler's tile sink, the
 * queue that holds its reserve, and the clients reading from it.
 *
 * The queue is the reserve. What the scheduler is told about the tile is the
 * media still queued for its slowest-draining client plus that client's
 * estimated cushion, in place of the buffer report a player would send.
 */

import { VisitSummary } from '../splicer/tile-splicer';
import { TileSink } from '../scheduler/scheduler-types';
import {
    parseTsPacket,
    timestampDelta,
    TS_CLOCK_HZ,
    TS_PID_PAT,
} from '../ts/ts-packet';
import { readPesTimestamps } from '../ts/ts-pes';
import { RelayTuning } from './relay-config';
import {
    ClientCounters,
    ClientOutput,
    emptyCounters,
    RelayClient,
} from './relay-client';
import { SegmentQueue } from './segment-queue';

export interface ChannelTotals {
    visits: number;
    newMediaMs: number;
    overlapMs: number;
    skippedMs: number;
    restarts: number;
    /** Media dropped by the queue caps that no client still needed. */
    capDroppedMs: number;
}

export class RelayChannel implements TileSink {
    readonly queue = new SegmentQueue();
    readonly clients = new Set<RelayClient>();
    readonly totals: ChannelTotals = {
        visits: 0,
        newMediaMs: 0,
        overlapMs: 0,
        skippedMs: 0,
        restarts: 0,
        capDroppedMs: 0,
    };
    /** Counters of clients that have left. */
    private readonly departed = emptyCounters();
    private lastDurationMs = 1000;
    private hadClient = false;
    /** When the channel, left without clients, is dropped. */
    graceUntilMs: number | null = null;
    /** When the scheduler last delivered media for this channel. */
    lastInputAtMs = 0;
    /** Clients ended because no media arrived for too long. */
    starvedEnds = 0;

    constructor(
        readonly streamId: number,
        readonly name: string,
        private readonly tuning: RelayTuning
    ) {}

    /** Spliced output from the scheduler: one or more whole segments. */
    write(packets: Buffer[], mediaMs?: number): void {
        const groups = splitSegments(packets);
        const pts = groups.map(firstPesPts);
        let assigned = 0;
        groups.forEach((group, index) => {
            const last = index === groups.length - 1;
            const next = pts[index + 1];
            const own = pts[index];
            let durationMs: number;
            if (!last && own !== null && next !== null && next !== undefined) {
                durationMs = (timestampDelta(next, own) / TS_CLOCK_HZ) * 1000;
            } else if (last && mediaMs !== undefined) {
                durationMs = mediaMs - assigned;
            } else {
                durationMs = this.lastDurationMs;
            }
            durationMs = Math.max(0, durationMs);
            assigned += durationMs;
            if (durationMs > 0) {
                this.lastDurationMs = durationMs;
            }
            this.queue.push(Buffer.concat(group), durationMs);
        });
    }

    addClient(
        id: number,
        remote: string,
        output: ClientOutput,
        nowMs: number
    ): RelayClient {
        // A new channel's first client takes everything from the start; one
        // joining a running channel starts near its end, on a keyframe.
        const startSeq = this.hadClient
            ? this.queue.joinSeq(this.tuning.joinBacklogSec * 1000)
            : this.queue.headSeq;
        this.hadClient = true;
        const client = new RelayClient(
            id,
            remote,
            output,
            startSeq,
            nowMs,
            this.tuning
        );
        this.clients.add(client);
        this.graceUntilMs = null;
        return client;
    }

    removeClient(client: RelayClient, nowMs: number): void {
        if (!this.clients.delete(client)) {
            return;
        }
        addCounters(this.departed, client.counters);
        client.close();
        if (this.clients.size === 0) {
            this.graceUntilMs = nowMs + this.tuning.graceSec * 1000;
        }
    }

    pump(nowMs: number, dtMs: number): void {
        for (const client of this.clients) {
            client.pump(this.queue, nowMs, dtMs);
        }
        this.release();
        this.enforceCaps();
    }

    /** Seconds of reserve to report to the scheduler. */
    reserveSec(): number {
        if (this.clients.size === 0) {
            return this.queue.durationMs / 1000;
        }
        let lowest = Number.POSITIVE_INFINITY;
        for (const client of this.clients) {
            lowest = Math.min(
                lowest,
                client.aheadMs(this.queue) / 1000 + client.cushionSec
            );
        }
        return lowest;
    }

    noteVisit(summary: VisitSummary): void {
        this.totals.visits += 1;
        this.totals.newMediaMs += summary.newMediaMs;
        this.totals.overlapMs += summary.overlapMs;
        this.totals.skippedMs += summary.skippedMs;
        this.totals.restarts += summary.restart ? 1 : 0;
    }

    /** Counters of every client this channel has had. */
    counters(): ClientCounters {
        const sum = { ...this.departed };
        for (const client of this.clients) {
            addCounters(sum, client.counters);
        }
        return sum;
    }

    /** Drops the oldest entry, skipping clients still on it. */
    dropOldest(): boolean {
        if (this.queue.length <= 1) {
            return false;
        }
        const head = this.queue.dropHead();
        if (!head) {
            return false;
        }
        let needed = false;
        for (const client of this.clients) {
            if (client.seq <= head.seq) {
                needed = true;
                client.skipTo(this.queue.headSeq, head.durationMs);
            }
        }
        if (!needed) {
            this.totals.capDroppedMs += Math.round(head.durationMs);
        }
        return true;
    }

    close(): void {
        for (const client of [...this.clients]) {
            this.removeClient(client, 0);
        }
        while (this.queue.dropHead()) {
            // Release every buffer.
        }
    }

    /**
     * Frees entries every client has passed, keeping the newest
     * `joinBacklogSec` for a client that joins or reconnects.
     */
    private release(): void {
        if (this.clients.size === 0) {
            return;
        }
        let slowest = Number.POSITIVE_INFINITY;
        for (const client of this.clients) {
            slowest = Math.min(slowest, client.seq);
        }
        const keepFromMs =
            this.queue.endMediaMs - this.tuning.joinBacklogSec * 1000;
        while (
            this.queue.length > 1 &&
            this.queue.headSeq < slowest &&
            this.queue.headEndMs() <= keepFromMs
        ) {
            this.queue.dropHead();
        }
    }

    private enforceCaps(): void {
        const maxMs = this.tuning.maxQueueSec * 1000;
        const maxBytes = this.tuning.maxQueueMb * 1024 * 1024;
        while (
            (this.queue.durationMs > maxMs || this.queue.bytes > maxBytes) &&
            this.dropOldest()
        ) {
            // Each pass drops one entry.
        }
    }
}

/** Splits the splicer's output at each PAT: every segment starts with one. */
function splitSegments(packets: Buffer[]): Buffer[][] {
    const groups: Buffer[][] = [];
    for (const packet of packets) {
        const header = parseTsPacket(packet);
        if (header?.pid === TS_PID_PAT || groups.length === 0) {
            groups.push([]);
        }
        groups[groups.length - 1].push(packet);
    }
    return groups;
}

/** PTS of the first PES in a segment: its keyframe. */
function firstPesPts(group: Buffer[]): number | null {
    for (const packet of group) {
        const header = parseTsPacket(packet);
        if (header?.payloadUnitStart && header.pid !== TS_PID_PAT) {
            const pes = readPesTimestamps(packet, header);
            if (pes) {
                return pes.pts;
            }
        }
    }
    return null;
}

function addCounters(into: ClientCounters, from: ClientCounters): void {
    for (const key of Object.keys(into) as (keyof ClientCounters)[]) {
        into[key] += from[key];
    }
}
