/**
 * Builds small, valid MPEG transport streams in memory for tests.
 *
 * Frames are H.264-shaped (access unit delimiter, optional SPS, slice) with
 * filler bytes derived from a seed, so the same seed yields byte-identical
 * frame content — which is what a real server sends when two connections
 * overlap on the same piece of a live channel.
 */

import { TS_PACKET_SIZE, TS_SYNC_BYTE } from '../ts/ts-packet';
import { writePesTimestamp } from '../ts/ts-pes';

export const SYNTHETIC_PMT_PID = 0x1000;
export const SYNTHETIC_VIDEO_PID = 0x100;
export const SYNTHETIC_AUDIO_PID = 0x101;

export interface SyntheticFrameOptions {
    readonly keyframe?: boolean;
    /** Signal the keyframe with the adaptation-field flag instead of NALs. */
    readonly randomAccessFlag?: boolean;
    /** Elementary stream bytes after the NAL headers. */
    readonly size?: number;
    /** Content identity; defaults to the PTS. */
    readonly seed?: number;
    readonly dts?: number;
}

export interface SyntheticStreamOptions {
    readonly videoStreamType?: number;
    readonly audioStreamType?: number;
    /** Extra PMT entries, to force a section across several packets. */
    readonly extraStreams?: number;
}

export class SyntheticTsWriter {
    private readonly counters = new Map<number, number>();

    constructor(private readonly options: SyntheticStreamOptions = {}) {}

    /** PAT followed by PMT. */
    psi(): Buffer {
        return Buffer.concat([this.pat(), this.pmt()]);
    }

    pat(): Buffer {
        const section = Buffer.from([
            0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00,
            0x00, 0x01,
            0xe0 | (SYNTHETIC_PMT_PID >> 8), SYNTHETIC_PMT_PID & 0xff,
            0, 0, 0, 0,
        ]);
        return this.packetize(0, withPointerField(section), {});
    }

    pmt(): Buffer {
        const entries = [
            streamEntry(
                this.options.videoStreamType ?? 0x1b,
                SYNTHETIC_VIDEO_PID
            ),
            streamEntry(
                this.options.audioStreamType ?? 0x0f,
                SYNTHETIC_AUDIO_PID
            ),
        ];
        for (let index = 0; index < (this.options.extraStreams ?? 0); index++) {
            // Private data streams with a long descriptor.
            entries.push(
                Buffer.concat([
                    streamEntry(0x05, 0x200 + index, 40),
                    Buffer.alloc(40, 0xaa),
                ])
            );
        }
        const body = Buffer.concat(entries);
        const sectionLength = 9 + body.length + 4;
        const section = Buffer.concat([
            Buffer.from([
                0x02,
                0xb0 | (sectionLength >> 8),
                sectionLength & 0xff,
                0x00, 0x01, 0xc1, 0x00, 0x00,
                0xe0 | (SYNTHETIC_VIDEO_PID >> 8), SYNTHETIC_VIDEO_PID & 0xff,
                0xf0, 0x00,
            ]),
            body,
            Buffer.alloc(4),
        ]);
        return this.packetize(SYNTHETIC_PMT_PID, withPointerField(section), {});
    }

    video(pts: number, frame: SyntheticFrameOptions = {}): Buffer {
        const useFlag = frame.keyframe && frame.randomAccessFlag;
        const nal = [0x00, 0x00, 0x00, 0x01, 0x09, 0xf0];
        if (frame.keyframe && !useFlag) {
            nal.push(0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x1f);
        }
        nal.push(0x00, 0x00, 0x00, 0x01, frame.keyframe && !useFlag ? 0x65 : 0x41);
        const payload = Buffer.concat([
            pesHeader(0xe0, pts, frame.dts),
            Buffer.from(nal),
            filler(frame.size ?? 600, frame.seed ?? pts),
        ]);
        return this.packetize(SYNTHETIC_VIDEO_PID, payload, {
            randomAccess: useFlag,
        });
    }

    audio(pts: number, size = 200): Buffer {
        const payload = Buffer.concat([
            pesHeader(0xc0, pts),
            filler(size, pts + 1),
        ]);
        return this.packetize(SYNTHETIC_AUDIO_PID, payload, {});
    }

