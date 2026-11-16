/**
 * Decides when the tile holding the connection should give it up.
 *
 * A visit is worth its reconnect only while the server is bursting. Once
 * delivery falls to real time the tile is as full as it can get — it cannot
 * hold more than its distance behind the live edge — so the connection moves
 * on as soon as another tile has run low. During the burst only a tile that
 * is about to run dry may interrupt, and not before the current tile has
 * banked enough to survive its own wait.
 */

import { SchedulerConfig } from './scheduler-types';

export interface VisitStats {
    readonly ageMs: number;
    /** Media forwarded to the tile on this visit. */
    readonly newMediaMs: number;
    /** The visited tile's own reserve right now. */
    readonly reserveSec: number;
    /** Media per wall time over the recent window; null until measurable. */
    readonly recentRate: number | null;
}

export interface WaitingTile {
    readonly reserveSec: number;
    /** Its full reserve, which sets the level it asks for a visit at. */
    readonly fullSec: number;
    readonly focused: boolean;
}

export type VisitDecision = 'continue' | 'realtime' | 'preempt' | 'max';

export function decideVisit(
    stats: VisitStats,
    others: readonly WaitingTile[],
    config: SchedulerConfig
): VisitDecision {
    if (others.length === 0) {
        return 'continue';
    }
    if (stats.ageMs >= config.maxVisitMs) {
        return 'max';
    }

    const settled =
        stats.recentRate !== null && stats.recentRate < config.realtimeRate;
    if (settled && others.some((tile) => wantsVisit(tile, config))) {
        return 'realtime';
    }

    // Interrupting a burst costs a reconnect, so it is only worth it for a
    // tile that is both about to run dry and worse off than this one.
    const banked = stats.newMediaMs >= config.minNewMediaMs;
    const needier = others.some(
        (tile) =>
            isCritical(tile, config) && tile.reserveSec < stats.reserveSec
    );
    return banked && needier ? 'preempt' : 'continue';
}

/** A waiting tile has drained far enough to be worth a reconnect. */
export function wantsVisit(tile: WaitingTile, config: SchedulerConfig): boolean {
    const lowWater = Math.max(
        config.lowWaterFloorSec,
        tile.fullSec * config.lowWaterFraction
    );
    return tile.reserveSec < lowWater;
}

function isCritical(tile: WaitingTile, config: SchedulerConfig): boolean {
    return (
        tile.reserveSec <
        (tile.focused ? config.focusedCriticalSec : config.criticalSec)
    );
}
