import { LiveSidebarState } from './live-sidebar-state';

/** Narrower than this, a live player is not worth showing beside panels. */
export const LIVE_PLAYER_MIN_WIDTH = 320;
/** The channels rail never gets narrower (its resizable minimum). */
export const LIVE_CHANNELS_MIN_WIDTH = 250;
/** The shell's categories rail with its gutter, until measured. */
export const LIVE_CATEGORIES_RAIL_WIDTH = 323;
/** At and below this the shell shows categories as a drawer, out of flow. */
export const LIVE_PHONE_MAX_WIDTH = 640;

export interface LivePanelsGeometry {
    /** The live layout's own width (channels rail + player area). */
    readonly layoutWidth: number;
    /** The level the layout shows while it was measured. */
    readonly shown: LiveSidebarState;
    /** The categories rail takes room beside the layout when it is open. */
    readonly railInFlow: boolean;
    readonly railWidth?: number;
    readonly playerMinWidth?: number;
}

/**
 * The least fold that leaves the player its minimum width: `expanded` when
 * the categories rail, the channels rail (at its minimum) and the player
 * all fit, `categories-hidden` when only the channels rail fits beside the
 * player, else `collapsed`. Computed from what the panels would take, not
 * from the player's current width, so folding never feeds back into it.
 */
export function fitLivePanels(geometry: LivePanelsGeometry): LiveSidebarState {
    const rail = geometry.railInFlow
        ? (geometry.railWidth ?? LIVE_CATEGORIES_RAIL_WIDTH)
        : 0;
    const playerMin = geometry.playerMinWidth ?? LIVE_PLAYER_MIN_WIDTH;
    // The room the layout would have with the categories rail folded.
    const room =
        geometry.layoutWidth + (geometry.shown === 'expanded' ? rail : 0);
    const besideChannels = room - LIVE_CHANNELS_MIN_WIDTH;

    if (besideChannels - rail >= playerMin) {
        return 'expanded';
    }
    return besideChannels >= playerMin ? 'categories-hidden' : 'collapsed';
}

/**
 * The categories rail's real width, from two measurements either side of
 * its fold at the same window width; null when they do not tell.
 */
export function measureRailWidth(
    before: { layoutWidth: number; shown: LiveSidebarState; viewport: number },
    after: { layoutWidth: number; shown: LiveSidebarState; viewport: number }
): number | null {
    const railShown = (level: LiveSidebarState) => level === 'expanded';
    if (
        before.viewport !== after.viewport ||
        railShown(before.shown) === railShown(after.shown)
    ) {
        return null;
    }
    const width = Math.abs(after.layoutWidth - before.layoutWidth);
    // A rail mid-transition or a resize in between gives an implausible value.
    return width >= 150 && width <= 700 ? width : null;
}
