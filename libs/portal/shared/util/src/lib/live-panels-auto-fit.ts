import {
    DestroyRef,
    effect,
    ElementRef,
    inject,
    Signal,
    untracked,
} from '@angular/core';
import { LiveLayoutSidebarStateService } from './live-layout-sidebar-state.service';
import {
    fitLivePanels,
    LIVE_CATEGORIES_RAIL_WIDTH,
    LIVE_PHONE_MAX_WIDTH,
    measureRailWidth,
} from './live-panels-fit';
import { LiveSidebarState, LiveSidebarSurface } from './live-sidebar-state';

/** Longer than the categories rail's 180 ms width transition. */
const SETTLE_MS = 220;

interface Sample {
    readonly layoutWidth: number;
    readonly shown: LiveSidebarState;
    readonly viewport: number;
}

/**
 * Folds the live panels while the window is too narrow for the player
 * (see `fitLivePanels`), through the sidebar state's fit level, so the
 * stored preference is untouched and returns when the window widens.
 * Must run in the layout component's injection context.
 */
export function autoFitLivePanels(options: {
    readonly surface: LiveSidebarSurface;
    readonly playerShown: Signal<boolean>;
    /** The shell renders a categories rail beside the layout. */
    readonly hasCategoriesRail: boolean;
}): void {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const state = inject(LiveLayoutSidebarStateService);
    const { surface } = options;
    const view = host.ownerDocument.defaultView;
    if (!view || typeof view.ResizeObserver === 'undefined') {
        return;
    }

    let railWidth = LIVE_CATEGORIES_RAIL_WIDTH;
    let last: Sample | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const evaluate = () => {
        timer = null;
        const viewport = view.innerWidth;
        if (
            !untracked(options.playerShown) ||
            viewport <= LIVE_PHONE_MAX_WIDTH
        ) {
            state.setFitLevel(surface, 'expanded');
            last = null;
            return;
        }
        const sample: Sample = {
            layoutWidth: host.clientWidth,
            shown: untracked(state.stateOf(surface)),
            viewport,
        };
        if (sample.layoutWidth === 0) {
            return;
        }
        if (last) {
            railWidth = measureRailWidth(last, sample) ?? railWidth;
        }
        last = sample;
        state.setFitLevel(
            surface,
            fitLivePanels({
                layoutWidth: sample.layoutWidth,
                shown: sample.shown,
                railInFlow: options.hasCategoriesRail,
                railWidth,
            })
        );
    };
    const schedule = () => {
        if (timer) {
            clearTimeout(timer);
        }
        timer = setTimeout(evaluate, SETTLE_MS);
    };

    const observer = new view.ResizeObserver(schedule);
    observer.observe(host);
    // A level change resizes the layout too, but only once the rail has
    // finished moving; the player appearing does not resize it at all.
    effect(() => {
        options.playerShown();
        state.stateOf(surface)();
        schedule();
    });
    inject(DestroyRef).onDestroy(() => {
        observer.disconnect();
        if (timer) {
            clearTimeout(timer);
        }
        state.setFitLevel(surface, 'expanded');
    });
}
