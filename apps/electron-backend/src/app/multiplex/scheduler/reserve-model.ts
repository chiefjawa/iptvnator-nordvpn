/**
 * Tracks how much unplayed media a tile holds.
 *
 * The player's own report is the authority. Between reports the reserve is
 * extrapolated: it grows by what was forwarded and shrinks as the tile plays.
 * Without a recent report (the renderer is busy, or has not started yet) the
 * estimate falls back to media forwarded minus wall time since playback could
 * have begun.
 */

import { TileProgress } from './scheduler-types';

const REPORT_STALE_MS = 3000;
/** Time a player needs before the first frame once data arrives. */
const STARTUP_MS = 500;

export class TileReserve {
    private report: (TileProgress & { atMs: number }) | null = null;
    private forwardedSinceReportMs = 0;
    private forwardedTotalMs = 0;
    private firstForwardAtMs: number | null = null;
    private peakSec = 0;

    /** False until any media has been forwarded: the tile shows nothing. */
    get started(): boolean {
        return this.firstForwardAtMs !== null;
    }

    get focused(): boolean {
        return this.report?.focused ?? false;
    }

    /** The largest reserve this tile has held: its full level. */
    get fullSec(): number {
        return this.peakSec;
    }

    noteForwarded(mediaMs: number, nowMs: number): void {
        if (mediaMs <= 0) {
            return;
        }
        this.firstForwardAtMs ??= nowMs;
        this.forwardedSinceReportMs += mediaMs;
        this.forwardedTotalMs += mediaMs;
        this.peakSec = Math.max(this.peakSec, this.reserveSec(nowMs));
    }

    noteReport(progress: TileProgress, nowMs: number): void {
        this.report = { ...progress, atMs: nowMs };
        this.forwardedSinceReportMs = 0;
    }

    /** Seconds of unplayed media; -Infinity for a tile that has none yet. */
    reserveSec(nowMs: number): number {
        if (this.firstForwardAtMs === null) {
            return Number.NEGATIVE_INFINITY;
        }

        const report = this.report;
        if (report && nowMs - report.atMs <= REPORT_STALE_MS) {
            const playedMs = report.playing ? nowMs - report.atMs : 0;
            return Math.max(
                0,
                report.bufferedAheadSec +
                    (this.forwardedSinceReportMs - playedMs) / 1000
            );
        }

        const playedMs = Math.max(
            0,
            nowMs - this.firstForwardAtMs - STARTUP_MS
        );
        return Math.max(0, (this.forwardedTotalMs - playedMs) / 1000);
    }
}
