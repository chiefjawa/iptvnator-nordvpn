/**
 * Test doubles for the LAN relay: a client socket that records and checks
 * what it receives, and a relay wired to the fake provider.
 */

import {
    SYNTHETIC_AUDIO_PID,
    SYNTHETIC_PMT_PID,
    SYNTHETIC_VIDEO_PID,
} from '../testing/synthetic-ts';
import {
    createFakeProvider,
    FakeProvider,
    FakeProviderOptions,
} from '../testing/fake-provider';
import { MultiplexClock } from '../scheduler/scheduler-types';
import {
    parseTsPacket,
    timestampDelta,
    TS_PACKET_SIZE,
    TS_PID_NULL,
    TS_PID_PAT,
} from '../ts/ts-packet';
import { isKeyframeStart, readPesTimestamps } from '../ts/ts-pes';
import { LanRelay } from './lan-relay';
import {
    DEFAULT_RELAY_TUNING,
    parseRelayConfig,
    RelayConfig,
    RelayTuning,
} from './relay-config';
import { ClientOutput } from './relay-client';
import { RelayLogger } from './relay-log';

const FRAME_TICKS = 3600;
export const FRAME_MS = 40;

/** Reads a client's byte stream packet by packet and checks it. */
export class StreamChecker {
    packets = 0;
    nullPackets = 0;
    ccErrors = 0;
    ptsErrors = 0;
    videoFrames = 0;
    /** PAT, PMT, then a video keyframe before any other media. */
    startsClean: boolean | null = null;
    /** Index (in media packets) of every PAT seen. */
    readonly patAt: number[] = [];
    private mediaPackets = 0;
    private readonly cc = new Map<number, number>();
    private readonly lastPts = new Map<number, number>();
    private leading: number[] = [];

    push(data: Buffer): void {
        expectWholePackets(data);
        for (let offset = 0; offset < data.length; offset += TS_PACKET_SIZE) {
            this.packet(data.subarray(offset, offset + TS_PACKET_SIZE));
        }
    }

    /** Media time received, by video frame count. */
    get mediaMs(): number {
        return this.videoFrames * FRAME_MS;
    }

    private packet(packet: Buffer): void {
        const header = parseTsPacket(packet);
        if (!header) {
            this.ccErrors += 1;
            return;
        }
        this.packets += 1;
        if (header.pid === TS_PID_NULL) {
            this.nullPackets += 1;
            return;
        }
        if (header.pid === TS_PID_PAT) {
            this.patAt.push(this.mediaPackets);
        }
        this.mediaPackets += 1;
        this.checkStart(packet, header);

        if ((packet[3] & 0x10) !== 0) {
            const previous = this.cc.get(header.pid);
            if (
                previous !== undefined &&
                header.continuityCounter !== ((previous + 1) & 0x0f)
            ) {
                this.ccErrors += 1;
            }
            this.cc.set(header.pid, header.continuityCounter);
        }

        const media =
            header.pid === SYNTHETIC_VIDEO_PID ||
            header.pid === SYNTHETIC_AUDIO_PID;
        const pes =
            media && header.payloadUnitStart
                ? readPesTimestamps(packet, header)
                : null;
        if (!pes) {
            return;
        }
        const previous = this.lastPts.get(header.pid);
        if (
            previous !== undefined &&
            timestampDelta(pes.pts, previous) !== FRAME_TICKS
        ) {
            this.ptsErrors += 1;
        }
        this.lastPts.set(header.pid, pes.pts);
        if (header.pid === SYNTHETIC_VIDEO_PID) {
            this.videoFrames += 1;
        }
    }

    private checkStart(
        packet: Buffer,
        header: NonNullable<ReturnType<typeof parseTsPacket>>
    ): void {
        if (this.startsClean !== null) {
            return;
        }
        this.leading.push(header.pid);
        if (this.leading.length === 1 && header.pid !== TS_PID_PAT) {
            this.startsClean = false;
        } else if (
            this.leading.length === 2 &&
            header.pid !== SYNTHETIC_PMT_PID
        ) {
            this.startsClean = false;
        } else if (this.leading.length === 3) {
            const pes =
                header.pid === SYNTHETIC_VIDEO_PID
                    ? readPesTimestamps(packet, header)
                    : null;
            this.startsClean =
                pes !== null &&
                isKeyframeStart(packet, header, 'h264', pes.dataOffset);
        }
    }
}

function expectWholePackets(data: Buffer): void {
    if (data.length % TS_PACKET_SIZE !== 0) {
        throw new Error('relay wrote a partial packet');
    }
}

