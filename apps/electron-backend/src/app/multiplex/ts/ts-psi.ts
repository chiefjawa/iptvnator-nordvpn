/**
 * PAT/PMT parsing: finds which PIDs carry the programme's video and audio.
 */

import { TsPacketHeader, TS_PACKET_SIZE } from './ts-packet';

export type TsVideoCodec = 'h264' | 'hevc' | 'mpeg2';
export type TsAudioCodec = 'aac' | 'aac-latm' | 'mp2' | 'ac3' | 'eac3';

export interface TsElementaryStream {
    readonly pid: number;
    readonly streamType: number;
    readonly kind: 'video' | 'audio' | 'other';
    readonly codec?: TsVideoCodec | TsAudioCodec;
}

export interface TsProgramMap {
    readonly pcrPid: number;
    readonly streams: readonly TsElementaryStream[];
}

const VIDEO_STREAM_TYPES: Record<number, TsVideoCodec> = {
    0x01: 'mpeg2',
    0x02: 'mpeg2',
    0x1b: 'h264',
    0x24: 'hevc',
};

const AUDIO_STREAM_TYPES: Record<number, TsAudioCodec> = {
    0x03: 'mp2',
    0x04: 'mp2',
    0x0f: 'aac',
    0x11: 'aac-latm',
    0x81: 'ac3',
    0x87: 'eac3',
};

/** DVB descriptors that mark a private-data (0x06) stream as audio. */
const PRIVATE_AUDIO_DESCRIPTORS: Record<number, TsAudioCodec> = {
    0x6a: 'ac3',
    0x7a: 'eac3',
};

const TABLE_ID_PAT = 0x00;
const TABLE_ID_PMT = 0x02;

/**
 * Collects one PSI section, which may span several packets of a PID.
 * Returns the whole section (from table_id through the CRC) once complete.
 */
export class PsiSectionAssembler {
    private parts: Buffer[] = [];
    private collected = 0;
    private expected = 0;

    push(packet: Buffer, header: TsPacketHeader): Buffer | null {
        if (!header.hasPayload) {
            return null;
        }

        let start = header.payloadOffset;
        if (header.payloadUnitStart) {
            // pointer_field: bytes to skip before the new section begins.
            start += 1 + packet[start];
            if (start + 3 > TS_PACKET_SIZE) {
                return null;
            }
            this.parts = [];
            this.collected = 0;
            this.expected =
                3 + (((packet[start + 1] & 0x0f) << 8) | packet[start + 2]);
        } else if (this.expected === 0) {
            return null;
        }

        const part = packet.subarray(start, TS_PACKET_SIZE);
        this.parts.push(part);
        this.collected += part.length;
        if (this.collected < this.expected) {
            return null;
        }

        const section = Buffer.concat(this.parts).subarray(0, this.expected);
        this.parts = [];
        this.collected = 0;
        this.expected = 0;
        return section;
    }
}

/** Returns the PMT PID of the first real programme in a PAT section. */
export function parsePatSection(section: Buffer): number | null {
    if (section.length < 12 || section[0] !== TABLE_ID_PAT) {
        return null;
    }

    // 8 header bytes, then 4-byte entries, then a 4-byte CRC.
    for (let offset = 8; offset + 4 <= section.length - 4; offset += 4) {
        const programNumber = section.readUInt16BE(offset);
        if (programNumber !== 0) {
            return section.readUInt16BE(offset + 2) & 0x1fff;
        }
    }
    return null;
}

export function parsePmtSection(section: Buffer): TsProgramMap | null {
    if (section.length < 16 || section[0] !== TABLE_ID_PMT) {
        return null;
    }

    const pcrPid = section.readUInt16BE(8) & 0x1fff;
    const programInfoLength = section.readUInt16BE(10) & 0x0fff;
    const end = section.length - 4;
    const streams: TsElementaryStream[] = [];

    let offset = 12 + programInfoLength;
    while (offset + 5 <= end) {
        const streamType = section[offset];
        const pid = section.readUInt16BE(offset + 1) & 0x1fff;
        const infoLength = section.readUInt16BE(offset + 3) & 0x0fff;
        const descriptors = section.subarray(
            offset + 5,
            Math.min(offset + 5 + infoLength, end)
        );
        streams.push(classifyStream(pid, streamType, descriptors));
        offset += 5 + infoLength;
    }

    return { pcrPid, streams };
}

function classifyStream(
    pid: number,
    streamType: number,
    descriptors: Buffer
): TsElementaryStream {
    const video = VIDEO_STREAM_TYPES[streamType];
    if (video) {
        return { pid, streamType, kind: 'video', codec: video };
    }

    const audio =
        AUDIO_STREAM_TYPES[streamType] ??
        (streamType === 0x06 ? findPrivateAudioCodec(descriptors) : undefined);
    if (audio) {
        return { pid, streamType, kind: 'audio', codec: audio };
    }

    return { pid, streamType, kind: 'other' };
}

function findPrivateAudioCodec(descriptors: Buffer): TsAudioCodec | undefined {
    for (let offset = 0; offset + 2 <= descriptors.length; ) {
        const codec = PRIVATE_AUDIO_DESCRIPTORS[descriptors[offset]];
        if (codec) {
            return codec;
        }
        offset += 2 + descriptors[offset + 1];
    }
    return undefined;
}
