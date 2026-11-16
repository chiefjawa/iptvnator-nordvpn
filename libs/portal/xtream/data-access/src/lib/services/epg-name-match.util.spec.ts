import {
    buildEpgNameIndex,
    isPlaceholderEpgChannelId,
    looseEpgChannelKey,
    normalizeEpgChannelName,
} from './epg-name-match.util';

describe('epg-name-match.util', () => {
    describe('normalizeEpgChannelName', () => {
        it('applies NFKC, folds case and collapses whitespace', () => {
            expect(normalizeEpgChannelName('  Sample   NEWS ᴿᴬᵂ ')).toBe(
                'sample news raw'
            );
            expect(normalizeEpgChannelName('Ｆｕｌｌ　Width')).toBe(
                'full width'
            );
        });
    });

    describe('looseEpgChannelKey', () => {
        it.each([
            ['XY&Z: SAMPLE NEWS LIVE ᴿᴬᵂ', 'sample news live'],
            ['US: Sample News', 'sample news'],
            ['US| Sample News HD', 'sample news'],
            ['UK ▎ Sample Sports 4K', 'sample sports'],
            ['US - Sample Movies FHD', 'sample movies'],
            ['## US: SAMPLE NEWS ##', 'sample news'],
            ['VIP: US: Sample News', 'sample news'],
            ['Sample News [H.265] 50 FPS', 'sample news'],
            ['Sample News (UHD) HEVC 1080p BACKUP2', 'sample news'],
            ['Sample Newsᴴᴰ', 'sample news'],
            ['Sample One | HD', 'sample one'],
            ['Sample One +1', 'sample one 1'],
        ])('reduces %p to %p', (name, key) => {
            expect(looseEpgChannelKey(name)).toBe(key);
        });

        it('keeps non-Latin names intact', () => {
            expect(looseEpgChannelKey('Пример Канал HD')).toBe('пример канал');
            expect(looseEpgChannelKey('AR: قناة تجريبية')).toBe('قناة تجريبية');
            expect(looseEpgChannelKey('サンプル放送 HD')).toBe('サンプル放送');
        });

        it('rejects keys shorter than three characters', () => {
            expect(looseEpgChannelKey('US: AB HD')).toBe('');
            expect(looseEpgChannelKey('HD')).toBe('');
            expect(looseEpgChannelKey('US: ᴿᴬᵂ')).toBe('');
            expect(looseEpgChannelKey('ABC')).toBe('abc');
        });
    });

    it('detects placeholder ids', () => {
        expect(isPlaceholderEpgChannelId('dummy-123')).toBe(true);
        expect(isPlaceholderEpgChannelId('DUMMY-7')).toBe(true);
        expect(isPlaceholderEpgChannelId('dummy.channel')).toBe(false);
        expect(isPlaceholderEpgChannelId('sample.us')).toBe(false);
    });

    describe('buildEpgNameIndex', () => {
        it('matches a superscript-tagged, prefixed playlist name loosely', () => {
            const index = buildEpgNameIndex([
                { id: 'sample.news.us', displayName: 'SAMPLE NEWS LIVE' },
            ]);
            expect(index.resolve('XY&Z: SAMPLE NEWS LIVE ᴿᴬᵂ')).toBe(
                'sample.news.us'
            );
        });

        it('prefers an exact match over a loose one', () => {
            const index = buildEpgNameIndex([
                { id: 'a.loose', displayName: 'Sample News' },
                { id: 'z.exact', displayName: 'US: Sample News' },
            ]);
            expect(index.resolve('us:  SAMPLE news')).toBe('z.exact');
            expect(index.resolve('UK: Sample News')).toBe('a.loose');
        });

        it('never loose-matches placeholder channels', () => {
            const index = buildEpgNameIndex([
                { id: 'dummy-1', displayName: 'Sample Filler' },
            ]);
            expect(index.resolve('US: Sample Filler HD')).toBeNull();
            // An exact name is the only way to a placeholder.
            expect(index.resolve('Sample Filler')).toBe('dummy-1');
        });

        it('prefers real ids over placeholders, even through a loose match', () => {
            const index = buildEpgNameIndex([
                { id: 'dummy-2', displayName: 'Sample Movies HD' },
                { id: 'sample.movies', displayName: 'Sample Movies' },
            ]);
            expect(index.resolve('Sample Movies HD')).toBe('sample.movies');
        });

        it('resolves ties deterministically to the lowest id', () => {
            const channels = [
                { id: 'sample.b', displayName: 'Sample Sports' },
                { id: 'sample.a', displayName: 'Sample Sports HD' },
                { id: 'sample.c', displayName: 'SAMPLE SPORTS' },
            ];
            const forward = buildEpgNameIndex(channels);
            const reverse = buildEpgNameIndex([...channels].reverse());
            // Exact ties: sample.b and sample.c share the normalized name.
            expect(forward.resolve('Sample Sports')).toBe('sample.b');
            expect(reverse.resolve('Sample Sports')).toBe('sample.b');
            // Loose ties: all three share the key.
            expect(forward.resolve('US: Sample Sports FHD')).toBe('sample.a');
            expect(reverse.resolve('US: Sample Sports FHD')).toBe('sample.a');
        });

        it('does not loose-match short keys and ignores blank input', () => {
            const index = buildEpgNameIndex([
                { id: 'ab.us', displayName: 'AB' },
                { id: '', displayName: 'No Id' },
                { id: 'blank', displayName: '  ' },
            ]);
            expect(index.resolve('US: AB HD')).toBeNull();
            expect(index.resolve('AB')).toBe('ab.us');
            expect(index.resolve('No Id')).toBeNull();
            expect(index.resolve('')).toBeNull();
            expect(index.resolve(null)).toBeNull();
        });

        it('keeps non-Latin names apart', () => {
            const index = buildEpgNameIndex([
                { id: 'ru.sample', displayName: 'Пример Канал' },
                { id: 'ru.other', displayName: 'Другой Канал' },
            ]);
            expect(index.resolve('RU: Пример Канал HD')).toBe('ru.sample');
            expect(index.resolve('RU: Другой Канал')).toBe('ru.other');
            expect(index.resolve('RU: Третий Канал')).toBeNull();
        });
    });
});
