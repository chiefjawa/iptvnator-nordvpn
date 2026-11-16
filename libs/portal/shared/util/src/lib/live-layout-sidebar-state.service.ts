import {
    computed,
    Injectable,
    Signal,
    signal,
    WritableSignal,
} from '@angular/core';
import {
    forgetLegacyLiveSidebarState,
    LiveSidebarState,
    LiveSidebarSurface,
    liveSidebarStateStorageKey,
    persistLiveSidebarState,
    restoreLiveSidebarState,
} from './live-sidebar-state';

const LEVEL_DEPTH: Record<LiveSidebarState, number> = {
    expanded: 0,
    'categories-hidden': 1,
    collapsed: 2,
};

function deeper(a: LiveSidebarState, b: LiveSidebarState): LiveSidebarState {
    return LEVEL_DEPTH[a] >= LEVEL_DEPTH[b] ? a : b;
}

function bySurface<T>(
    create: (surface: LiveSidebarSurface) => T
): Record<LiveSidebarSurface, T> {
    return {
        m3u: create('m3u'),
        portal: create('portal'),
        collection: create('collection'),
    };
}

/**
 * Single owner of the live-TV sidebar collapse state. Every surface that
 * renders a collapsible channel rail — the M3U player, the Xtream/Stalker
 * live layouts together with the workspace shell categories rail, the
 * unified favorites/recent live tab, and the workspace header toggle — reads
 * and writes through this service, so a toggle in one place is reflected
 * everywhere the same surface is rendered within the session.
 *
 * State is kept per surface (`live-sidebar-state:<surface>` in
 * localStorage). The pre-split shared key is forgotten on construction.
 *
 * The three levels nest (see `LiveSidebarState`). Consumers read one of two
 * derived flags rather than the raw state: the categories rail folds on
 * `areCategoriesHiddenFor(surface)`, the channels rail only on
 * `isCollapsedFor(surface)`.
 *
 * A layout too narrow for all its panels sets a fit level
 * (`setFitLevel`): the panels then fold at least that far without touching
 * the stored preference, which applies again once the window is wide. A
 * choice made while narrow is kept for the session, for the narrow case
 * only: it is what the user asked for at that width.
 */
@Injectable({ providedIn: 'root' })
export class LiveLayoutSidebarStateService {
    /** The user's preference, persisted. */
    private readonly states: Record<
        LiveSidebarSurface,
        WritableSignal<LiveSidebarState>
    >;
    /** The fold the layout's width requires; `expanded` when it all fits. */
    private readonly fitLevels = bySurface(() =>
        signal<LiveSidebarState>('expanded')
    );
    /** A level chosen while narrow; session-only. */
    private readonly narrowChoices = bySurface(() =>
        signal<LiveSidebarState | null>(null)
    );
    private readonly narrowRestoreTargets = bySurface(
        (): Exclude<LiveSidebarState, 'collapsed'> => 'categories-hidden'
    );
    /** What the layout shows. */
    private readonly effective: Record<
        LiveSidebarSurface,
        Signal<LiveSidebarState>
    >;
    private readonly collapsed: Record<LiveSidebarSurface, Signal<boolean>>;
    private readonly categoriesHidden: Record<
        LiveSidebarSurface,
        Signal<boolean>
    >;
    /**
     * The level to come back to when leaving `collapsed`, per surface.
     * Session-only on purpose: a restart restores the stored level itself.
     */
    private readonly restoreTargets: Record<
        LiveSidebarSurface,
        Exclude<LiveSidebarState, 'collapsed'>
    >;

    constructor() {
        forgetLegacyLiveSidebarState();
        this.states = bySurface((surface) =>
            signal(restoreLiveSidebarState(liveSidebarStateStorageKey(surface)))
        );
        this.effective = bySurface((surface) =>
            computed(() => {
                const fit = this.fitLevels[surface]();
                const preferred = this.states[surface]();
                return fit === 'expanded'
                    ? preferred
                    : (this.narrowChoices[surface]() ?? deeper(preferred, fit));
            })
        );
        this.collapsed = bySurface((surface) =>
            computed(() => this.effective[surface]() === 'collapsed')
        );
        this.categoriesHidden = bySurface((surface) =>
            computed(() => this.effective[surface]() !== 'expanded')
        );
        // A restored `categories-hidden` is what Cmd/Ctrl+B comes back to.
        this.restoreTargets = bySurface((surface) => {
            const restored = this.states[surface]();
            return restored === 'collapsed' ? 'expanded' : restored;
        });
    }

    /** The level shown, including a fold the width forces. */
    stateOf(surface: LiveSidebarSurface): Signal<LiveSidebarState> {
        return this.effective[surface];
    }

    /** The stored preference, which a forced fold leaves alone. */
    preferenceOf(surface: LiveSidebarSurface): Signal<LiveSidebarState> {
        return this.states[surface].asReadonly();
    }

    /**
     * The least fold at which the layout still fits its player; `expanded`
     * when everything fits (or the layout is gone).
     */
    setFitLevel(surface: LiveSidebarSurface, level: LiveSidebarState): void {
        this.fitLevels[surface].set(level);
    }

    /** The width forces a fold, so level changes are session-only. */
    isNarrow(surface: LiveSidebarSurface): boolean {
        return this.fitLevels[surface]() !== 'expanded';
    }

    /** Stable per-surface signal; safe to assign to a component field. */
    isCollapsedFor(surface: LiveSidebarSurface): Signal<boolean> {
        return this.collapsed[surface];
    }

    /**
     * The categories rail is folded (`categories-hidden` or `collapsed`).
     * Stable per-surface signal.
     */
    areCategoriesHiddenFor(surface: LiveSidebarSurface): Signal<boolean> {
        return this.categoriesHidden[surface];
    }

    /**
     * `Cmd/Ctrl+B`, the header toggle and the floating restore handle: leave
     * `collapsed` for the level the user collapsed from, otherwise collapse
     * everything.
     */
    toggle(surface: LiveSidebarSurface): void {
        if (this.collapsed[surface]()) {
            this.expand(surface);
        } else {
            this.collapse(surface);
        }
    }

    /** Player only. Remembers the current level for `expand()`. */
    collapse(surface: LiveSidebarSurface): void {
        this.setState(surface, 'collapsed');
    }

    /** Leaves `collapsed` for the level it was entered from. */
    expand(surface: LiveSidebarSurface): void {
        this.setState(
            surface,
            this.isNarrow(surface)
                ? this.narrowRestoreTargets[surface]
                : this.restoreTargets[surface]
        );
    }

    hideCategories(surface: LiveSidebarSurface): void {
        this.setState(surface, 'categories-hidden');
    }

    showCategories(surface: LiveSidebarSurface): void {
        this.setState(surface, 'expanded');
    }

    setState(surface: LiveSidebarSurface, state: LiveSidebarState): void {
        if (this.isNarrow(surface)) {
            if (state !== 'collapsed') {
                this.narrowRestoreTargets[surface] = state;
            }
            this.narrowChoices[surface].set(state);
            return;
        }
        if (state !== 'collapsed') {
            this.restoreTargets[surface] = state;
        }
        this.states[surface].set(state);
        persistLiveSidebarState(state, liveSidebarStateStorageKey(surface));
    }
}
