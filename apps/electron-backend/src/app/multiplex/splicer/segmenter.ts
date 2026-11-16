/**
 * Cuts one connection's transport stream into keyframe-to-keyframe segments.
 *
 * A segment is every packet of the mux from one video keyframe up to (not
 * including) the next. Cutting the whole mux at keyframes — rather than each
 * elementary stream on its own — means two connections to the same channel
 * are cut at identical byte positions, so a segment from one joins the next
 * segment from the other exactly as the server's own stream would.
 *
 * A segment is only handed over once the next keyframe has arrived, so it is
 * always complete and its duration is known.
 */

import { createHash, Hash } from 'node:crypto';
import {
    parseTsPacket,
    TsPacketAligner,
    TsPacketHeader,
    TS_PACKET_SIZE,
    TS_PID_NULL,
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

const FINGERPRINT_BYTES = 4096;
/** A segment larger than this means keyframes stopped arriving; drop it. */
const MAX_SEGMENT_BYTES = 48 * 1024 * 1024;

export interface TsSegment {
    /** Whole packets, starting with the keyframe's first packet. */
    readonly packets: Buffer[];
    readonly keyframePts: number;
    /** PTS of the keyframe that starts the following segment. */
    readonly nextKeyframePts: number;
    /** Hash of the keyframe's leading bytes: identifies the content. */
    readonly fingerprint: string;
}

export interface TsStreamInfo {
    readonly video: TsElementaryStream;
    readonly audio: TsElementaryStream | null;
}

interface OpenSegment {
    readonly packets: Buffer[];
    readonly keyframePts: number;
    bytes: number;
    hash: Hash | null;
    hashRemaining: number;
    fingerprint: string | null;
}

export class TsSegmenter {
    private readonly aligner = new TsPacketAligner();
    private readonly patAssembler = new PsiSectionAssembler();
    private readonly pmtAssembler = new PsiSectionAssembler();
    private patPacket: Buffer | null = null;
    private pmtPackets: Buffer[] = [];
    private pmtCollecting: Buffer[] = [];
    private pmtPid: number | null = null;
    private stream: TsStreamInfo | null = null;
    private open: OpenSegment | null = null;
    private newestKeyframePts: number | null = null;

    /** The programme's streams, once the PMT has been seen. */
    get info(): TsStreamInfo | null {
        return this.stream;
    }

    /** PAT and PMT packets to place in front of emitted segments. */
    get psiPackets(): Buffer[] {
        return this.patPacket ? [this.patPacket, ...this.pmtPackets] : [];
    }

    /** PTS of the most recent keyframe seen, complete or not. */
    get latestKeyframePts(): number | null {
        return this.newestKeyframePts;
    }

    /** Feeds network bytes; returns the segments completed by them. */
    push(chunk: Buffer): TsSegment[] {
        const completed: TsSegment[] = [];
        const packets = this.aligner.push(chunk);

        for (
            let offset = 0;
            offset + TS_PACKET_SIZE <= packets.length;
            offset += TS_PACKET_SIZE
        ) {
            const packet = packets.subarray(offset, offset + TS_PACKET_SIZE);
            const header = parseTsPacket(packet);
            if (!header || header.pid === TS_PID_NULL) {
                continue;
            }
            if (header.pid === TS_PID_PAT) {
                this.handlePat(packet, header);
            } else if (header.pid === this.pmtPid) {
                this.handlePmt(packet, header);
            } else if (this.stream) {
                const segment = this.handleMedia(packet, header);
                if (segment) {
                    completed.push(segment);
                }
            }
        }
        return completed;
    }

    private handlePat(packet: Buffer, header: TsPacketHeader): void {
        const section = this.patAssembler.push(packet, header);
        const pmtPid = section && parsePatSection(section);
        if (pmtPid) {
            this.pmtPid = pmtPid;
            this.patPacket = Buffer.from(packet);
        }
    }

    private handlePmt(packet: Buffer, header: TsPacketHeader): void {
        if (header.payloadUnitStart) {
            this.pmtCollecting = [];
        }
        this.pmtCollecting.push(Buffer.from(packet));

        const section = this.pmtAssembler.push(packet, header);
        const map = section && parsePmtSection(section);
        if (!map) {
            return;
        }
        this.pmtPackets = this.pmtCollecting;
        this.pmtCollecting = [];
        const video = map.streams.find((s) => s.kind === 'video');
        if (video) {
            this.stream = {
                video,
                audio: map.streams.find((s) => s.kind === 'audio') ?? null,
            };
        }
    }

    private handleMedia(
        packet: Buffer,
        header: TsPacketHeader
    ): TsSegment | null {
        const stream = this.stream as TsStreamInfo;
        const isVideo = header.pid === stream.video.pid;
        let completed: TsSegment | null = null;

        if (isVideo && header.payloadUnitStart) {
            this.finishFingerprint();
            const pes = readPesTimestamps(packet, header);
            const keyframe =
                pes !== null &&
                isKeyframeStart(
                    packet,
                    header,
                    stream.video.codec as TsVideoCodec,
                    pes.dataOffset
                );
            if (pes && keyframe) {
                completed = this.closeSegment(pes.pts);
                this.newestKeyframePts = pes.pts;
                this.open = {
                    packets: [],
                    keyframePts: pes.pts,
                    bytes: 0,
                    hash: createHash('sha1'),
                    hashRemaining: FINGERPRINT_BYTES,
                    fingerprint: null,
                };
                this.feedFingerprint(
                    packet.subarray(pes.dataOffset, TS_PACKET_SIZE)
                );
            }
        } else if (isVideo && header.hasPayload) {
            this.feedFingerprint(
                packet.subarray(header.payloadOffset, TS_PACKET_SIZE)
            );
        }

        const open = this.open;
        if (open) {
            open.packets.push(packet);
            open.bytes += TS_PACKET_SIZE;
            if (open.bytes > MAX_SEGMENT_BYTES) {
                this.open = null;
            }
        }
        return completed;
    }

    private closeSegment(nextKeyframePts: number): TsSegment | null {
        const open = this.open;
        this.open = null;
        if (!open || !open.fingerprint) {
            return null;
        }
        return {
            packets: open.packets,
            keyframePts: open.keyframePts,
            nextKeyframePts,
            fingerprint: open.fingerprint,
        };
    }

    private feedFingerprint(data: Buffer): void {
        const open = this.open;
        if (!open?.hash) {
            return;
        }
        const part = data.subarray(0, open.hashRemaining);
        open.hash.update(part);
        open.hashRemaining -= part.length;
        if (open.hashRemaining === 0) {
            this.finishFingerprint();
        }
    }

    private finishFingerprint(): void {
        const open = this.open;
        if (open?.hash) {
            open.fingerprint = open.hash.digest('hex');
            open.hash = null;
        }
    }
}
