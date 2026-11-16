import { computed, signal, Signal } from '@angular/core';
import { resolveMultiviewKey } from './multiview-keyboard';

/**
 * Which multiview tile has the sound, whether it is muted, and whether it
 * fills the grid — and the keys that change them (see multiview-keyboard).
 */
export class MultiviewFocus {
    /** The tile with the sound. */
    readonly focusedId = signal<string | null>(null);
    /** `M`: the tile with the sound is muted. */
    readonly soundOff = signal(false);
    private readonly enlargedMode = signal(false);
    /**
     * The tile filling the grid: always the one with the sound. The others
     * shrink beside it but stay on screen and keep playing, so a shared
     * connection keeps hearing their progress and serves them as before.
     */
    readonly enlargedId = computed(() =>
        this.enlargedMode() && this.tileIds().length > 1
            ? this.focusedId()
            : null
    );

    constructor(private readonly tileIds: Signal<readonly string[]>) {}

    isMuted(tileId: string): boolean {
        return this.focusedId() === tileId ? this.soundOff() : true;
    }

    focus(tileId: string): void {
        this.focusedId.set(tileId);
        this.soundOff.set(false);
    }

    toggleEnlarged(tileId: string): void {
        const enlarged = this.enlargedId() === tileId;
        this.focus(tileId);
        this.enlargedMode.set(!enlarged);
    }

    handleKey(event: KeyboardEvent, overlayOpen: boolean): void {
        const ids = this.tileIds();
        const action = resolveMultiviewKey(event, {
            tileCount: ids.length,
            enlarged: this.enlargedId() !== null,
            overlayOpen,
        });
        if (!action) {
            return;
        }
        event.preventDefault();
        const focused = this.focusedId();
        switch (action.kind) {
            case 'focus':
                this.focus(ids[action.index]);
                break;
            case 'toggle-enlarge':
                if (focused) {
                    this.toggleEnlarged(focused);
                }
                break;
            case 'exit-enlarge':
                this.enlargedMode.set(false);
                break;
            case 'toggle-mute':
                this.soundOff.update((off) => !off);
                break;
        }
    }
}
