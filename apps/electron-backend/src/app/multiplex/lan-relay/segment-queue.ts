/**
 * A channel's spliced output, held by the relay until its clients read it.
 *
 * Every entry is one whole segment as the splicer emits it: PAT and PMT,
 * then the packets from one video keyframe up to the next. A client can
 * therefore start on any entry and its player sees a clean stream start.
 * Entries are numbered; clients keep a sequence number as their cursor.
 */

export interface QueuedSegment {
    readonly seq: number;
    readonly data: Buffer;
    readonly durationMs: number;
    /** Position on the channel's own media timeline. */
    readonly startMs: number;
}

export class SegmentQueue {
    private readonly segments: QueuedSegment[] = [];
    private nextSeq = 0;
    private endMs = 0;
    private byteCount = 0;

    /** Sequence number of the oldest entry (equal to `tailSeq` when empty). */
    get headSeq(): number {
        return this.segments[0]?.seq ?? this.nextSeq;
    }

    /** One past the newest entry. */
    get tailSeq(): number {
        return this.nextSeq;
    }

    get bytes(): number {
        return this.byteCount;
    }

    get length(): number {
        return this.segments.length;
    }

    /** Media held, oldest entry to newest. */
    get durationMs(): number {
        return this.endMs - (this.segments[0]?.startMs ?? this.endMs);
    }

    get(seq: number): QueuedSegment | undefined {
        return this.segments[seq - this.headSeq];
    }

    push(data: Buffer, durationMs: number): QueuedSegment {
        const segment: QueuedSegment = {
            seq: this.nextSeq,
            data,
            durationMs,
            startMs: this.endMs,
        };
        this.segments.push(segment);
        this.nextSeq += 1;
        this.endMs += durationMs;
        this.byteCount += data.length;
        return segment;
    }

    /** Media from `doneMs` into entry `seq` up to the newest entry. */
    aheadMs(seq: number, doneMs: number): number {
        const segment = this.get(Math.max(seq, this.headSeq));
        if (!segment) {
            return 0;
        }
        const done = seq >= this.headSeq ? doneMs : 0;
        return Math.max(0, this.endMs - segment.startMs - done);
    }

    /** The newest entry that still leaves `backlogMs` of media after it. */
    joinSeq(backlogMs: number): number {
        const target = this.endMs - backlogMs;
        for (let index = this.segments.length - 1; index >= 0; index -= 1) {
            if (this.segments[index].startMs <= target) {
                return this.segments[index].seq;
            }
        }
        return this.headSeq;
    }

    /** Removes and returns the oldest entry. */
    dropHead(): QueuedSegment | undefined {
        const segment = this.segments.shift();
        if (segment) {
            this.byteCount -= segment.data.length;
        }
        return segment;
    }

    /** The oldest entry's end, on the media timeline. */
    headEndMs(): number {
        const head = this.segments[0];
        return head ? head.startMs + head.durationMs : this.endMs;
    }

    get endMediaMs(): number {
        return this.endMs;
    }
}
