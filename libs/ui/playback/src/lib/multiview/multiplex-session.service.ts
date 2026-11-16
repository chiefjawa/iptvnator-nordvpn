import { Injectable, OnDestroy, signal } from '@angular/core';
import {
    MultiplexBridgeApi,
    MultiplexTileProgress,
    MultiplexTileSource,
    MultiplexTileStatus,
} from '@iptvnator/shared/interfaces';

const BRIDGE_METHODS: (keyof MultiplexBridgeApi)[] = [
    'multiplexOpenSession',
    'multiplexSetTile',
    'multiplexRemoveTile',
    'multiplexCloseSession',
    'multiplexReportProgress',
    'onMultiplexStatus',
];

function readBridge(): MultiplexBridgeApi | null {
    const bridge = (window as Window & { electron?: Partial<MultiplexBridgeApi> })
        .electron;
    return bridge &&
        BRIDGE_METHODS.every((name) => typeof bridge[name] === 'function')
        ? (bridge as MultiplexBridgeApi)
        : null;
}

/**
 * One multiview's connection-sharing session with the main process.
 *
 * Provide it on the multiview component: the session is opened on first use
 * and closed with the component, which releases the provider connection.
 */
@Injectable()
export class MultiplexSessionService implements OnDestroy {
    private readonly bridge = readBridge();
    private sessionId: Promise<string> | null = null;
    private stopListening: (() => void) | null = null;
    private closed = false;

    /** Scheduler state per tile id. */
    readonly statuses = signal<ReadonlyMap<string, MultiplexTileStatus>>(
        new Map()
    );

    /** False in the browser build or with an older desktop shell. */
    get available(): boolean {
        return this.bridge !== null;
    }

    /** Registers a tile's channel; resolves with the local URL to play. */
    async setTile(tileId: string, source: MultiplexTileSource): Promise<string> {
        const bridge = this.requireBridge();
        const sessionId = await this.open(bridge);
        const { relayUrl } = await bridge.multiplexSetTile(
            sessionId,
            tileId,
            source
        );
        return relayUrl;
    }

    async removeTile(tileId: string): Promise<void> {
        if (!this.bridge || !this.sessionId) {
            return;
        }
        await this.bridge.multiplexRemoveTile(await this.sessionId, tileId);
        this.statuses.update((statuses) => {
            const next = new Map(statuses);
            next.delete(tileId);
            return next;
        });
    }

    reportProgress(reports: MultiplexTileProgress[]): void {
        if (!this.bridge || !this.sessionId || reports.length === 0) {
            return;
        }
        const bridge = this.bridge;
        void this.sessionId.then((sessionId) => {
            if (!this.closed) {
                bridge.multiplexReportProgress(sessionId, reports);
            }
        });
    }

    ngOnDestroy(): void {
        this.closed = true;
        this.stopListening?.();
        const bridge = this.bridge;
        if (bridge && this.sessionId) {
            void this.sessionId
                .then((sessionId) => bridge.multiplexCloseSession(sessionId))
                .catch(() => undefined);
        }
    }

    private requireBridge(): MultiplexBridgeApi {
        if (!this.bridge) {
            throw new Error('Connection multiplexing is unavailable');
        }
        return this.bridge;
    }

    private open(bridge: MultiplexBridgeApi): Promise<string> {
        this.sessionId ??= bridge.multiplexOpenSession().then(({ sessionId }) => {
            this.stopListening = bridge.onMultiplexStatus((status) => {
                if (status.sessionId === sessionId && !this.closed) {
                    this.statuses.set(
                        new Map(status.tiles.map((tile) => [tile.tileId, tile]))
                    );
                }
            });
            return sessionId;
        });
        return this.sessionId;
    }
}
