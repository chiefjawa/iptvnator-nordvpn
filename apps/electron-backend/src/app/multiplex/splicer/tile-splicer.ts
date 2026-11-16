/**
 * Stitches the bursts a tile receives on successive visits into one gapless
 * transport stream.
 *
 * Every visit is a fresh connection that starts well behind the live edge,
 * so it begins with content the tile already has. The splicer lines the new
 * connection up with what it forwarded before — by keyframe content, which
 * also reveals a server that restarted its timestamps — drops the repeat,
 * and continues from the exact segment where the last visit stopped.
 *
 * When the tile was away too long and content was missed, the hole is closed
 * in the output timeline (the player would otherwise fill audio gaps with
 * silence and stall on video) and the skip is reported instead.
 */

import {
    parseTsPacket,
    timestampDelta,
    TS_CLOCK_HZ,
} from '../ts/ts-packet';
import { ContinuityRewriter, shiftPacketTimestamps } from '../ts/ts-timeline';
import { TsSegment, TsSegmenter, TsStreamInfo } from './segmenter';

/** Output timestamps start here, leaving room for DTS/PCR below the PTS. */
const OUTPUT_START_TICKS = 10 * TS_CLOCK_HZ;
/** Keyframe timestamps closer than this are the same keyframe. */
const SAME_KEYFRAME_TICKS = 900;
/** A first keyframe further than this from the expected one is a restart. */
const PLAUSIBLE_STEP_TICKS = 300 * TS_CLOCK_HZ;
const HISTORY_SEGMENTS = 120;

export interface VisitSummary {
    /** Media forwarded to the tile during the visit. */
    readonly newMediaMs: number;
    /** Media received again and dropped. */
    readonly overlapMs: number;
    /** Media the tile missed and the output skipped over. */
    readonly skippedMs: number;
    /** The server's timestamps did not continue from the previous visit. */
    readonly restart: boolean;
}

export interface SpliceResult {
    /** Packets ready for the tile, timestamps and counters rewritten. */
    readonly output: Buffer[];
    /** Media in `output`. */
    readonly forwardedMs: number;
    /** Media received in this push, forwarded or not. */
    readonly receivedMs: number;
}

export class TileSplicer {
    private readonly continuity = new ContinuityRewriter();
    /** Fingerprint to timeline PTS of recently forwarded keyframes. */
    private readonly history = new Map<string, number>();
    private segmenter = new TsSegmenter();
    private streamInfo: TsStreamInfo | null = null;

    /** Timeline PTS of the keyframe the next forwarded segment must start at. */
    private expectedPts: number | null = null;
    /** Timeline PTS to output PTS. Changes only when a gap is closed. */
    private outputShift = 0;
    /** This connection's PTS to the tile's timeline; set on alignment. */
    private connectionShift: number | null = null;

    private newMediaTicks = 0;
    private overlapTicks = 0;
    private skippedTicks = 0;
    private restart = false;

    get info(): TsStreamInfo | null {
        return this.streamInfo;
    }

    /** Starts a visit: the next bytes come from a new connection. */
    beginVisit(): void {
        this.segmenter = new TsSegmenter();
        this.connectionShift = null;
        this.newMediaTicks = 0;
        this.overlapTicks = 0;
        this.skippedTicks = 0;
        this.restart = false;
    }

    push(chunk: Buffer): SpliceResult {
        const output: Buffer[] = [];
        let forwarded = 0;
        let received = 0;

        for (const segment of this.segmenter.push(chunk)) {
            this.streamInfo ??= this.segmenter.info;
            const duration = Math.max(
                0,
                timestampDelta(segment.nextKeyframePts, segment.keyframePts)
            );
            received += duration;
            if (this.accept(segment)) {
                this.emit(segment, output);
                forwarded += duration;
                this.newMediaTicks += duration;
            } else {
                this.overlapTicks += duration;
            }
        }

        return {
            output,
            forwardedMs: ticksToMs(forwarded),
            receivedMs: ticksToMs(received),
        };
    }

    /** Ends the visit; the unfinished trailing segment is discarded. */
    endVisit(): VisitSummary {
        return {
            newMediaMs: ticksToMs(this.newMediaTicks),
            overlapMs: ticksToMs(this.overlapTicks),
            skippedMs: ticksToMs(this.skippedTicks),
            restart: this.restart,
        };
    }

    /** Decides whether a segment continues the tile's stream. */
    private accept(segment: TsSegment): boolean {
        if (this.connectionShift === null) {
            this.align(segment);
        }
        const shift = this.connectionShift as number;
        const pts = segment.keyframePts + shift;

        if (this.expectedPts === null) {
            this.outputShift = OUTPUT_START_TICKS - pts;
            return true;
        }

        const step = timestampDelta(pts, this.expectedPts);
        if (step < -SAME_KEYFRAME_TICKS) {
            return false;
        }
        if (step > SAME_KEYFRAME_TICKS) {
            // Content was missed: pull the output timeline back over the hole.
            this.outputShift -= step;
            this.skippedTicks += step;
        }
        return true;
    }

    /** Finds how this connection's timestamps map onto the tile's timeline. */
    private align(segment: TsSegment): void {
        if (this.expectedPts === null) {
            this.connectionShift = 0;
            return;
        }

        const known = this.history.get(segment.fingerprint);
        if (known !== undefined) {
            this.connectionShift = timestampDelta(known, segment.keyframePts);
            this.restart = Math.abs(this.connectionShift) > SAME_KEYFRAME_TICKS;
            return;
        }

        const step = timestampDelta(segment.keyframePts, this.expectedPts);
        if (Math.abs(step) <= PLAUSIBLE_STEP_TICKS) {
            this.connectionShift = 0;
            return;
        }

        // Unrecognised content on an unrelated clock: nothing to line up
        // with, so continue from here as if no time had passed.
        this.connectionShift = timestampDelta(
            this.expectedPts,
            segment.keyframePts
        );
        this.restart = true;
    }

    private emit(segment: TsSegment, output: Buffer[]): void {
        const shift = (this.connectionShift as number) + this.outputShift;
        const timelinePts =
            segment.keyframePts + (this.connectionShift as number);

        // PSI packets are reused for every segment, so they are copied;
        // segment packets belong to this segment and are edited in place.
        const packets = [
            ...this.segmenter.psiPackets.map((packet) => Buffer.from(packet)),
            ...segment.packets,
        ];
        for (const packet of packets) {
            const header = parseTsPacket(packet);
            if (!header) {
                continue;
            }
            shiftPacketTimestamps(packet, header, shift);
            this.continuity.apply(packet, header.pid);
            output.push(packet);
        }

        this.remember(segment.fingerprint, timelinePts);
        this.expectedPts =
            segment.nextKeyframePts + (this.connectionShift as number);
    }

    private remember(fingerprint: string, timelinePts: number): void {
        this.history.set(fingerprint, timelinePts);
        if (this.history.size > HISTORY_SEGMENTS) {
            const oldest = this.history.keys().next().value;
            if (oldest !== undefined) {
                this.history.delete(oldest);
            }
        }
    }
}

function ticksToMs(ticks: number): number {
    return Math.round((ticks / TS_CLOCK_HZ) * 1000);
}
