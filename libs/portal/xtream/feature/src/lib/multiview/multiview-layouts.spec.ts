import {
    deleteLayout,
    layoutMatches,
    MAX_MULTIVIEW_LAYOUTS,
    MultiviewLayout,
    readMultiviewLayouts,
    renameLayout,
    resolveLayoutChannels,
    saveLayout,
    writeMultiviewLayouts,
} from './multiview-layouts';

const sports: MultiviewLayout = { name: 'Sports', xtreamIds: [1, 2] };
const news: MultiviewLayout = { name: 'News', xtreamIds: [3] };

describe('multiview layouts', () => {
    beforeEach(() => localStorage.clear());

    it('round-trips layouts per playlist and stores only names and ids', () => {
        writeMultiviewLayouts('playlist-a', [sports, news]);

        expect(readMultiviewLayouts('playlist-a')).toEqual([sports, news]);
        expect(readMultiviewLayouts('playlist-b')).toEqual([]);
        expect(
            JSON.parse(
                localStorage.getItem('iptvnator-multiview-layouts:playlist-a') ??
                    ''
            )
        ).toEqual([
            { name: 'Sports', xtreamIds: [1, 2] },
            { name: 'News', xtreamIds: [3] },
        ]);
    });

    it('ignores damaged storage and invalid entries', () => {
        localStorage.setItem('iptvnator-multiview-layouts:p', '{not json');
        expect(readMultiviewLayouts('p')).toEqual([]);

        localStorage.setItem(
            'iptvnator-multiview-layouts:p',
            JSON.stringify([
                { name: '  ', xtreamIds: [1] },
                { name: 'Ok', xtreamIds: [1, 'x', 2.5, 4, 5, 6, 7] },
                { name: 'No ids' },
            ])
        );
        expect(readMultiviewLayouts('p')).toEqual([
            { name: 'Ok', xtreamIds: [1, 4, 5, 6] },
        ]);
    });

    it('adds a layout, and overwrites one of the same name', () => {
        const added = saveLayout([sports], '  Late   news ', [3, 4]);
        expect(added.error).toBeUndefined();
        expect(added.layouts.map((layout) => layout.name)).toEqual([
            'Sports',
            'Late news',
        ]);

        const replaced = saveLayout(added.layouts, 'sports', [9]);
        expect(replaced.layouts[0]).toEqual({ name: 'sports', xtreamIds: [9] });
        expect(replaced.layouts).toHaveLength(2);
    });

    it('refuses an empty name, an empty grid and more than the cap', () => {
        expect(saveLayout([], ' ', [1]).error).toBe('empty');
        expect(saveLayout([], 'Name', []).error).toBe('empty');

        const full = Array.from({ length: MAX_MULTIVIEW_LAYOUTS }, (_, i) => ({
            name: `Layout ${i}`,
            xtreamIds: [i],
        }));
        expect(saveLayout(full, 'One more', [1]).error).toBe('full');
        // Overwriting stays possible at the cap.
        expect(saveLayout(full, 'Layout 3', [7]).error).toBeUndefined();
    });

    it('renames unless the name is empty or taken, and deletes', () => {
        expect(renameLayout([sports, news], 'Sports', 'Games')?.[0].name).toBe(
            'Games'
        );
        expect(renameLayout([sports, news], 'Sports', 'SPORTS')?.[0].name).toBe(
            'SPORTS'
        );
        expect(renameLayout([sports, news], 'Sports', 'news')).toBeNull();
        expect(renameLayout([sports, news], 'Sports', '  ')).toBeNull();
        expect(deleteLayout([sports, news], 'sports')).toEqual([news]);
    });

    it('skips channels that are no longer in the playlist', () => {
        const byId = new Map([[2, 'two']]);
        expect(resolveLayoutChannels(sports, byId)).toEqual({
            channels: ['two'],
            missing: 1,
        });
        expect(layoutMatches(sports, [1, 2])).toBe(true);
        expect(layoutMatches(sports, [2, 1])).toBe(false);
    });
});
