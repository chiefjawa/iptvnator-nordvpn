import {
    MULTIPLEX_CLOSE_SESSION,
    MULTIPLEX_OPEN_SESSION,
    MULTIPLEX_REMOVE_TILE,
    MULTIPLEX_SET_TILE,
    MULTIPLEX_STATUS,
    MULTIPLEX_TILE_PROGRESS,
} from '@iptvnator/shared/interfaces';
import type {
    MultiplexBridgeApi,
    MultiplexStatus,
} from '@iptvnator/shared/interfaces';

/** Renderer bridge for connection multiplexing (multiview tiles). */
export function createMultiplexApi(
    ipc: Pick<Electron.IpcRenderer, 'invoke' | 'send' | 'on' | 'off'>
): MultiplexBridgeApi {
    return {
        multiplexOpenSession: () => ipc.invoke(MULTIPLEX_OPEN_SESSION),
        multiplexSetTile: (sessionId, tileId, source) =>
            ipc.invoke(MULTIPLEX_SET_TILE, sessionId, tileId, source),
        multiplexRemoveTile: (sessionId, tileId) =>
            ipc.invoke(MULTIPLEX_REMOVE_TILE, sessionId, tileId),
        multiplexCloseSession: (sessionId) =>
            ipc.invoke(MULTIPLEX_CLOSE_SESSION, sessionId),
        multiplexReportProgress: (sessionId, reports) =>
            ipc.send(MULTIPLEX_TILE_PROGRESS, sessionId, reports),
        onMultiplexStatus: (callback) => {
            const handler = (_event: unknown, status: MultiplexStatus) =>
                callback(status);
            ipc.on(MULTIPLEX_STATUS, handler);
            return () => ipc.off(MULTIPLEX_STATUS, handler);
        },
    };
}
