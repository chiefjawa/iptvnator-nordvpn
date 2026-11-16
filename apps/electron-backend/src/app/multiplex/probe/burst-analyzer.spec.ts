import { buildChannelSlice, SyntheticTsWriter } from '../testing/synthetic-ts';
import { BurstAnalyzer, compareReopen } from './burst-analyzer';

const FPS = 25;

/**
 * Feeds one connection: `burstSec` of media within `burstWallMs`, then
 * `realtimeSec` more at one media second per wall second.
 */
function simulateConnection(options: {
    fromSec: number;
    burstSec: number;
    burstWallMs: number;
    realtimeSec: number;
    ptsOffset?: number;
}): BurstAnalyzer {
    const writer = new SyntheticTsWriter();
    const analyzer = new BurstAnalyzer();
    const burstFrames = options.burstSec * FPS;
    const frames = buildChannelSlice(writer, {
        fromFrame: options.fromSec * FPS,
        frames: burstFrames + options.realtimeSec * FPS,
        ptsOffset: options.ptsOffset,
    });

    analyzer.push(writer.psi(), 0);
    frames.forEach((frame, index) => {
        const atMs =
            index < burstFrames
                ? (index / burstFrames) * options.burstWallMs
                : options.burstWallMs + ((index - burstFrames) / FPS) * 1000;
        analyzer.push(frame, atMs);
    });
    return analyzer;
}

describe('BurstAnalyzer', () => {
    it('measures the depth and speed of an opening burst', () => {
        const summary = simulateConnection({
            fromSec: 0,
            burstSec: 20,
            burstWallMs: 2000,
            realtimeSec: 6,
        }).summarize();

        expect(summary.burstMediaSec).toBeGreaterThan(18);
        expect(summary.burstMediaSec).toBeLessThan(21.5);
        expect(summary.realtimeAfterMs).toBeGreaterThanOrEqual(1500);
        expect(summary.realtimeAfterMs).toBeLessThanOrEqual(2500);
        expect(summary.mediaSec).toBeCloseTo(26, 0);
        expect(summary.gopSec).toBe(1);
        expect(summary.videoCodec).toBe('h264');
        expect(summary.audioCodec).toBe('aac');
        expect(summary.burstMbit).toBeGreaterThan(summary.mediaBitrateMbit);
    });

    it('reports almost no burst for a server that paces from the start', () => {
        const summary = simulateConnection({
            fromSec: 0,
            burstSec: 0,
            burstWallMs: 0,
            realtimeSec: 8,
        }).summarize();

        expect(summary.burstMediaSec).toBeLessThan(1);
        expect(summary.realtimeAfterMs).toBeLessThan(500);
    });

    it('leaves the settle time open when closed mid-burst', () => {
        const summary = simulateConnection({
            fromSec: 0,
            burstSec: 20,
            burstWallMs: 2000,
            realtimeSec: 0,
        }).summarize();

        expect(summary.realtimeAfterMs).toBeNull();
        expect(summary.burstMediaSec).toBeGreaterThan(18);
    });

    it('settles only after real-time pacing has lasted long enough', () => {
        const analyzer = simulateConnection({
            fromSec: 0,
            burstSec: 10,
            burstWallMs: 1000,
            realtimeSec: 5,
        });

        expect(analyzer.hasSettled(6000, 3000)).toBe(true);
        expect(analyzer.hasSettled(6000, 10000)).toBe(false);
    });
});

describe('compareReopen', () => {
    const first = () =>
        simulateConnection({
            fromSec: 100,
            burstSec: 20,
            burstWallMs: 2000,
            realtimeSec: 4,
        }).summarize();

    it('measures overlap on a server that keeps one timeline', () => {
        // First connection covered 100-124 s; the reopen starts at 112 s.
        const next = simulateConnection({
            fromSec: 112,
            burstSec: 20,
            burstWallMs: 2000,
            realtimeSec: 2,
        }).summarize();

        const comparison = compareReopen(first(), next, 5);

        expect(comparison.fingerprintMatched).toBe(true);
        expect(comparison.timestampsContinuous).toBe(true);
        expect(comparison.overlapSec).toBeCloseTo(12, 0);
    });

    it('lines up by content when the server restarts its timestamps', () => {
        const next = simulateConnection({
            fromSec: 112,
            burstSec: 20,
            burstWallMs: 2000,
            realtimeSec: 2,
            ptsOffset: -112 * 90000,
        }).summarize();

        const comparison = compareReopen(first(), next, 5);

        expect(comparison.fingerprintMatched).toBe(true);
        expect(comparison.timestampsContinuous).toBe(false);
        expect(comparison.overlapSec).toBeCloseTo(12, 0);
    });

    it('reports a gap as negative overlap when content was missed', () => {
        // Nothing shared: the reopen starts 6 s after the first one ended.
        const next = simulateConnection({
            fromSec: 130,
            burstSec: 10,
            burstWallMs: 1000,
            realtimeSec: 2,
        }).summarize();

        const comparison = compareReopen(first(), next, 20);

        expect(comparison.fingerprintMatched).toBe(false);
        expect(comparison.timestampsContinuous).toBe(true);
        expect(comparison.overlapSec).toBeCloseTo(-6, 0);
    });

    it('makes no claim when neither content nor timestamps line up', () => {
        const next = simulateConnection({
            fromSec: 5000,
            burstSec: 10,
            burstWallMs: 1000,
            realtimeSec: 2,
        }).summarize();

        expect(compareReopen(first(), next, 5)).toEqual({
            overlapSec: 0,
            timestampsContinuous: false,
            fingerprintMatched: false,
        });
    });
});
