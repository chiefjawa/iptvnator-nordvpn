/**
 * One player connected to the relay, fed at the pace of its media.
 *
 * A player that cannot report its buffer has to be fed smoothly: a short
 * fast start so it begins playing quickly, then real time (with a slight
 * overdrive until an estimated client cushion is built). The relay keeps
 * the reserve itself. When there is nothing to send, null packets keep the
 * socket from going quiet, since a player may abort a silent stream. When
 * the client stops reading, output pauses until the socket drains.
 */

import { TS_PACKET_SIZE } from '../ts/ts-packet';
import { RelayTuning } from './relay-config';
import { SegmentQueue } from './segment-queue';

/** Where a client's bytes go (an HTTP response in production). */
export interface ClientOutput {
    /** False when the socket buffer is full: wait for `onDrain`. */
    write(data: Buffer): boolean;
    onDrain(listener: () => void): void;
    close(): void;
}

export interface ClientCounters {
    sentMediaMs: number;
    bytes: number;
    dryStalls: number;
    dryStallMs: number;
    keepAlivePackets: number;
    backpressurePauses: number;
    backpressureDrops: number;
    backpressureDroppedMs: number;
}

export function emptyCounters(): ClientCounters {
    return {
        sentMediaMs: 0,
        bytes: 0,
        dryStalls: 0,
        dryStallMs: 0,
        keepAlivePackets: 0,
        backpressurePauses: 0,
        backpressureDrops: 0,
        backpressureDroppedMs: 0,
    };
}

const NULL_PACKET = (() => {
    const packet = Buffer.alloc(TS_PACKET_SIZE, 0xff);
    packet[0] = 0x47;
    packet[1] = 0x1f;
    packet[2] = 0xff;
    packet[3] = 0x10;
    return packet;
})();
const EPSILON_MS = 1e-6;

export class RelayClient {
    readonly counters = emptyCounters();
    /** Entry being sent and how far into it. */
    seq: number;
    private offset = 0;
    private doneMs = 0;
    private budgetMs: number;
    private cushionMs = 0;
    private paused = false;
    private closed = false;
    private lastWriteAtMs: number;
    private dryingSinceMs: number | null = null;
    private dryCounted = false;
    private firstMediaAtMs: number | null = null;

    constructor(
        readonly id: number,
        readonly remote: string,
        private readonly output: ClientOutput,
        startSeq: number,
        readonly connectedAtMs: number,
        private readonly tuning: RelayTuning
    ) {
        this.seq = startSeq;
        this.budgetMs = tuning.fastStartSec * 1000;
        this.lastWriteAtMs = connectedAtMs;
    }

    get isPaused(): boolean {
        return this.paused;
    }

    /** Estimated media buffered in the player. */
    get cushionSec(): number {
        return this.cushionMs / 1000;
    }

    get startupWaitMs(): number | null {
        return this.firstMediaAtMs === null
            ? null
            : this.firstMediaAtMs - this.connectedAtMs;
    }

    /** Media queued for this client and not yet sent. */
    aheadMs(queue: SegmentQueue): number {
        return queue.aheadMs(this.seq, this.doneMs);
    }

    /** The queue dropped entries this client had not read: skip past them. */
    skipTo(seq: number, lostMs: number): void {
        if (seq <= this.seq) {
            return;
        }
        this.seq = seq;
        this.offset = 0;
        this.doneMs = 0;
        this.counters.backpressureDrops += 1;
        this.counters.backpressureDroppedMs += Math.round(lostMs);
    }

