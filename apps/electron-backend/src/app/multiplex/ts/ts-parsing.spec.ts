import {
    SYNTHETIC_AUDIO_PID,
    SYNTHETIC_PMT_PID,
    SYNTHETIC_VIDEO_PID,
    SyntheticTsWriter,
} from '../testing/synthetic-ts';
import {
    parseTsPacket,
    readPcrBase,
    timestampDelta,
    TsPacketAligner,
    TsPacketHeader,
    TS_PACKET_SIZE,
    TS_TIMESTAMP_MODULO,
    writePcrBase,
} from './ts-packet';
import {
    isKeyframeStart,
    readPesTimestamp,
    readPesTimestamps,
    writePesTimestamp,
} from './ts-pes';
import {
    parsePatSection,
    parsePmtSection,
    PsiSectionAssembler,
} from './ts-psi';

function packetsOf(buffer: Buffer): Buffer[] {
    const packets: Buffer[] = [];
    for (let offset = 0; offset < buffer.length; offset += TS_PACKET_SIZE) {
        packets.push(buffer.subarray(offset, offset + TS_PACKET_SIZE));
    }
    return packets;
}

function headerOf(packet: Buffer): TsPacketHeader {
    const header = parseTsPacket(packet);
    if (!header) {
        throw new Error('not a TS packet');
    }
    return header;
}

describe('TS packet layer', () => {
    it('parses the fixed header of a PES-start packet', () => {
        const writer = new SyntheticTsWriter();
        const [first, second] = packetsOf(writer.video(9000, { size: 400 }));

        expect(headerOf(first)).toMatchObject({
            pid: SYNTHETIC_VIDEO_PID,
            payloadUnitStart: true,
            continuityCounter: 0,
            hasPayload: true,
            payloadOffset: 4,
            randomAccess: false,
        });
        expect(headerOf(second)).toMatchObject({
            payloadUnitStart: false,
            continuityCounter: 1,
        });
    });

    it('reads the random access flag from the adaptation field', () => {
        const writer = new SyntheticTsWriter();
        const [first] = packetsOf(
            writer.video(0, { keyframe: true, randomAccessFlag: true })
        );

        expect(headerOf(first).randomAccess).toBe(true);
        expect(headerOf(first).payloadOffset).toBe(6);
    });

    it('rejects a buffer that does not start with the sync byte', () => {
        expect(parseTsPacket(Buffer.alloc(TS_PACKET_SIZE, 0x00))).toBeNull();
        expect(parseTsPacket(Buffer.alloc(10, 0x47))).toBeNull();
    });

    it('round-trips a 33-bit PCR base', () => {
        const buffer = Buffer.alloc(6, 0xff);
        const value = TS_TIMESTAMP_MODULO - 3;

        writePcrBase(buffer, 0, value);

        expect(readPcrBase(buffer, 0)).toBe(value);
        // The reserved bits and extension after the base are left alone.
        expect(buffer[4] & 0x7f).toBe(0x7f);
        expect(buffer[5]).toBe(0xff);
    });

    it('measures timestamp distance across the 33-bit wrap', () => {
        expect(timestampDelta(100, TS_TIMESTAMP_MODULO - 100)).toBe(200);
        expect(timestampDelta(TS_TIMESTAMP_MODULO - 100, 100)).toBe(-200);
        expect(timestampDelta(5000, 2000)).toBe(3000);
    });
});

describe('TsPacketAligner', () => {
    const stream = () => {
        const writer = new SyntheticTsWriter();
        return Buffer.concat([
            writer.psi(),
            writer.video(0, { keyframe: true }),
            writer.audio(0),
        ]);
    };

    it('reassembles packets split across arbitrary chunk boundaries', () => {
        const source = stream();
        const aligner = new TsPacketAligner();
        const out: Buffer[] = [];

        for (let offset = 0; offset < source.length; offset += 61) {
            out.push(aligner.push(source.subarray(offset, offset + 61)));
        }

        expect(Buffer.concat(out).equals(source)).toBe(true);
    });

    it('finds alignment when the stream is joined mid-packet', () => {
        const source = stream();
        const aligner = new TsPacketAligner();

        const out = aligner.push(source.subarray(77));

        expect(out.equals(source.subarray(TS_PACKET_SIZE))).toBe(true);
    });

    it('recovers after garbage in the middle of the stream', () => {
        const source = stream();
        const cut = TS_PACKET_SIZE * 2;
        const aligner = new TsPacketAligner();

        const out = aligner.push(
            Buffer.concat([
                source.subarray(0, cut),
                Buffer.from([0x01, 0x47, 0x02, 0x03]),
                source.subarray(cut),
            ])
        );

        expect(out.equals(source)).toBe(true);
    });
});

