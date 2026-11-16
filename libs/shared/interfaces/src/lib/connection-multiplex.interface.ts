/**
 * Connection multiplexing: several live tiles of a multiview share one
 * connection to the provider, taking turns on it. The main process owns the
 * connection and hands each tile a local relay URL to play.
 */

export const MULTIPLEX_OPEN_SESSION = 'MULTIPLEX:OPEN_SESSION';
export const MULTIPLEX_SET_TILE = 'MULTIPLEX:SET_TILE';
export const MULTIPLEX_REMOVE_TILE = 'MULTIPLEX:REMOVE_TILE';
export const MULTIPLEX_CLOSE_SESSION = 'MULTIPLEX:CLOSE_SESSION';
export const MULTIPLEX_TILE_PROGRESS = 'MULTIPLEX:TILE_PROGRESS';
export const MULTIPLEX_STATUS = 'MULTIPLEX:STATUS';

export interface MultiplexTileSource {
    /** The channel's direct MPEG-TS URL. */
    url: string;
    /** Tiles with the same key share one connection (the playlist id). */
    groupKey: string;
    userAgent?: string;
    referer?: string;
    origin?: string;
}

export interface MultiplexTileProgress {
    tileId: string;
    /** Seconds buffered ahead of the playhead. */
    bufferedAheadSec: number;
    playing: boolean;
    /** The tile the viewer is listening to. */
    focused: boolean;
}

export type MultiplexTileState =
    | 'connecting'
    | 'filling'
    | 'waiting'
    | 'starved'
    | 'error'
    | 'unsupported';

export interface MultiplexTileStatus {
    tileId: string;
    state: MultiplexTileState;
    reserveSec: number;
    /** Buffer a tile that ran dry should rebuild before it resumes. */
    resumeThresholdSec: number;
    /** Media skipped on the latest visit because it was missed. */
    skippedMs: number;
    httpStatus?: number;
}

export interface MultiplexStatus {
    sessionId: string;
    tiles: MultiplexTileStatus[];
}

export interface MultiplexBridgeApi {
    multiplexOpenSession: () => Promise<{ sessionId: string }>;
    multiplexSetTile: (
        sessionId: string,
        tileId: string,
        source: MultiplexTileSource
    ) => Promise<{ relayUrl: string }>;
    multiplexRemoveTile: (sessionId: string, tileId: string) => Promise<void>;
    multiplexCloseSession: (sessionId: string) => Promise<void>;
    multiplexReportProgress: (
        sessionId: string,
        reports: MultiplexTileProgress[]
    ) => void;
    onMultiplexStatus: (
        callback: (status: MultiplexStatus) => void
    ) => () => void;
}