    private packetize(
        pid: number,
        payload: Buffer,
        flags: { randomAccess?: boolean }
    ): Buffer {
        const packets: Buffer[] = [];
        let offset = 0;
        let first = true;

        while (offset < payload.length) {
            const remaining = payload.length - offset;
            const adaptationFlags = first && flags.randomAccess ? 0x40 : 0;
            const packet = Buffer.alloc(TS_PACKET_SIZE, 0xff);
            const counter = this.counters.get(pid) ?? 0;
            this.counters.set(pid, (counter + 1) & 0x0f);

            packet[0] = TS_SYNC_BYTE;
            packet[1] = (first ? 0x40 : 0x00) | (pid >> 8);
            packet[2] = pid & 0xff;

            let dataStart = 4;
            if (adaptationFlags || remaining < 184) {
                packet[3] = 0x30 | counter;
                if (!adaptationFlags && remaining === 183) {
                    packet[4] = 0;
                    dataStart = 5;
                } else {
                    const stuffing = Math.max(0, 182 - remaining);
                    packet[4] = 1 + stuffing;
                    packet[5] = adaptationFlags;
                    dataStart = 6 + stuffing;
                }
            } else {
                packet[3] = 0x10 | counter;
            }

            const take = Math.min(remaining, TS_PACKET_SIZE - dataStart);
            payload.copy(packet, dataStart, offset, offset + take);
            offset += take;
            first = false;
            packets.push(packet);
        }
        return Buffer.concat(packets);
    }
}

/**
 * A stretch of video at `fps`, with a keyframe every `gopFrames`, starting
 * at frame index `fromFrame` of an endless channel whose frame N always has
 * the same content. `ptsOffset` shifts the timestamps without changing the
 * content, like a server that restarts its clock per connection.
 */
export function buildChannelSlice(
    writer: SyntheticTsWriter,
    options: {
        fromFrame: number;
        frames: number;
        fps?: number;
        gopFrames?: number;
        ptsOffset?: number;
    }
): Buffer[] {
    const fps = options.fps ?? 25;
    const gop = options.gopFrames ?? 25;
    const ticks = 90000 / fps;
    const frames: Buffer[] = [];

    for (
        let index = options.fromFrame;
        index < options.fromFrame + options.frames;
        index += 1
    ) {
        const pts = index * ticks + (options.ptsOffset ?? 0);
        frames.push(
            Buffer.concat([
                writer.video(pts, { keyframe: index % gop === 0, seed: index }),
                writer.audio(pts),
            ])
        );
    }
    return frames;
}

function withPointerField(section: Buffer): Buffer {
    return Buffer.concat([Buffer.from([0x00]), section]);
}

function streamEntry(streamType: number, pid: number, infoLength = 0): Buffer {
    return Buffer.from([
        streamType,
        0xe0 | (pid >> 8),
        pid & 0xff,
        0xf0 | (infoLength >> 8),
        infoLength & 0xff,
    ]);
}

function pesHeader(streamId: number, pts: number, dts?: number): Buffer {
    const hasDts = dts !== undefined;
    const header = Buffer.alloc(hasDts ? 19 : 14);
    header[2] = 0x01;
    header[3] = streamId;
    header[6] = 0x80;
    header[7] = hasDts ? 0xc0 : 0x80;
    header[8] = hasDts ? 10 : 5;
    header[9] = hasDts ? 0x30 : 0x20;
    writePesTimestamp(header, 9, pts);
    if (hasDts) {
        header[14] = 0x10;
        writePesTimestamp(header, 14, dts);
    }
    return header;
}

/** Deterministic bytes in 0x80-0xff: can never form a start code. */
function filler(size: number, seed: number): Buffer {
    const bytes = Buffer.alloc(size);
    let state = (Math.floor(seed) % 2147483647) + 1;
    for (let index = 0; index < size; index += 1) {
        state = (state * 48271) % 2147483647;
        bytes[index] = 0x80 | (state & 0x7f);
    }
    return bytes;
}
