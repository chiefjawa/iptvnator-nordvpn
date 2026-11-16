import { MultiviewKeyContext, resolveMultiviewKey } from './multiview-keyboard';

const grid: MultiviewKeyContext = {
    tileCount: 3,
    enlarged: false,
    overlayOpen: false,
};

function press(
    init: KeyboardEventInit,
    target: Element = document.body,
    context: MultiviewKeyContext = grid
) {
    const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        ...init,
    });
    let result: ReturnType<typeof resolveMultiviewKey> = null;
    target.addEventListener(
        'keydown',
        (received) => {
            result = resolveMultiviewKey(received as KeyboardEvent, context);
        },
        { once: true }
    );
    target.dispatchEvent(event);
    return result;
}

describe('resolveMultiviewKey', () => {
    afterEach(() => (document.body.innerHTML = ''));

    it('maps the number row and keypad to existing tiles', () => {
        expect(press({ key: '2', code: 'Digit2' })).toEqual({
            kind: 'focus',
            index: 1,
        });
        expect(press({ key: '1', code: 'Numpad1' })).toEqual({
            kind: 'focus',
            index: 0,
        });
        // Only three tiles.
        expect(press({ key: '4', code: 'Digit4' })).toBeNull();
        // Layout-independent: AZERTY's unshifted 1 key.
        expect(press({ key: '&', code: 'Digit1' })).toEqual({
            kind: 'focus',
            index: 0,
        });
    });

    it('maps F, Enter, M and Escape', () => {
        expect(press({ key: 'f' })).toEqual({ kind: 'toggle-enlarge' });
        expect(press({ key: 'Enter' })).toEqual({ kind: 'toggle-enlarge' });
        expect(press({ key: 'm' })).toEqual({ kind: 'toggle-mute' });
        expect(press({ key: 'Escape' })).toBeNull();
        expect(
            press({ key: 'Escape' }, document.body, { ...grid, enlarged: true })
        ).toEqual({ kind: 'exit-enlarge' });
    });

    it('leaves the shell chords and repeats alone', () => {
        expect(press({ key: 'k', ctrlKey: true })).toBeNull();
        expect(press({ key: 'f', metaKey: true })).toBeNull();
        expect(press({ key: '1', code: 'Digit1', altKey: true })).toBeNull();
        expect(press({ key: 'f', repeat: true })).toBeNull();
    });

    it('stays out of fields, overlays and the picker', () => {
        const input = document.body.appendChild(document.createElement('input'));
        expect(press({ key: 'f' }, input)).toBeNull();

        const pane = document.body.appendChild(document.createElement('div'));
        pane.className = 'cdk-overlay-pane';
        const item = pane.appendChild(document.createElement('span'));
        expect(press({ key: 'm' }, item)).toBeNull();

        expect(
            press({ key: '1', code: 'Digit1' }, document.body, {
                ...grid,
                overlayOpen: true,
            })
        ).toBeNull();
    });

    it('lets Enter activate a focused control', () => {
        const button = document.body.appendChild(
            document.createElement('button')
        );
        expect(press({ key: 'Enter' }, button)).toBeNull();
        expect(press({ key: 'f' }, button)).toEqual({ kind: 'toggle-enlarge' });
    });
});
