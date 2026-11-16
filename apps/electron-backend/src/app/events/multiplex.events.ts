/**
 * IPC for connection multiplexing (multiview tiles sharing one connection).
 *
 * A session is bound to the window that opened it and is closed when that
 * window goes away or reloads, so a crashed or navigated renderer can never
 * leave a provider connection open behind it.
 */

import { ipcMain, WebContents } from 'electron';
import {
    MULTIPLEX_CLOSE_SESSION,
    MULTIPLEX_OPEN_SESSION,
    MULTIPLEX_REMOVE_TILE,
    MULTIPLEX_SET_TILE,
    MULTIPLEX_STATUS,
    MULTIPLEX_TILE_PROGRESS,
    MultiplexTileProgress,
    MultiplexTileSource,
} from '@iptvnator/shared/interfaces';
import { MultiplexManager } from '../multiplex/multiplex-manager';
import { openTileUpstream } from '../multiplex/scheduler/upstream-connection';

const TILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TILES_PER_REPORT = 16;

const owners = new Map<string, WebContents>();
const watched = new WeakSet<WebContents>();
let manager: MultiplexManager | null = null;

function getManager(): MultiplexManager {
    manager ??= new MultiplexManager({
        open: openTileUpstream,
        onStatus: (status) => {
            const owner = owners.get(status.sessionId);
            if (owner && !owner.isDestroyed()) {
                owner.send(MULTIPLEX_STATUS, status);
            }
        },
    });
    return manager;
}

function closeSessionsOf(sender: WebContents): void {
    for (const [sessionId, owner] of owners) {
        if (owner === sender) {
            owners.delete(sessionId);
            void manager?.closeSession(sessionId);
        }
    }
}

function watchSender(sender: WebContents): void {
    if (watched.has(sender)) {
        return;
    }
    watched.add(sender);
    const close = () => closeSessionsOf(sender);
    sender.once('destroyed', close);
    sender.on('render-process-gone', close);
    // A reload starts a new document; in-app route changes do not fire this.
    sender.on('did-navigate', close);
}

function ownsSession(sender: WebContents, sessionId: unknown): boolean {
    return typeof sessionId === 'string' && owners.get(sessionId) === sender;
}

function parseSource(value: unknown): MultiplexTileSource {
    const source = value as Partial<MultiplexTileSource> | null;
    const optional = (text: unknown) =>
        typeof text === 'string' && text.trim() ? text.trim() : undefined;

    let protocol = '';
    try {
        protocol = new URL(String(source?.url)).protocol;
    } catch {
        // Reported below without echoing the value.
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
        throw new Error('Multiplex tile needs an http(s) stream URL');
    }
    const groupKey = optional(source?.groupKey);
    if (!groupKey || groupKey.length > 200) {
        throw new Error('Multiplex tile needs a group key');
    }
    return {
        url: String(source?.url),
        groupKey,
        userAgent: optional(source?.userAgent),
        referer: optional(source?.referer),
        origin: optional(source?.origin),
    };
}

export function registerMultiplexHandlers(): void {
    ipcMain.handle(MULTIPLEX_OPEN_SESSION, (event) => {
        const session = getManager().openSession();
        owners.set(session.sessionId, event.sender);
        watchSender(event.sender);
        return session;
    });

    ipcMain.handle(
        MULTIPLEX_SET_TILE,
        async (event, sessionId: unknown, tileId: unknown, source: unknown) => {
            if (
                !ownsSession(event.sender, sessionId) ||
                typeof tileId !== 'string' ||
                !TILE_ID_PATTERN.test(tileId)
            ) {
                throw new Error('Invalid multiplex tile request');
            }
            return getManager().setTile(
                sessionId as string,
                tileId,
                parseSource(source)
            );
        }
    );

    ipcMain.handle(
        MULTIPLEX_REMOVE_TILE,
        (event, sessionId: unknown, tileId: unknown) => {
            if (ownsSession(event.sender, sessionId) && typeof tileId === 'string') {
                manager?.removeTile(sessionId as string, tileId);
            }
        }
    );

    ipcMain.handle(MULTIPLEX_CLOSE_SESSION, async (event, sessionId: unknown) => {
        if (ownsSession(event.sender, sessionId)) {
            owners.delete(sessionId as string);
            await manager?.closeSession(sessionId as string);
        }
    });

    ipcMain.on(
        MULTIPLEX_TILE_PROGRESS,
        (event, sessionId: unknown, reports: unknown) => {
            if (!ownsSession(event.sender, sessionId) || !Array.isArray(reports)) {
                return;
            }
            const valid = reports
                .slice(0, MAX_TILES_PER_REPORT)
                .filter(isProgress);
            manager?.reportProgress(sessionId as string, valid);
        }
    );
}

function isProgress(value: unknown): value is MultiplexTileProgress {
    const report = value as Partial<MultiplexTileProgress> | null;
    return (
        typeof report?.tileId === 'string' &&
        Number.isFinite(report.bufferedAheadSec) &&
        typeof report.playing === 'boolean' &&
        typeof report.focused === 'boolean'
    );
}

/** Closes every shared connection; safe when none was ever opened. */
export function shutdownMultiplex(): void {
    owners.clear();
    void manager?.shutdown();
    manager = null;
}
