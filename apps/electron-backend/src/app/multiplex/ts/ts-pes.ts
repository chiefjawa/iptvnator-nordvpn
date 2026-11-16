/**
 * PES header timestamps and keyframe detection.
 *
 * Works on the payload of a packet whose payload_unit_start flag is set,
 * which is where a PES header (and the start of an access unit) lives.
 */

import { TsPacketHeader, TS_PACKET_SIZE } from './ts-packet';
import { TsVideoCodec } from './ts-psi';

export interface PesTimestamps {
    readonly pts: number;
    /** Absent when the PES carries only a PTS (decode order = display order). */
    readonly dts?: number;
    /** Offset inside the packet where the PTS bytes start. */
    readonly ptsOffset: number;
    /** Offset inside the packet where the elementary stream data starts. */
    readonly dataOffset: number;
}

/** Reads PTS/DTS from a PES-start packet; null when it has no PTS. */
export function readPesTimestamps(
    packet: Buffer,
    header: TsPacketHeader
): PesTimestamps | null {
    const start = header.payloadOffset;
    if (!header.payloadUnitStart || start + 14 > TS_PACKET_SIZE) {
        return null;
    }
    if (
        packet[start] !== 0x00 ||
        packet[start + 1] !== 0x00 ||
        packet[start + 2] !== 0x01
    ) {
        return null;
    }

    const flags = packet[start + 7] >> 6;
    if ((flags & 0x2) === 0) {
        return null;
    }

    const ptsOffset = start + 9;
    const hasDts = flags === 0x3 && ptsOffset + 10 <= TS_PACKET_SIZE;
    return {
        pts: readPesTimestamp(packet, ptsOffset),
        dts: hasDts ? readPesTimestamp(packet, ptsOffset + 5) : undefined,
        ptsOffset,
        dataOffset: Math.min(start + 9 + packet[start + 8], TS_PACKET_SIZE),
    };
}

/** Decodes the five-byte, marker-bit-interleaved 33-bit timestamp. */
export function readPesTimestamp(buffer: Buffer, offset: number): number {
    return (
        ((buffer[offset] >> 1) & 0x07) * 2 ** 30 +
        buffer[offset + 1] * 2 ** 22 +
        (buffer[offset + 2] >> 1) * 2 ** 15 +
        buffer[offset + 3] * 2 ** 7 +
        (buffer[offset + 4] >> 1)
    );
}

/** Rewrites a timestamp in place, keeping its prefix nibble and marker bits. */
export function writePesTimestamp(
    buffer: Buffer,
    offset: number,
    value: number
): void {
    buffer[offset] =
        (buffer[offset] & 0xf0) |
        ((Math.floor(value / 2 ** 30) & 0x07) << 1) |
        0x01;
    buffer[offset + 1] = Math.floor(value / 2 ** 22) & 0xff;
    buffer[offset + 2] = ((Math.floor(value / 2 ** 15) & 0x7f) << 1) | 0x01;
    buffer[offset + 3] = Math.floor(value / 2 ** 7) & 0xff;
    buffer[offset + 4] = ((value & 0x7f) << 1) | 0x01;
}

/**
 * True when the access unit starting in this packet is a random access point.
 *
 * The adaptation-field flag is the cheap answer, but many IPTV muxers never
 * set it, so the start of the elementary data is also scanned for the codec's
 * own markers. Parameter sets count: encoders send them with each keyframe,
 * and the keyframe slice itself can sit beyond this first packet.
 */
export function isKeyframeStart(
    packet: Buffer,
    header: TsPacketHeader,
    codec: TsVideoCodec,
    dataOffset: number
): boolean {
    if (header.randomAccess) {
        return true;
    }

    for (
        let offset = dataOffset;
        offset + 3 < TS_PACKET_SIZE;
        offset += 1
    ) {
        if (
            packet[offset] !== 0x00 ||
            packet[offset + 1] !== 0x00 ||
            packet[offset + 2] !== 0x01
        ) {
            continue;
        }
        if (isRandomAccessUnit(packet[offset + 3], codec)) {
            return true;
        }
        offset += 3;
    }
    return false;
}

function isRandomAccessUnit(unitHeader: number, codec: TsVideoCodec): boolean {
    if (codec === 'h264') {
        const type = unitHeader & 0x1f;
        // 5 = IDR slice, 7 = sequence parameter set.
        return type === 5 || type === 7;
    }
    if (codec === 'hevc') {
        const type = (unitHeader >> 1) & 0x3f;
        // 16-21 = IRAP pictures, 32/33 = video/sequence parameter sets.
        return (type >= 16 && type <= 21) || type === 32 || type === 33;
    }
    // MPEG-2: sequence header or group-of-pictures start code.
    return unitHeader === 0xb3 || unitHeader === 0xb8;
}
