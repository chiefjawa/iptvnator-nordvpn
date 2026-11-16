/**
 * Measures how one live connection delivers media over time.
 *
 * Connection multiplexing only works on servers that open a live channel
 * with a burst: several seconds of content sent as fast as the line allows
 * before pacing drops to real time. The analyzer turns the raw bytes of one
 * connection into that shape — how deep the burst was, how fast it arrived,
 * and when the server settled — plus keyframe fingerprints that let two
 * connections to the same channel be lined up against each other.
 */

import { createHash, Hash } from 'node:crypto';
import {
    parseTsPacket,
    timestampDelta,
    TsPacketAligner,
    TsPacketHeader,
    TS_CLOCK_HZ,
    TS_PACKET_SIZE,
    TS_PID_PAT,
} from '../ts/ts-packet';
import { isKeyframeStart, readPesTimestamps } from '../ts/ts-pes';
import {
    parsePatSection,
    parsePmtSection,
    PsiSectionAssembler,
    TsElementaryStream,
    TsVideoCodec,
} from '../ts/ts-psi';

const SAMPLE_INTERVAL_MS = 250;
const RATE_WINDOW_MS = 1000;
/** Media seconds per wall second below which delivery counts as real time. */
const REALTIME_RATE = 1.5;
const FINGERPRINT_BYTES = 4096;

interface Sample {
    readonly atMs: number;
    readonly mediaTicks: number;
    readonly bytes: number;
}

interface PendingFingerprint {
    readonly pts: number;
    readonly hash: Hash;
    remaining: number;
}

export interface ConnectionSummary {
    readonly bytes: number;
    readonly mediaSec: number;
    /** Media delivered before pacing dropped to real time. */
    readonly burstMediaSec: number;
    readonly burstWallMs: number;
    readonly burstMbit: number;
    readonly mediaBitrateMbit: number;
    /** Null when the connection was closed while still bursting. */
    readonly realtimeAfterMs: number | null;
    readonly gopSec: number;
    readonly videoCodec: string;
    readonly audioCodec: string;
    readonly firstPts: number | null;
    readonly lastPts: number | null;
    /** Keyframe content fingerprint to that keyframe's PTS. */
    readonly keyframes: ReadonlyMap<string, number>;
}

export class BurstAnalyzer {
    private readonly aligner = new TsPacketAligner();
    private readonly patAssembler = new PsiSectionAssembler();
    private readonly pmtAssembler = new PsiSectionAssembler();
    private readonly samples: Sample[] = [];
    private readonly keyframes = new Map<string, number>();
    private readonly keyframePts: number[] = [];

    private pmtPid: number | null = null;
    private video: TsElementaryStream | null = null;
    private audio: TsElementaryStream | null = null;
    private clockPid: number | null = null;
    private startedAtMs: number | null = null;
    private lastPushAtMs = 0;
    private bytes = 0;
    private firstPts: number | null = null;
    private mediaTicks = 0;
    private fingerprint: PendingFingerprint | null = null;

    push(chunk: Buffer, nowMs: number): void {
        this.startedAtMs ??= nowMs;
        this.bytes += chunk.length;

        const packets = this.aligner.push(chunk);
        for (
            let offset = 0;
            offset + TS_PACKET_SIZE <= packets.length;
            offset += TS_PACKET_SIZE
        ) {
            const packet = packets.subarray(offset, offset + TS_PACKET_SIZE);
            const header = parseTsPacket(packet);
            if (header) {
                this.handlePacket(packet, header);
            }
        }

        this.lastPushAtMs = nowMs - this.startedAtMs;
        const last = this.samples[this.samples.length - 1];
        if (!last || this.lastPushAtMs - last.atMs >= SAMPLE_INTERVAL_MS) {
            this.samples.push(this.currentSample());
        }
    }

    /** True once delivery has stayed at real time for `settledMs`. */
    hasSettled(nowMs: number, settledMs: number): boolean {
        const realtime = this.findRealtimeSample();
        return (
            realtime !== null &&
            this.startedAtMs !== null &&
            nowMs - this.startedAtMs - realtime.atMs >= settledMs
        );
    }

    summarize(): ConnectionSummary {
        const realtime = this.findRealtimeSample();
        const burst = realtime ?? this.currentSample();
        const mediaSec = this.mediaTicks / TS_CLOCK_HZ;

        return {
            bytes: this.bytes,
            mediaSec: round(mediaSec),
            burstMediaSec: round(burst.mediaTicks / TS_CLOCK_HZ),
            burstWallMs: Math.round(burst.atMs),
            burstMbit: megabits(burst.bytes, burst.atMs / 1000),
            mediaBitrateMbit: megabits(this.bytes, mediaSec),
            realtimeAfterMs: realtime ? Math.round(realtime.atMs) : null,
            gopSec: round(this.medianGopTicks() / TS_CLOCK_HZ),
            videoCodec: this.video?.codec ?? 'none',
            audioCodec: this.audio?.codec ?? 'none',
            firstPts: this.firstPts,
            lastPts:
                this.firstPts === null ? null : this.firstPts + this.mediaTicks,
            keyframes: this.keyframes,
        };
    }

