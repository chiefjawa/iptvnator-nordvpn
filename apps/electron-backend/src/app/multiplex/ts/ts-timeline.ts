/**
 * In-place rewriting of a packet's clocks and continuity counter, so pieces
 * taken from different connections read as one uninterrupted stream.
 */

import {
    readPcrBase,
    TsPacketHeader,
    TS_PACKET_SIZE,
    TS_TIMESTAMP_MODULO,
    writePcrBase,
} from './ts-packet';
import { readPesTimestamp, writePesTimestamp } from './ts-pes';

/** Adds `shift` ticks to a timestamp, wrapping on the 33-bit circle. */
export function shiftTimestamp(value: number, shift: number): number {
    return (
        (((value + shift) % TS_TIMESTAMP_MODULO) + TS_TIMESTAMP_MODULO) %
        TS_TIMESTAMP_MODULO
    );
}

/** Shifts the PCR and any PES PTS/DTS carried by this packet. */
export function shiftPacketTimestamps(
    packet: Buffer,
    header: TsPacketHeader,
    shift: number
): void {
    if (shift === 0) {
        return;
    }

    if (header.pcr !== undefined) {
        writePcrBase(packet, 6, shiftTimestamp(readPcrBase(packet, 6), shift));
    }

    const start = header.payloadOffset;
    if (!header.payloadUnitStart || start + 14 > TS_PACKET_SIZE) {
        return;
    }
    if (
        packet[start] !== 0x00 ||
        packet[start + 1] !== 0x00 ||
        packet[start + 2] !== 0x01
    ) {
        return;
    }

    const flags = packet[start + 7] >> 6;
    if ((flags & 0x2) === 0) {
        return;
    }
    const ptsOffset = start + 9;
    writePesTimestamp(
        packet,
        ptsOffset,
        shiftTimestamp(readPesTimestamp(packet, ptsOffset), shift)
    );
    if (flags === 0x3 && ptsOffset + 10 <= TS_PACKET_SIZE) {
        writePesTimestamp(
            packet,
            ptsOffset + 5,
            shiftTimestamp(readPesTimestamp(packet, ptsOffset + 5), shift)
        );
    }
}

/**
 * Renumbers continuity counters per PID across everything written to one
 * output, so dropping or joining pieces never looks like packet loss.
 */
export class ContinuityRewriter {
    private readonly counters = new Map<number, number>();

    apply(packet: Buffer, pid: number): void {
        const carriesPayload = (packet[3] & 0x10) !== 0;
        const previous = this.counters.get(pid);
        // The counter only advances on packets that carry payload.
        const next = carriesPayload
            ? previous === undefined
                ? 0
                : (previous + 1) & 0x0f
            : (previous ?? 0);
        this.counters.set(pid, next);
        packet[3] = (packet[3] & 0xf0) | next;
    }
}
