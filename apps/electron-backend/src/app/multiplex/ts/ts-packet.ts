/**
 * MPEG transport stream packet layer for connection multiplexing.
 *
 * Only what stitching live bursts together needs: packet alignment, the
 * fixed header, and the adaptation-field flags and PCR. Elementary stream
 * decoding stays in the renderer (mpegts.js).
 */

export const TS_PACKET_SIZE = 188;
export const TS_SYNC_BYTE = 0x47;
export const TS_PID_PAT = 0x0000;
export const TS_PID_NULL = 0x1fff;
/** PTS, DTS and the PCR base all count 90 kHz ticks in 33 bits. */
export const TS_CLOCK_HZ = 90000;
export const TS_TIMESTAMP_MODULO = 2 ** 33;

export interface TsPacketHeader {
    readonly pid: number;
    readonly payloadUnitStart: boolean;
    readonly continuityCounter: number;
    readonly hasPayload: boolean;
    /** Offset of the payload inside the packet; 188 when there is none. */
    readonly payloadOffset: number;
    readonly discontinuity: boolean;
    readonly randomAccess: boolean;
    /** PCR base in 90 kHz ticks, when the packet carries one. */
    readonly pcr?: number;
}

/** Parses the packet starting at `offset`; null when it is not a TS packet. */
export function parseTsPacket(
    buffer: Buffer,
    offset = 0
): TsPacketHeader | null {
    if (
        offset + TS_PACKET_SIZE > buffer.length ||
        buffer[offset] !== TS_SYNC_BYTE
    ) {
        return null;
    }

    const byte1 = buffer[offset + 1];
    const byte3 = buffer[offset + 3];
    const adaptationControl = (byte3 >> 4) & 0x3;
    const hasAdaptation = (adaptationControl & 0x2) !== 0;
    const hasPayload = (adaptationControl & 0x1) !== 0;

    let payloadOffset = 4;
    let discontinuity = false;
    let randomAccess = false;
    let pcr: number | undefined;

    if (hasAdaptation) {
        const length = buffer[offset + 4];
        payloadOffset = 5 + length;
        if (length > 0) {
            const flags = buffer[offset + 5];
            discontinuity = (flags & 0x80) !== 0;
            randomAccess = (flags & 0x40) !== 0;
            if ((flags & 0x10) !== 0 && length >= 7) {
                pcr = readPcrBase(buffer, offset + 6);
            }
        }
    }

    const payloadPresent = hasPayload && payloadOffset < TS_PACKET_SIZE;
    return {
        pid: ((byte1 & 0x1f) << 8) | buffer[offset + 2],
        payloadUnitStart: (byte1 & 0x40) !== 0,
        continuityCounter: byte3 & 0x0f,
        hasPayload: payloadPresent,
        payloadOffset: payloadPresent ? payloadOffset : TS_PACKET_SIZE,
        discontinuity,
        randomAccess,
        pcr,
    };
}

/** Reads the 33-bit PCR base at `offset` (the first of the six PCR bytes). */
export function readPcrBase(buffer: Buffer, offset: number): number {
    return (
        buffer[offset] * 2 ** 25 +
        buffer[offset + 1] * 2 ** 17 +
        buffer[offset + 2] * 2 ** 9 +
        buffer[offset + 3] * 2 +
        (buffer[offset + 4] >> 7)
    );
}

/** Overwrites the 33-bit PCR base, leaving the 9-bit extension untouched. */
export function writePcrBase(
    buffer: Buffer,
    offset: number,
    value: number
): void {
    buffer[offset] = Math.floor(value / 2 ** 25) & 0xff;
    buffer[offset + 1] = Math.floor(value / 2 ** 17) & 0xff;
    buffer[offset + 2] = Math.floor(value / 2 ** 9) & 0xff;
    buffer[offset + 3] = Math.floor(value / 2) & 0xff;
    buffer[offset + 4] = ((value % 2) << 7) | (buffer[offset + 4] & 0x7f);
}

/**
 * Signed distance from `from` to `to` on the 33-bit timestamp circle, so a
 * wrap between two nearby timestamps is a small step, not a 26-hour jump.
 */
export function timestampDelta(to: number, from: number): number {
    const half = TS_TIMESTAMP_MODULO / 2;
    return (
        ((((to - from + half) % TS_TIMESTAMP_MODULO) + TS_TIMESTAMP_MODULO) %
            TS_TIMESTAMP_MODULO) -
        half
    );
}

/**
 * Turns arbitrary network chunks into whole, sync-aligned packets.
 *
 * A live stream can be joined mid-packet and a chunk boundary can fall
 * anywhere, so the aligner keeps the unfinished tail and re-finds the sync
 * byte whenever alignment is lost.
 */
export class TsPacketAligner {
    private pending: Buffer = Buffer.alloc(0);

    /** Returns a buffer holding zero or more complete packets. */
    push(chunk: Buffer): Buffer {
        const data =
            this.pending.length === 0
                ? chunk
                : Buffer.concat([this.pending, chunk]);
        const pieces: Buffer[] = [];
        let position = 0;

        while (position + TS_PACKET_SIZE <= data.length) {
            if (!this.isAligned(data, position)) {
                const next = this.findSync(data, position + 1);
                if (next === -1) {
                    position = data.length;
                    break;
                }
                position = next;
                continue;
            }

            let end = position + TS_PACKET_SIZE;
            while (
                end + TS_PACKET_SIZE <= data.length &&
                data[end] === TS_SYNC_BYTE
            ) {
                end += TS_PACKET_SIZE;
            }
            pieces.push(data.subarray(position, end));
            position = end;
        }

        // Copy the tail: `data` may alias the caller's chunk.
        this.pending = Buffer.from(data.subarray(position));
        if (pieces.length === 1) {
            return pieces[0];
        }
        return Buffer.concat(pieces);
    }

    reset(): void {
        this.pending = Buffer.alloc(0);
    }

    private isAligned(data: Buffer, position: number): boolean {
        if (data[position] !== TS_SYNC_BYTE) {
            return false;
        }
        const following = position + TS_PACKET_SIZE;
        return following >= data.length || data[following] === TS_SYNC_BYTE;
    }

    private findSync(data: Buffer, from: number): number {
        for (
            let index = data.indexOf(TS_SYNC_BYTE, from);
            index !== -1;
            index = data.indexOf(TS_SYNC_BYTE, index + 1)
        ) {
            if (this.isAligned(data, index)) {
                return index;
            }
        }
        return -1;
    }
}
