import {
    buildChannelSlice,
    SYNTHETIC_AUDIO_PID,
    SYNTHETIC_VIDEO_PID,
    SyntheticTsWriter,
} from '../testing/synthetic-ts';
import {
    parseTsPacket,
    timestampDelta,
    TS_TIMESTAMP_MODULO,
} from '../ts/ts-packet';
import { readPesTimestamps } from '../ts/ts-pes';
import { TileSplicer, VisitSummary } from './tile-splicer';

const FRAME_TICKS = 3600;

/** One connection's bytes: PSI, then `frames` frames from `fromFrame`. */
function connection(
    fromFrame: number,
    frames: number,
    ptsOffset = 0
): Buffer {
    const writer = new SyntheticTsWriter();
    return Buffer.concat([
        writer.psi(),
        ...buildChannelSlice(writer, { fromFrame, frames, ptsOffset }),
    ]);
}

function visit(
    splicer: TileSplicer,
    bytes: Buffer,
    chunkSize = bytes.length
): { output: Buffer[]; summary: VisitSummary } {
    const output: Buffer[] = [];
    splicer.beginVisit();
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        output.push(
            ...splicer.push(bytes.subarray(offset, offset + chunkSize)).output
        );
    }
    return { output, summary: splicer.endVisit() };
}

/** Video PTS of every frame in the output, in stream order. */
function videoPts(packets: Buffer[]): number[] {
    const pts: number[] = [];
    for (const packet of packets) {
        const header = parseTsPacket(packet);
        if (header?.pid === SYNTHETIC_VIDEO_PID && header.payloadUnitStart) {
            const pes = readPesTimestamps(packet, header);
            if (pes) {
                pts.push(pes.pts);
            }
        }
    }
    return pts;
}

function expectGapless(packets: Buffer[]): void {
    const pts = videoPts(packets);
    expect(pts.length).toBeGreaterThan(1);
    for (let index = 1; index < pts.length; index += 1) {
        expect(timestampDelta(pts[index], pts[index - 1])).toBe(FRAME_TICKS);
    }
}

function expectContinuousCounters(packets: Buffer[], pid: number): void {
    let previous: number | undefined;
    for (const packet of packets) {
        const header = parseTsPacket(packet);
        if (header?.pid !== pid || !header.hasPayload) {
            continue;
        }
        if (previous !== undefined) {
            expect(header.continuityCounter).toBe((previous + 1) & 0x0f);
        }
        previous = header.continuityCounter;
    }
    expect(previous).toBeDefined();
}

describe('TileSplicer', () => {
    it('forwards only whole keyframe-to-keyframe segments', () => {
        const splicer = new TileSplicer();

        // 63 frames at 25 fps with a 1 s GOP: two whole GOPs and a partial.
        const { output, summary } = visit(splicer, connection(0, 63));

        expect(videoPts(output)).toHaveLength(50);
        expect(summary).toEqual({
            newMediaMs: 2000,
            overlapMs: 0,
            skippedMs: 0,
            restart: false,
        });
        expect(splicer.info?.video.codec).toBe('h264');
    });

    it('drops the repeated start of a revisit and continues seamlessly', () => {
        const splicer = new TileSplicer();
        const first = visit(splicer, connection(0, 76));

        // The revisit starts 2 s back, inside what was already forwarded.
        const second = visit(splicer, connection(25, 101));

        expect(second.summary).toEqual({
            newMediaMs: 2000,
            overlapMs: 2000,
            skippedMs: 0,
            restart: false,
        });
        const all = [...first.output, ...second.output];
        expect(videoPts(all)).toHaveLength(125);
        expectGapless(all);
    });

    it('stitches by content when the server restarts its timestamps', () => {
        const splicer = new TileSplicer();
        const first = visit(splicer, connection(0, 76));

        const second = visit(splicer, connection(25, 101, 7_000_000));

        expect(second.summary).toMatchObject({
            newMediaMs: 2000,
            overlapMs: 2000,
            skippedMs: 0,
            restart: true,
        });
        expectGapless([...first.output, ...second.output]);
    });

    it('closes the hole and reports a skip when content was missed', () => {
        const splicer = new TileSplicer();
        const first = visit(splicer, connection(0, 76));

        // Forwarded up to frame 75; the revisit only reaches back to 200.
        const second = visit(splicer, connection(200, 51));

        expect(second.summary).toEqual({
            newMediaMs: 2000,
            overlapMs: 0,
            skippedMs: 5000,
            restart: false,
        });
        expectGapless([...first.output, ...second.output]);
    });

    it('continues from here when nothing lines up with the last visit', () => {
        const splicer = new TileSplicer();
        const first = visit(splicer, connection(0, 76));

        // Unseen content on an unrelated clock.
        const second = visit(
            splicer,
            connection(5000, 51, TS_TIMESTAMP_MODULO / 2)
        );

        expect(second.summary).toMatchObject({ newMediaMs: 2000, restart: true });
        expectGapless([...first.output, ...second.output]);
    });

    it('keeps the output gapless across the 33-bit timestamp wrap', () => {
        const splicer = new TileSplicer();
        // The source clock wraps one second into the first connection.
        const wrapOffset = TS_TIMESTAMP_MODULO - 25 * FRAME_TICKS;

        const first = visit(splicer, connection(0, 76, wrapOffset));
        const second = visit(splicer, connection(50, 76, wrapOffset));

        expect(second.summary).toMatchObject({ overlapMs: 1000, restart: false });
        expectGapless([...first.output, ...second.output]);
    });

    it('renumbers continuity counters across dropped and joined pieces', () => {
        const splicer = new TileSplicer();
        const all = [
            ...visit(splicer, connection(0, 76)).output,
            ...visit(splicer, connection(25, 101)).output,
            ...visit(splicer, connection(300, 51)).output,
        ];

        expectContinuousCounters(all, SYNTHETIC_VIDEO_PID);
        expectContinuousCounters(all, SYNTHETIC_AUDIO_PID);
        expectContinuousCounters(all, 0);
    });

    it('gives the same result when bytes arrive in odd-sized chunks', () => {
        const whole = visit(new TileSplicer(), connection(0, 101));
        const chunked = visit(new TileSplicer(), connection(0, 101), 1009);

        expect(Buffer.concat(chunked.output)).toEqual(
            Buffer.concat(whole.output)
        );
    });

    it('starts output timestamps near zero whatever the source clock', () => {
        const { output } = visit(
            new TileSplicer(),
            connection(0, 51, 4_000_000_000)
        );

        expect(videoPts(output)[0]).toBe(900_000);
    });

    it('reports media received separately from media forwarded', () => {
        const splicer = new TileSplicer();
        visit(splicer, connection(0, 76));

        splicer.beginVisit();
        const result = splicer.push(connection(25, 101));

        expect(result.receivedMs).toBe(4000);
        expect(result.forwardedMs).toBe(2000);
    });
});