export interface WriteSample {
    readonly atMs: number;
    readonly mediaMs: number;
}

/** A client socket on the test clock. */
export class RecordingOutput implements ClientOutput {
    readonly checker = new StreamChecker();
    readonly writes: WriteSample[] = [];
    blocked = false;
    closed = false;
    private drain: (() => void)[] = [];

    constructor(
        private readonly clock: MultiplexClock,
        readonly connectedAtMs = clock.now()
    ) {}

    write(data: Buffer): boolean {
        if (this.closed) {
            return true;
        }
        this.checker.push(data);
        this.writes.push({
            atMs: this.clock.now(),
            mediaMs: this.checker.mediaMs,
        });
        return !this.blocked;
    }

    onDrain(listener: () => void): void {
        this.drain.push(listener);
    }

    unblock(): void {
        this.blocked = false;
        const listeners = this.drain;
        this.drain = [];
        listeners.forEach((listener) => listener());
    }

    close(): void {
        this.closed = true;
    }

    /** Longest time without a write, from connecting to `untilMs`. */
    maxWriteGapMs(untilMs: number): number {
        let previous = this.connectedAtMs;
        let gap = 0;
        for (const sample of this.writes) {
            gap = Math.max(gap, sample.atMs - previous);
            previous = sample.atMs;
        }
        return Math.max(gap, untilMs - previous);
    }

    /** Largest excess of media received over `allowed(elapsed)`. */
    paceExcessMs(
        allowed: (elapsedMs: number, firstMediaMs: number) => number
    ): number {
        const first =
            this.writes.find((sample) => sample.mediaMs > 0)?.atMs ?? 0;
        let excess = Number.NEGATIVE_INFINITY;
        for (const sample of this.writes) {
            excess = Math.max(
                excess,
                sample.mediaMs -
                    allowed(
                        sample.atMs - this.connectedAtMs,
                        sample.atMs - first
                    )
            );
        }
        return excess;
    }
}

export const FAKE_SECRETS = {
    serverUrl: 'http://provider.example.test:8080',
    username: 'relay-user-x7',
    password: 'relay-pass-q9',
    token: 'tokenABCDEFGHIJKLMNOPQRSTUV0123',
};

export function testConfig(
    channels: number[],
    tuning: Partial<RelayTuning> = {}
): RelayConfig {
    const config = parseRelayConfig({
        ...FAKE_SECRETS,
        listen: '127.0.0.1:8790',
        channels: channels.map((streamId) => ({
            streamId,
            name: `Synthetic ${streamId}`,
        })),
    });
    return {
        ...config,
        port: 0,
        tuning: { ...DEFAULT_RELAY_TUNING, ...tuning },
    };
}

/** Behaves like a real deep-burst provider, as in the cold-start specs. */
export const DEEP_BURST: FakeProviderOptions = {
    depthSec: 25,
    burstSpeed: 12,
    connectMs: 1000,
    gopFrames: 50,
    burstFromKeyframeAfter: true,
};

export interface RelayRig {
    readonly provider: FakeProvider;
    readonly relay: LanRelay;
    readonly lines: string[];
    readonly clock: MultiplexClock;
}

export function createRig(
    channels: number[],
    options: {
        speed: number;
        tuning?: Partial<RelayTuning>;
        provider?: FakeProviderOptions;
    }
): RelayRig {
    const provider = createFakeProvider({
        ...DEEP_BURST,
        ...options.provider,
        speed: options.speed,
    });
    const lines: string[] = [];
    const log: RelayLogger = {
        info: (message) => lines.push(message),
        warn: (message) => lines.push(message),
    };
    const relay = new LanRelay({
        config: testConfig(channels, { statusLogSec: 10, ...options.tuning }),
        open: provider.open,
        clock: provider.clock,
        log,
    });
    relay.start();
    return { provider, relay, lines, clock: provider.clock };
}

/** Connects a recording client to a channel. */
export function connect(
    rig: RelayRig,
    streamId: number
): { output: RecordingOutput; leave(): void } {
    const output = new RecordingOutput(rig.clock);
    const client = rig.relay.attach(streamId, output, '192.0.2.10');
    if (!client) {
        throw new Error('channel not configured');
    }
    return { output, leave: () => rig.relay.detach(streamId, client) };
}

/** Waits `ms` on the rig clock, sampling the provider's open count. */
export async function runFor(
    rig: RelayRig,
    ms: number,
    onTick?: () => void
): Promise<void> {
    const until = rig.clock.now() + ms;
    while (rig.clock.now() < until) {
        await rig.clock.sleep(200);
        onTick?.();
    }
}