    private handlePacket(packet: Buffer, header: TsPacketHeader): void {
        if (header.pid === TS_PID_PAT) {
            const section = this.patAssembler.push(packet, header);
            this.pmtPid = (section && parsePatSection(section)) ?? this.pmtPid;
            return;
        }
        if (header.pid === this.pmtPid && this.clockPid === null) {
            const section = this.pmtAssembler.push(packet, header);
            const map = section && parsePmtSection(section);
            if (map) {
                this.video =
                    map.streams.find((s) => s.kind === 'video') ?? null;
                this.audio =
                    map.streams.find((s) => s.kind === 'audio') ?? null;
                this.clockPid = (this.video ?? this.audio)?.pid ?? null;
            }
            return;
        }
        if (header.pid !== this.clockPid || !header.hasPayload) {
            return;
        }

        if (!header.payloadUnitStart) {
            this.feedFingerprint(
                packet.subarray(header.payloadOffset, TS_PACKET_SIZE)
            );
            return;
        }

        this.finishFingerprint();
        const pes = readPesTimestamps(packet, header);
        if (!pes) {
            return;
        }

        this.firstPts ??= pes.pts;
        this.mediaTicks = Math.max(
            this.mediaTicks,
            timestampDelta(pes.pts, this.firstPts)
        );

        const codec = this.video?.codec as TsVideoCodec | undefined;
        if (codec && isKeyframeStart(packet, header, codec, pes.dataOffset)) {
            this.keyframePts.push(pes.pts);
            this.fingerprint = {
                pts: pes.pts,
                hash: createHash('sha1'),
                remaining: FINGERPRINT_BYTES,
            };
            this.feedFingerprint(
                packet.subarray(pes.dataOffset, TS_PACKET_SIZE)
            );
        }
    }

    private feedFingerprint(data: Buffer): void {
        const pending = this.fingerprint;
        if (!pending) {
            return;
        }
        const part = data.subarray(0, pending.remaining);
        pending.hash.update(part);
        pending.remaining -= part.length;
        if (pending.remaining === 0) {
            this.finishFingerprint();
        }
    }

    private finishFingerprint(): void {
        if (this.fingerprint) {
            this.keyframes.set(
                this.fingerprint.hash.digest('hex'),
                this.fingerprint.pts
            );
            this.fingerprint = null;
        }
    }

    private currentSample(): Sample {
        return {
            atMs: this.lastPushAtMs,
            mediaTicks: this.mediaTicks,
            bytes: this.bytes,
        };
    }

    /** The start of the first one-second window delivered near real time. */
    private findRealtimeSample(): Sample | null {
        // The periodic samples plus the state after the latest chunk.
        const samples = [...this.samples, this.currentSample()];
        let from = 0;
        for (let to = 1; to < samples.length; to += 1) {
            const end = samples[to];
            while (
                from + 1 < to &&
                end.atMs - samples[from + 1].atMs >= RATE_WINDOW_MS
            ) {
                from += 1;
            }
            const start = samples[from];
            const wallMs = end.atMs - start.atMs;
            if (wallMs < RATE_WINDOW_MS) {
                continue;
            }
            const mediaMs =
                ((end.mediaTicks - start.mediaTicks) / TS_CLOCK_HZ) * 1000;
            if (mediaMs / wallMs < REALTIME_RATE) {
                return start;
            }
        }
        return null;
    }

    private medianGopTicks(): number {
        const gaps: number[] = [];
        for (let index = 1; index < this.keyframePts.length; index += 1) {
            const gap = timestampDelta(
                this.keyframePts[index],
                this.keyframePts[index - 1]
            );
            if (gap > 0) {
                gaps.push(gap);
            }
        }
        if (gaps.length === 0) {
            return 0;
        }
        gaps.sort((a, b) => a - b);
        return gaps[Math.floor(gaps.length / 2)];
    }
}

export interface ReopenComparison {
    /** Seconds of the new connection that repeat what the old one delivered. */
    readonly overlapSec: number;
    /** The server kept one timeline across the two connections. */
    readonly timestampsContinuous: boolean;
    /** A keyframe from the old connection was found again in the new one. */
    readonly fingerprintMatched: boolean;
}

/** Slack for the timestamp heuristic when no keyframe could be matched. */
const PLAUSIBLE_BACKWARD_SEC = 180;
const PLAUSIBLE_FORWARD_SLACK_SEC = 30;

/**
 * Lines a reopened connection up against the one before it.
 *
 * A shared keyframe is proof: it gives the exact timestamp offset between
 * the two connections. Without one, the timelines are only assumed shared
 * when the new start lands where a continuous server would put it.
 */
export function compareReopen(
    previous: ConnectionSummary,
    next: ConnectionSummary,
    awaySec: number
): ReopenComparison {
    const unknown = {
        overlapSec: 0,
        timestampsContinuous: false,
        fingerprintMatched: false,
    };
    if (previous.lastPts === null || next.firstPts === null) {
        return unknown;
    }

    for (const [fingerprint, nextPts] of next.keyframes) {
        const previousPts = previous.keyframes.get(fingerprint);
        if (previousPts === undefined) {
            continue;
        }
        const offset = timestampDelta(nextPts, previousPts);
        const startInPrevious = next.firstPts - offset;
        return {
            overlapSec: round(
                timestampDelta(previous.lastPts, startInPrevious) / TS_CLOCK_HZ
            ),
            timestampsContinuous: offset === 0,
            fingerprintMatched: true,
        };
    }

    const stepSec =
        timestampDelta(next.firstPts, previous.lastPts) / TS_CLOCK_HZ;
    const plausible =
        stepSec >= -PLAUSIBLE_BACKWARD_SEC &&
        stepSec <= awaySec + PLAUSIBLE_FORWARD_SLACK_SEC;
    return plausible
        ? {
              overlapSec: round(-stepSec),
              timestampsContinuous: true,
              fingerprintMatched: false,
          }
        : unknown;
}

function megabits(bytes: number, seconds: number): number {
    return seconds > 0 ? round((bytes * 8) / seconds / 1_000_000) : 0;
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}
