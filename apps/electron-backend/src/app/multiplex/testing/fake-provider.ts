/**
 * An in-process stand-in for an IPTV server that allows one connection.
 *
 * Each channel is an endless stream whose live edge follows the clock. A new
 * connection bursts the last `depthSec` of content at `burstSpeed` times real
 * time and then paces at real time — the behaviour connection multiplexing
 * depends on. The provider records how many connections were open at once,
 * and refuses a second one like a real single-connection account would.
 *
 * It runs on an accelerated clock so a minute of rotation takes a few
 * seconds of test time.
 */

import { PassThrough } from 'node:stream';
import {
    MultiplexClock,
    OpenUpstream,
    UpstreamHandle,
} from '../scheduler/scheduler-types';
import { buildChannelSlice, SyntheticTsWriter } from './synthetic-ts';

const FPS = 25;
/** Channels are spaced far apart so their content never coincides. */
const CHANNEL_FRAME_SPACING = 10_000_000;
const ON_AIR_SEC = 1000;

export interface FakeProviderOptions {
    readonly speed?: number;
    readonly depthSec?: number;
    readonly burstSpeed?: number;
    readonly connectMs?: number;
    /** Refuse this many opens (HTTP 403) before accepting. */
    readonly refuseFirst?: number;
}

export interface FakeProvider {
    readonly clock: MultiplexClock;
    readonly open: OpenUpstream;
    stats(): { opens: number; refused: number; openNow: number; peak: number };
}

export function createFakeProvider(
    options: FakeProviderOptions = {}
): FakeProvider {
    const speed = options.speed ?? 20;
    const depthSec = options.depthSec ?? 20;
    const burstSpeed = options.burstSpeed ?? 12;
    const connectMs = options.connectMs ?? 600;
    const origin = performance.now();

    const clock: MultiplexClock = {
        now: () => (performance.now() - origin) * speed,
        sleep: (ms) =>
            new Promise((resolve) => setTimeout(resolve, Math.max(0, ms) / speed)),
    };

    let opens = 0;
    let refused = 0;
    let openNow = 0;
    let peak = 0;

    const open: OpenUpstream = async (source, signal) => {
        await clock.sleep(connectMs);
        opens += 1;

        if (openNow > 0 || opens <= (options.refuseFirst ?? 0)) {
            refused += 1;
            return { status: 403, stream: null, close: async () => undefined };
        }

        openNow += 1;
        peak = Math.max(peak, openNow);
        const stream = new PassThrough();
        let closed = false;
        const close = async () => {
            if (closed) {
                return;
            }
            closed = true;
            stream.removeAllListeners('data');
            stream.destroy();
            // The server only frees the slot a moment after the socket closes.
            await clock.sleep(50);
            openNow -= 1;
        };
        signal.addEventListener('abort', () => stream.destroy());

        void feed(stream, channelOf(source.url), () => closed);
        const handle: UpstreamHandle = { status: 200, stream, close };
        return handle;
    };

    async function feed(
        stream: PassThrough,
        channel: number,
        isClosed: () => boolean
    ): Promise<void> {
        const writer = new SyntheticTsWriter();
        const base = channel * CHANNEL_FRAME_SPACING;
        // The channel has been on air for a while, so there is history
        // to burst from the first connection on.
        const liveFrame = () =>
            Math.floor((clock.now() / 1000 + ON_AIR_SEC) * FPS);
        const openedAt = clock.now();
        // Start on a keyframe, like a server cutting on segment boundaries.
        let next = Math.max(0, liveFrame() - depthSec * FPS);
        next -= next % FPS;
        const burstStart = next;

        stream.write(writer.psi());
        while (!isClosed() && !stream.destroyed) {
            // The burst releases frames faster than real time until it
            // catches the live edge; after that the edge sets the pace.
            const released =
                burstStart +
                Math.floor(((clock.now() - openedAt) / 1000) * FPS * burstSpeed);
            const until = Math.min(liveFrame(), released);
            if (until > next) {
                const frames = buildChannelSlice(writer, {
                    fromFrame: base + next,
                    frames: until - next,
                });
                stream.write(Buffer.concat(frames));
                next = until;
            }
            await clock.sleep(40);
        }
    }

    return {
        clock,
        open,
        stats: () => ({ opens, refused, openNow, peak }),
    };
}

function channelOf(url: string): number {
    const match = /(\d+)\.ts$/.exec(url);
    return match ? Number(match[1]) : 0;
}
