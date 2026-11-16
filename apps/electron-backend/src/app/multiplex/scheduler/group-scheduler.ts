/**
 * Rotates one upstream connection between the tiles of a playlist.
 *
 * The invariant everything else rests on: at most one connection to the
 * provider at any moment. A visit's connection is closed and confirmed
 * closed, then a short gap passes, before the next one is opened — and a
 * refusal is answered by waiting longer, never by opening a second one.
 */

import { TileSplicer } from '../splicer/tile-splicer';
import { TileReserve } from './reserve-model';
import {
    DEFAULT_SCHEDULER_CONFIG,
    MultiplexClock,
    OpenUpstream,
    SchedulerConfig,
    systemClock,
    TileProgress,
    TileSink,
    TileSource,
    TileState,
    TileStatus,
    UpstreamHandle,
} from './scheduler-types';
import { decideVisit, VisitDecision, WaitingTile } from './visit-policy';
import { VisitMeter } from './visit-meter';

type VisitEnd = VisitDecision | 'ended' | 'aborted' | 'unsupported';

interface Tile {
    readonly id: string;
    readonly source: TileSource;
    readonly sink: TileSink;
    readonly splicer: TileSplicer;
    readonly reserve: TileReserve;
    state: TileState;
    skippedMs: number;
    httpStatus?: number;
    failures: number;
    retryAtMs: number;
}

export interface GroupSchedulerDeps {
    readonly open: OpenUpstream;
    readonly clock?: MultiplexClock;
    readonly config?: Partial<SchedulerConfig>;
    readonly onStatus?: (tiles: TileStatus[]) => void;
}

const MAX_GAP_MS = 2000;
const GAP_STEP_MS = 200;
const STARVED_BELOW_SEC = 0.2;

export class GroupScheduler {
    private readonly tiles = new Map<string, Tile>();
    private readonly clock: MultiplexClock;
    private readonly config: SchedulerConfig;
    private running: Promise<void> | null = null;
    private stopped = false;
    private current: { tile: Tile; abort: AbortController } | null = null;
    private minGapMs: number;
    private lastCloseAtMs = Number.NEGATIVE_INFINITY;
    private averageVisitMs = 4000;

