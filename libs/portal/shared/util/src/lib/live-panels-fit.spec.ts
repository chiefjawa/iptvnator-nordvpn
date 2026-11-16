import { fitLivePanels, measureRailWidth } from './live-panels-fit';

describe('fitLivePanels', () => {
    // Widths of the layout as measured beside a 323px categories rail.
    it('keeps every panel when the player still gets 320px', () => {
        expect(
            fitLivePanels({
                layoutWidth: 577,
                shown: 'expanded',
                railInFlow: true,
            })
        ).toBe('expanded');
    });

    it('folds the categories rail first, then the channels rail', () => {
        // A 660px window: 604px beside the app rail.
        expect(
            fitLivePanels({
                layoutWidth: 281,
                shown: 'expanded',
                railInFlow: true,
            })
        ).toBe('categories-hidden');
        expect(
            fitLivePanels({
                layoutWidth: 520,
                shown: 'categories-hidden',
                railInFlow: true,
            })
        ).toBe('collapsed');
    });

    it('gives the same answer whatever level it is measured at', () => {
        // The same 724px of room at each level.
        for (const [layoutWidth, shown] of [
            [401, 'expanded'],
            [724, 'categories-hidden'],
            [724, 'collapsed'],
        ] as const) {
            expect(
                fitLivePanels({ layoutWidth, shown, railInFlow: true })
            ).toBe('categories-hidden');
        }
    });

    it('ignores a rail that is not beside the layout', () => {
        expect(
            fitLivePanels({
                layoutWidth: 600,
                shown: 'expanded',
                railInFlow: false,
            })
        ).toBe('expanded');
    });

    it('honours a measured rail width', () => {
        // 900px of room: 327px left beside a 323px rail, 250px beside 400px.
        expect(
            fitLivePanels({
                layoutWidth: 577,
                shown: 'expanded',
                railInFlow: true,
            })
        ).toBe('expanded');
        expect(
            fitLivePanels({
                layoutWidth: 500,
                shown: 'expanded',
                railInFlow: true,
                railWidth: 400,
            })
        ).toBe('categories-hidden');
    });
});

describe('measureRailWidth', () => {
    const at = (
        layoutWidth: number,
        shown: 'expanded' | 'collapsed',
        viewport = 900
    ) => ({
        layoutWidth,
        shown,
        viewport,
    });

    it('reads the rail from a fold at the same window width', () => {
        expect(
            measureRailWidth(at(401, 'expanded'), at(724, 'collapsed'))
        ).toBe(323);
    });

    it('ignores a resize in between, no fold, or a rail mid-transition', () => {
        expect(
            measureRailWidth(at(401, 'expanded'), at(724, 'collapsed', 950))
        ).toBeNull();
        expect(
            measureRailWidth(at(401, 'expanded'), at(420, 'expanded'))
        ).toBeNull();
        expect(
            measureRailWidth(at(401, 'expanded'), at(460, 'collapsed'))
        ).toBeNull();
    });
});
