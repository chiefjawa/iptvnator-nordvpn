/**
 * Measures one visit: how much media arrived and how fast it is arriving now.
 *
 * Media time is only known keyframe by keyframe, which is too coarse to see
 * the moment a burst ends. Bytes arrive continuously, so the recent delivery
 * rate is taken from bytes and converted to media time with the visit's own
 * average bytes per media second.
 */

import { MultiplexClock } from './scheduler-types';
import { VisitStats } from './visit-policy';

/** This many bytes without a single whole segment means nothing to cut on. */
const UNSUPPORTED_AFTER_BYTES = 12 * 1024 * 1024;

interface ByteSample {
    readonly atMs: number;
    readonly bytes: number;
}

export class VisitMeter {
    private readonly startedAtMs: number;
    private readonly samples: ByteSample[] = [];
    private bytes = 0;
    private receivedMs = 0;
    private forwardedMs = 0;

    constructor(
        private readonly clock: MultiplexClock,
        private readonly windowMs: number
    ) {
        this.startedAtMs = clock.now();
        this.samples.push({ atMs: this.startedAtMs, bytes: 0 });
    }

    get receivedMediaMs(): number {
        return this.receivedMs;
    }

    note(bytes: number, receivedMs: number, forwardedMs: number): void {
        this.bytes += bytes;
        this.receivedMs += receivedMs;
        this.forwardedMs += forwardedMs;
        this.samples.push({ atMs: this.clock.now(), bytes: this.bytes });
    }

    looksUnsupported(): boolean {
        return this.receivedMs === 0 && this.bytes > UNSUPPORTED_AFTER_BYTES;
    }

    stats(reserveSec: number): VisitStats {
        return {
            reserveSec,
            ageMs: this.clock.now() - this.startedAtMs,
            newMediaMs: this.forwardedMs,
            recentRate: this.recentRate(),
        };
    }

    /** Media per wall time over the last window; null until measurable. */
    private recentRate(): number | null {
        const now = this.clock.now();
        const windowStart = now - this.windowMs;
        if (this.receivedMs === 0 || this.startedAtMs > windowStart) {
            return null;
        }

        // Keep one sample at or before the window start as the baseline.
        while (
            this.samples.length > 1 &&
            this.samples[1].atMs <= windowStart
        ) {
            this.samples.shift();
        }
        const baseline = this.samples[0];
        const bytesPerMediaMs = this.bytes / this.receivedMs;
        const mediaMs = (this.bytes - baseline.bytes) / bytesPerMediaMs;
        return mediaMs / (now - baseline.atMs);
    }
}