    /** Sends what the pacing allows; called every tick. */
    pump(queue: SegmentQueue, nowMs: number, dtMs: number): void {
        if (this.closed) {
            return;
        }
        if (this.firstMediaAtMs !== null) {
            // The player plays in real time while it has something to play.
            this.cushionMs = Math.max(0, this.cushionMs - dtMs);
        }
        if (this.paused) {
            return;
        }

        const fastStartMs = this.tuning.fastStartSec * 1000;
        const rate =
            this.cushionMs < this.tuning.targetCushionSec * 1000 &&
            this.aheadMs(queue) > fastStartMs
                ? this.tuning.overdrive
                : 1;
        // After a stall, at most one fast start's worth is sent at once.
        this.budgetMs = Math.min(
            this.budgetMs + dtMs * rate,
            this.counters.sentMediaMs + fastStartMs
        );

        if (this.sendMedia(queue)) {
            this.noteWrite(nowMs);
            return;
        }
        if (this.paused) {
            return;
        }
        const wantsMore =
            this.counters.sentMediaMs < this.budgetMs - EPSILON_MS &&
            this.aheadMs(queue) <= EPSILON_MS;
        if (wantsMore && this.firstMediaAtMs !== null) {
            this.dryingSinceMs ??= nowMs;
        }
        if (nowMs - this.lastWriteAtMs >= this.tuning.keepAliveIntervalMs) {
            this.sendKeepAlive(nowMs);
        }
    }

    close(): void {
        if (!this.closed) {
            this.closed = true;
            this.output.close();
        }
    }

    /** Writes media up to the budget; true when anything was written. */
    private sendMedia(queue: SegmentQueue): boolean {
        let wrote = false;
        while (this.counters.sentMediaMs < this.budgetMs - EPSILON_MS) {
            if (this.seq < queue.headSeq) {
                this.skipTo(queue.headSeq, 0);
            }
            const segment = queue.get(this.seq);
            if (!segment) {
                break;
            }
            const packets = segment.data.length / TS_PACKET_SIZE;
            const left = packets - this.offset / TS_PACKET_SIZE;
            const msPerPacket = segment.durationMs / packets;
            const allowed =
                msPerPacket > 0
                    ? Math.min(
                          left,
                          Math.floor(
                              (this.budgetMs - this.counters.sentMediaMs) /
                                  msPerPacket +
                                  EPSILON_MS
                          )
                      )
                    : left;
            if (allowed <= 0) {
                break;
            }
            const end = this.offset + allowed * TS_PACKET_SIZE;
            const chunk = segment.data.subarray(this.offset, end);
            const mediaMs = allowed * msPerPacket;
            this.offset = end;
            this.doneMs += mediaMs;
            if (this.offset >= segment.data.length) {
                this.seq += 1;
                this.offset = 0;
                this.doneMs = 0;
            }
            this.counters.sentMediaMs += mediaMs;
            this.counters.bytes += chunk.length;
            this.cushionMs += mediaMs;
            wrote = true;
            if (!this.write(chunk)) {
                break;
            }
        }
        return wrote;
    }

    private sendKeepAlive(nowMs: number): void {
        const count = Math.max(1, this.tuning.keepAlivePackets);
        const data = Buffer.concat(
            Array.from({ length: count }, () => NULL_PACKET)
        );
        this.counters.keepAlivePackets += count;
        this.counters.bytes += data.length;
        this.lastWriteAtMs = nowMs;
        if (this.dryingSinceMs !== null && !this.dryCounted) {
            this.dryCounted = true;
            this.counters.dryStalls += 1;
        }
        this.write(data);
    }

    private noteWrite(nowMs: number): void {
        this.firstMediaAtMs ??= nowMs;
        this.lastWriteAtMs = nowMs;
        if (this.dryingSinceMs !== null) {
            if (this.dryCounted) {
                this.counters.dryStallMs += Math.round(
                    nowMs - this.dryingSinceMs
                );
            }
            this.dryingSinceMs = null;
            this.dryCounted = false;
        }
    }

    private write(data: Buffer): boolean {
        const ok = this.output.write(data);
        if (!ok && !this.closed) {
            this.paused = true;
            this.counters.backpressurePauses += 1;
            this.output.onDrain(() => {
                this.paused = false;
            });
        }
        return ok;
    }
}