describe('PSI parsing', () => {
    it('finds the PMT PID and the elementary streams', () => {
        const writer = new SyntheticTsWriter({ audioStreamType: 0x81 });
        const pat = writer.pat();
        const pmt = writer.pmt();

        const patSection = new PsiSectionAssembler().push(pat, headerOf(pat));
        const pmtSection = new PsiSectionAssembler().push(pmt, headerOf(pmt));

        expect(patSection && parsePatSection(patSection)).toBe(
            SYNTHETIC_PMT_PID
        );
        expect(pmtSection && parsePmtSection(pmtSection)).toEqual({
            pcrPid: SYNTHETIC_VIDEO_PID,
            streams: [
                {
                    pid: SYNTHETIC_VIDEO_PID,
                    streamType: 0x1b,
                    kind: 'video',
                    codec: 'h264',
                },
                {
                    pid: SYNTHETIC_AUDIO_PID,
                    streamType: 0x81,
                    kind: 'audio',
                    codec: 'ac3',
                },
            ],
        });
    });

    it('assembles a PMT section that spans several packets', () => {
        const writer = new SyntheticTsWriter({ extraStreams: 6 });
        const packets = packetsOf(writer.pmt());
        const assembler = new PsiSectionAssembler();
        let section: Buffer | null = null;

        expect(packets.length).toBeGreaterThan(1);
        for (const packet of packets) {
            section = assembler.push(packet, headerOf(packet)) ?? section;
        }

        const map = section && parsePmtSection(section);
        expect(map?.streams).toHaveLength(8);
        expect(map?.streams[7]).toMatchObject({ pid: 0x205, kind: 'other' });
    });
});

describe('PES timestamps', () => {
    it('round-trips timestamps up to the 33-bit limit', () => {
        for (const value of [0, 1, 90000, 2 ** 32 + 12345, 2 ** 33 - 1]) {
            const buffer = Buffer.from([0x20, 0, 0, 0, 0]);
            writePesTimestamp(buffer, 0, value);
            expect(readPesTimestamp(buffer, 0)).toBe(value);
            expect(buffer[0] & 0xf0).toBe(0x20);
        }
    });

    it('reads PTS and DTS and locates the elementary data', () => {
        const writer = new SyntheticTsWriter();
        const [withDts] = packetsOf(writer.video(183600, { dts: 180000 }));
        const [ptsOnly] = packetsOf(writer.audio(183600));

        expect(readPesTimestamps(withDts, headerOf(withDts))).toEqual({
            pts: 183600,
            dts: 180000,
            ptsOffset: 13,
            dataOffset: 23,
        });
        expect(readPesTimestamps(ptsOnly, headerOf(ptsOnly))).toMatchObject({
            pts: 183600,
            dts: undefined,
        });
    });

    it('returns null for a packet that does not start a PES', () => {
        const writer = new SyntheticTsWriter();
        const [, continuation] = packetsOf(writer.video(0, { size: 400 }));

        expect(
            readPesTimestamps(continuation, headerOf(continuation))
        ).toBeNull();
    });

    it('detects keyframes from NAL units and from the adaptation flag', () => {
        const writer = new SyntheticTsWriter();
        const isKeyframe = (frame: Buffer) => {
            const [packet] = packetsOf(frame);
            const header = headerOf(packet);
            const pes = readPesTimestamps(packet, header);
            return (
                pes !== null &&
                isKeyframeStart(packet, header, 'h264', pes.dataOffset)
            );
        };

        expect(isKeyframe(writer.video(0, { keyframe: true }))).toBe(true);
        expect(
            isKeyframe(
                writer.video(0, { keyframe: true, randomAccessFlag: true })
            )
        ).toBe(true);
        expect(isKeyframe(writer.video(3600))).toBe(false);
    });
});
