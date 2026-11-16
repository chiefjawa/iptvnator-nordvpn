/**
 * Multiview keys: `1`-`4` give a tile the sound, `F`/`Enter` enlarge the
 * tile with the sound (or bring it back), `Escape` leaves the enlarged tile,
 * `M` mutes or unmutes it.
 *
 * Only bare keys are used, so the shell's chords (Cmd/Ctrl+K, +P, +F, +B,
 * zoom, Back) and its `?` help never collide. Keys typed into a field, or
 * pressed while a dialog, menu or the channel picker is open, are left
 * alone; so is `Enter` on a control, which activates that control.
 */

export type MultiviewKeyAction =
    | { readonly kind: 'focus'; readonly index: number }
    | { readonly kind: 'toggle-enlarge' }
    | { readonly kind: 'exit-enlarge' }
    | { readonly kind: 'toggle-mute' };

/** Anything that owns the keyboard while open over the grid. */
const OVERLAY_SELECTOR = [
    '.cdk-overlay-pane',
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[role="menu"]',
    'app-multiview-channel-picker',
].join(', ');

/** Controls `Enter` must keep activating. */
const ACTIVATABLE_SELECTOR =
    'button, a[href], input, select, textarea, [role="button"], [role="menuitem"], [role="option"]';

export interface MultiviewKeyContext {
    readonly tileCount: number;
    readonly enlarged: boolean;
    /** The channel picker or another overlay is open. */
    readonly overlayOpen: boolean;
}

export function resolveMultiviewKey(
    event: KeyboardEvent,
    context: MultiviewKeyContext
): MultiviewKeyAction | null {
    if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.repeat ||
        context.overlayOpen ||
        context.tileCount === 0
    ) {
        return null;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (target && (isEditable(target) || target.closest(OVERLAY_SELECTOR))) {
        return null;
    }

    if (/^Digit[1-4]$/.test(event.code) || /^Numpad[1-4]$/.test(event.code)) {
        const index = Number(event.code.slice(-1)) - 1;
        return index < context.tileCount ? { kind: 'focus', index } : null;
    }
    switch (event.key) {
        case 'f':
        case 'F':
            return event.shiftKey ? null : { kind: 'toggle-enlarge' };
        case 'Enter':
            return target?.closest(ACTIVATABLE_SELECTOR)
                ? null
                : { kind: 'toggle-enlarge' };
        case 'Escape':
            return context.enlarged ? { kind: 'exit-enlarge' } : null;
        case 'm':
        case 'M':
            return event.shiftKey ? null : { kind: 'toggle-mute' };
        default:
            return null;
    }
}

function isEditable(target: Element): boolean {
    return (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
    );
}