    constructor(private readonly deps: GroupSchedulerDeps) {
        this.clock = deps.clock ?? systemClock;
        this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...deps.config };
        this.minGapMs = this.config.minGapMs;
    }

    get tileCount(): number {
        return this.tiles.size;
    }

    /** Adds a tile, or replaces its channel with a fresh stream. */
    setTile(id: string, source: TileSource, sink: TileSink): void {
        this.abortIfCurrent(id);
        this.tiles.set(id, {
            id,
            source,
            sink,
            splicer: new TileSplicer(),
            reserve: new TileReserve(),
            state: 'waiting',
            skippedMs: 0,
            failures: 0,
            retryAtMs: 0,
        });
        if (!this.stopped && !this.running) {
            this.running = this.run();
        }
    }

    removeTile(id: string): void {
        this.abortIfCurrent(id);
        this.tiles.delete(id);
    }

    reportProgress(id: string, progress: TileProgress): void {
        this.tiles.get(id)?.reserve.noteReport(progress, this.clock.now());
    }

    /** Closes the connection and stops rotating. */
    async stop(): Promise<void> {
        this.stopped = true;
        this.tiles.clear();
        this.current?.abort.abort();
        await this.running;
    }

    status(): TileStatus[] {
        const now = this.clock.now();
        const cycleSec =
            (Math.max(0, this.tiles.size - 1) * this.averageVisitMs) / 1000;
        const resumeThresholdSec = Math.min(15, Math.max(2, cycleSec * 1.25));

        return [...this.tiles.values()].map((tile) => {
            const reserve = tile.reserve.reserveSec(now);
            const reserveSec = Number.isFinite(reserve) ? reserve : 0;
            const starved =
                tile.state === 'waiting' &&
                tile.reserve.started &&
                reserveSec < STARVED_BELOW_SEC;
            return {
                tileId: tile.id,
                state: starved ? 'starved' : tile.state,
                reserveSec: Math.round(reserveSec * 10) / 10,
                resumeThresholdSec: Math.round(resumeThresholdSec * 10) / 10,
                skippedMs: tile.skippedMs,
                httpStatus: tile.httpStatus,
            };
        });
    }

    private abortIfCurrent(id: string): void {
        if (this.current?.tile.id === id) {
            this.current.abort.abort();
        }
    }

    private async run(): Promise<void> {
        while (!this.stopped && this.tiles.size > 0) {
            const tile = this.pickNext();
            const gapLeft =
                this.lastCloseAtMs + this.minGapMs - this.clock.now();
            if (!tile || gapLeft > 0) {
                await this.clock.sleep(
                    tile ? gapLeft : this.config.tickMs
                );
                continue;
            }
            await this.visit(tile);
        }
        this.running = null;
    }

    /** The tile with the least media left, among those allowed to connect. */
    private pickNext(): Tile | null {
        const now = this.clock.now();
        let best: Tile | null = null;
        let bestReserve = Number.POSITIVE_INFINITY;
        for (const tile of this.tiles.values()) {
            if (tile.retryAtMs > now) {
                continue;
            }
            const reserve = tile.reserve.reserveSec(now);
            if (best === null || reserve < bestReserve) {
                best = tile;
                bestReserve = reserve;
            }
        }
        return best;
    }

    private async visit(tile: Tile): Promise<void> {
        const abort = new AbortController();
        this.current = { tile, abort };
        tile.state = 'connecting';
        this.emitStatus();
        const startedAt = this.clock.now();

        let handle: UpstreamHandle;
        try {
            handle = await this.deps.open(tile.source, abort.signal);
        } catch {
            handle = { status: 0, stream: null, close: async () => undefined };
        }

        let end: VisitEnd = 'aborted';
        let receivedAny = false;
        if (handle.stream && !abort.signal.aborted) {
            tile.state = 'filling';
            tile.splicer.beginVisit();
            const meter = new VisitMeter(this.clock, this.config.rateWindowMs);
            end = await this.pump(tile, handle, abort.signal, meter);
            tile.skippedMs = tile.splicer.endVisit().skippedMs;
            receivedAny = meter.receivedMediaMs > 0;
        }

        await handle.close();
        this.lastCloseAtMs = this.clock.now();
        this.current = null;

        if (end === 'unsupported') {
            tile.state = 'unsupported';
            tile.retryAtMs = Number.POSITIVE_INFINITY;
        } else if (abort.signal.aborted) {
            tile.state = 'waiting';
        } else if (!handle.stream || (end === 'ended' && !receivedAny)) {
            this.noteFailure(tile, handle.status);
        } else {
            tile.state = 'waiting';
            tile.failures = 0;
            tile.httpStatus = undefined;
            this.averageVisitMs =
                this.averageVisitMs * 0.7 +
                (this.lastCloseAtMs - startedAt + this.minGapMs) * 0.3;
        }
        this.emitStatus();
    }

    /** Feeds the tile from the open connection until the visit should end. */
    private pump(
        tile: Tile,
        handle: UpstreamHandle,
        signal: AbortSignal,
        meter: VisitMeter
    ): Promise<VisitEnd> {
        const stream = handle.stream as NonNullable<UpstreamHandle['stream']>;

        return new Promise<VisitEnd>((resolve) => {
            let done = false;
            const finish = (end: VisitEnd) => {
                if (!done) {
                    done = true;
                    resolve(end);
                }
            };
            const evaluate = () => {
                if (meter.looksUnsupported()) {
                    finish('unsupported');
                    return;
                }
                const decision = decideVisit(
                    meter.stats(tile.reserve.reserveSec(this.clock.now())),
                    this.waitingTiles(tile),
                    this.config
                );
                if (decision !== 'continue') {
                    finish(decision);
                }
            };

            signal.addEventListener('abort', () => finish('aborted'));
            stream.once('end', () => finish('ended'));
            stream.once('error', () => finish('ended'));
            stream.once('close', () => finish('ended'));
            stream.on('data', (chunk: Buffer) => {
                if (done) {
                    return;
                }
                const result = tile.splicer.push(chunk);
                if (result.output.length > 0) {
                    tile.sink.write(result.output);
                }
                tile.reserve.noteForwarded(
                    result.forwardedMs,
                    this.clock.now()
                );
                meter.note(chunk.length, result.receivedMs, result.forwardedMs);
                evaluate();
            });

            const tick = async () => {
                while (!done) {
                    await this.clock.sleep(this.config.tickMs);
                    if (!done) {
                        evaluate();
                        this.emitStatus();
                    }
                }
            };
            void tick();
        });
    }

    private waitingTiles(current: Tile): WaitingTile[] {
        const now = this.clock.now();
        const waiting: WaitingTile[] = [];
        for (const tile of this.tiles.values()) {
            if (tile !== current && tile.retryAtMs <= now) {
                waiting.push({
                    reserveSec: tile.reserve.reserveSec(now),
                    fullSec: tile.reserve.fullSec,
                    focused: tile.reserve.focused,
                });
            }
        }
        return waiting;
    }

    /** A refused or empty connection: wait longer, and space opens further. */
    private noteFailure(tile: Tile, status: number): void {
        tile.failures += 1;
        tile.state = 'error';
        tile.httpStatus = status;
        tile.retryAtMs =
            this.clock.now() +
            Math.min(
                this.config.backoffMaxMs,
                this.config.backoffBaseMs * 2 ** (tile.failures - 1)
            );
        this.minGapMs = Math.min(MAX_GAP_MS, this.minGapMs + GAP_STEP_MS);
    }

    private emitStatus(): void {
        this.deps.onStatus?.(this.status());
    }
}
