/**
 * Shared contracts of the connection-sharing scheduler.
 */

import { Readable } from 'node:stream';

/** Time source, injectable so tests can run the rotation at high speed. */
export interface MultiplexClock {
    now(): number;
    sleep(ms: number): Promise<void>;
}

export const systemClock: MultiplexClock = {
    now: () => performance.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** What to request for a tile. The URL never leaves the main process. */
export interface TileSource {
    readonly url: string;
    readonly userAgent?: string | null;
    readonly referer?: string | null;
    readonly origin?: string | null;
}

export interface UpstreamHandle {
    /** HTTP status; 0 when no response was obtained. */
    readonly status: number;
    /** The response body; null unless the status is 2xx. */
    readonly stream: Readable | null;
    /** Resolves once the connection is really closed. */
    close(): Promise<void>;
}

export type OpenUpstream = (
    source: TileSource,
    signal: AbortSignal
) => Promise<UpstreamHandle>;

/** Where a tile's stitched stream goes (the relay response). */
export interface TileSink {
    /** `mediaMs` is the media duration of `packets` (whole segments). */
    write(packets: Buffer[], mediaMs?: number): void;
}

export interface TileProgress {
    /** Seconds buffered ahead of the playhead. */
    readonly bufferedAheadSec: number;
    readonly playing: boolean;
    /** The tile the viewer is listening to. */
    readonly focused: boolean;
}

export type TileState =
    /** Its connection is being opened. */
    | 'connecting'
    /** It holds the connection and is receiving. */
    | 'filling'
    /** It is playing from its reserve while another tile is served. */
    | 'waiting'
    /** Its reserve ran out before its turn came. */
    | 'starved'
    /** The server refused or dropped its last connection. */
    | 'error'
    /** The stream has no video the stitcher can cut on. */
    | 'unsupported';

export interface TileStatus {
    readonly tileId: string;
    readonly state: TileState;
    readonly reserveSec: number;
    /** Buffer a starved tile should rebuild before it resumes playing. */
    readonly resumeThresholdSec: number;
    /** Media skipped on the most recent visit, when content was missed. */
    readonly skippedMs: number;
    /** HTTP status of the last failed open, for `error`. */
    readonly httpStatus?: number;
}

export interface SchedulerConfig {
    /** Pause between closing one connection and opening the next. */
    readonly minGapMs: number;
    /** How often a running visit is re-evaluated. */
    readonly tickMs: number;
    readonly maxVisitMs: number;
    /** Media per wall time below which delivery counts as real time. */
    readonly realtimeRate: number;
    readonly rateWindowMs: number;
    /** A visit is not cut short before it forwarded this much. */
    readonly minNewMediaMs: number;
    /** Reserve below which a tile may interrupt a burst. */
    readonly criticalSec: number;
    readonly focusedCriticalSec: number;
    /**
     * A tile with nothing to show yet interrupts a burst only once the visit
     * is this old; until then the visit runs to the live edge.
     */
    readonly coldPreemptAfterMs: number;
    /** A tile asks for a visit below this share of its full reserve. */
    readonly lowWaterFraction: number;
    readonly lowWaterFloorSec: number;
    readonly backoffBaseMs: number;
    readonly backoffMaxMs: number;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
    minGapMs: 300,
    tickMs: 250,
    maxVisitMs: 20000,
    realtimeRate: 1.5,
    rateWindowMs: 750,
    minNewMediaMs: 12000,
    criticalSec: 3,
    focusedCriticalSec: 6,
    coldPreemptAfterMs: 6000,
    lowWaterFraction: 0.5,
    lowWaterFloorSec: 6,
    backoffBaseMs: 500,
    backoffMaxMs: 8000,
};
