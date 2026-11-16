/**
 * Multiview sessions for connection multiplexing.
 *
 * A session belongs to one multiview screen. Each of its tiles gets a relay
 * URL to play, and all tiles with the same group key (the playlist) share a
 * scheduler — and therefore a single connection to the provider.
 */

import { randomUUID } from 'node:crypto';
import {
    MultiplexStatus,
    MultiplexTileProgress,
    MultiplexTileSource,
} from '@iptvnator/shared/interfaces';
import { RelayServer, RelayTile } from './relay/relay-server';
import { GroupScheduler } from './scheduler/group-scheduler';
import {
    MultiplexClock,
    OpenUpstream,
    SchedulerConfig,
    TileStatus,
} from './scheduler/scheduler-types';

interface SessionTile {
    readonly groupKey: string;
    readonly relay: RelayTile;
}

interface Session {
    readonly tiles: Map<string, SessionTile>;
    readonly schedulers: Map<string, GroupScheduler>;
    readonly statuses: Map<string, TileStatus[]>;
    generation: number;
}

export interface MultiplexManagerDeps {
    readonly open: OpenUpstream;
    readonly clock?: MultiplexClock;
    readonly config?: Partial<SchedulerConfig>;
    readonly onStatus?: (status: MultiplexStatus) => void;
}

export class MultiplexManager {
    private readonly relay = new RelayServer();
    private readonly sessions = new Map<string, Session>();

    constructor(private readonly deps: MultiplexManagerDeps) {}

    openSession(): { sessionId: string } {
        const sessionId = randomUUID();
        this.sessions.set(sessionId, {
            tiles: new Map(),
            schedulers: new Map(),
            statuses: new Map(),
            generation: 0,
        });
        return { sessionId };
    }

    /** Adds a tile or switches its channel; returns the URL to play. */
    async setTile(
        sessionId: string,
        tileId: string,
        source: MultiplexTileSource
    ): Promise<{ relayUrl: string }> {
        const session = this.requireSession(sessionId);
        this.dropTile(session, tileId);

        session.generation += 1;
        const relay = await this.relay.createTile(
            `${sessionId}-${tileId}-${session.generation}`
        );
        // The session may have been closed while the relay was starting.
        if (this.sessions.get(sessionId) !== session) {
            relay.dispose();
            throw new Error('Multiplex session closed');
        }

        session.tiles.set(tileId, { groupKey: source.groupKey, relay });
        this.schedulerFor(sessionId, session, source.groupKey).setTile(
            tileId,
            {
                url: source.url,
                userAgent: source.userAgent,
                referer: source.referer,
                origin: source.origin,
            },
            relay.sink
        );
        return { relayUrl: relay.url };
    }

    removeTile(sessionId: string, tileId: string): void {
        const session = this.sessions.get(sessionId);
        if (session) {
            this.dropTile(session, tileId);
        }
    }

    reportProgress(sessionId: string, reports: MultiplexTileProgress[]): void {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return;
        }
        for (const report of reports) {
            const tile = session.tiles.get(report.tileId);
            if (tile) {
                session.schedulers
                    .get(tile.groupKey)
                    ?.reportProgress(report.tileId, report);
            }
        }
    }

    async closeSession(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return;
        }
        this.sessions.delete(sessionId);
        await Promise.all(
            [...session.schedulers.values()].map((scheduler) =>
                scheduler.stop()
            )
        );
        for (const tile of session.tiles.values()) {
            tile.relay.dispose();
        }
    }

    /** Closes every session and the relay; used when the app quits. */
    async shutdown(): Promise<void> {
        await Promise.all(
            [...this.sessions.keys()].map((id) => this.closeSession(id))
        );
        await this.relay.stop();
    }

    private requireSession(sessionId: string): Session {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error('Unknown multiplex session');
        }
        return session;
    }

    private dropTile(session: Session, tileId: string): void {
        const tile = session.tiles.get(tileId);
        if (!tile) {
            return;
        }
        session.schedulers.get(tile.groupKey)?.removeTile(tileId);
        tile.relay.dispose();
        session.tiles.delete(tileId);
    }

    private schedulerFor(
        sessionId: string,
        session: Session,
        groupKey: string
    ): GroupScheduler {
        let scheduler = session.schedulers.get(groupKey);
        if (!scheduler) {
            scheduler = new GroupScheduler({
                open: this.deps.open,
                clock: this.deps.clock,
                config: this.deps.config,
                onStatus: (tiles) => {
                    session.statuses.set(groupKey, tiles);
                    this.deps.onStatus?.({
                        sessionId,
                        tiles: [...session.statuses.values()].flat(),
                    });
                },
            });
            session.schedulers.set(groupKey, scheduler);
        }
        return scheduler;
    }
}
