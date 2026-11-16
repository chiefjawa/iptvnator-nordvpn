import {
    buildEpgNameIndex,
    EpgNameIndexChannel,
    isPlaceholderEpgChannelId,
    normalizeEpgChannelName,
} from './epg-name-match.util';

const index = (channels: EpgNameIndexChannel[]) => buildEpgNameIndex(channels);
const ch = (id: string, displayName: string): EpgNameIndexChannel => ({
    id,
    displayName,
});
const US = { categoryName: 'US| SAMPLE ᴿᴬᵂ ⁶⁰ᶠᵖˢ' };

describe('epg-name-match.util', () => {
    it('normalizes with NFKC, case folding and collapsed whitespace', () => {
        expect(normalizeEpgChannelName('  Sample   NEWS ᴿᴬᵂ ')).toBe(
            'sample news raw'
        );
        expect(normalizeEpgChannelName('Ｆｕｌｌ　Width')).toBe('full width');
    });

    it('detects placeholder ids', () => {
        expect(isPlaceholderEpgChannelId('dummy-123')).toBe(true);
        expect(isPlaceholderEpgChannelId('DUMMY-7')).toBe(true);
        expect(isPlaceholderEpgChannelId('dummy.channel')).toBe(false);
        expect(isPlaceholderEpgChannelId('sample.us')).toBe(false);
    });

    describe('exact and name tiers', () => {
        const guide = index([
            ch('samplenews.us', 'Sample News'),
            ch('samplemovies.us', 'Sample Movies'),
            ch('demoplus.us', 'Demo+'),
            ch('travelandtrail.us', 'Travel & Trail'),
        ]);

        it.each([
            ['XY&Z: SAMPLE NEWS ᴿᴬᵂ', 'samplenews.us'],
            ['US: Sample News', 'samplenews.us'],
            ['US| Sample News HD', 'samplenews.us'],
            ['US ▎ Sample News 4K', 'samplenews.us'],
            ['US - Sample News FHD', 'samplenews.us'],
            ['## US: SAMPLE NEWS ##', 'samplenews.us'],
            ['VIP: US: Sample News', 'samplenews.us'],
            ['Sample News [H.265] 50 FPS', 'samplenews.us'],
            ['Sample News (UHD) HEVC 1080p BACKUP2', 'samplenews.us'],
            ['Sample Newsᴴᴰ', 'samplenews.us'],
            ['US: NEWS SAMPLE', 'samplenews.us'],
            ['US: SAMPLE NEWS CHANNEL', 'samplenews.us'],
            ['US: THE SAMPLE NEWS NETWORK', 'samplenews.us'],
            ['XY: SAMPLE MOVIES ⁽ᴮᴷ⁾', 'samplemovies.us'],
        ])('matches %p', (name, id) => {
            expect(guide.resolve(name, US)).toBe(id);
        });

        it('reads `+` as plus and `&` as a connector, both sides alike', () => {
            expect(guide.resolve('XY: DEMO + ᴿᴬᵂ', US)).toBe('demoplus.us');
            expect(guide.resolve('XY: DEMO PLUS', US)).toBe('demoplus.us');
            expect(guide.resolve('XY: DEMO', US)).toBeNull();
            expect(guide.resolve('XY: TRAVEL AND TRAIL', US)).toBe(
                'travelandtrail.us'
            );
            expect(guide.resolve('XY: TRAVEL & TRAIL', US)).toBe(
                'travelandtrail.us'
            );
        });

        it('reports the tier', () => {
            expect(guide.match('Sample News', US)?.tier).toBe('exact');
            expect(guide.match('US: SAMPLE NEWS', US)?.tier).toBe('name');
        });

        it('compares the squashed form, also against the id', () => {
            const squashed = index([
                ch('SampleAction(SMPA).us', 'SampleAction'),
                ch('examplelive.us', 'Example Live Feed Service'),
                ch('DemoView(DMV).us', 'Demo View'),
            ]);
            expect(squashed.resolve('XY: SAMPLE ACTION ᴿᴬᵂ', US)).toBe(
                'SampleAction(SMPA).us'
            );
            expect(squashed.resolve('XY: EXAMPLE LIVE', US)).toBe(
                'examplelive.us'
            );
            expect(squashed.resolve('XY: DEMOVIEW TV', US)).toBe(
                'DemoView(DMV).us'
            );
        });

        it('maps number words to digits and joins letters with numbers', () => {
            const numbered = index([
                ch('sample1.us', 'Sample 1'),
                ch('demo11.us', 'Demo 11'),
            ]);
            expect(numbered.resolve('XY: SAMPLE ONE', US)).toBe('sample1.us');
            expect(numbered.resolve('XY: DEMO11', US)).toBe('demo11.us');
            expect(numbered.resolve('XY: SAMPLE 2', US)).toBeNull();
        });

        it('knows a guide name by the part after a `BRAND - ` prefix or before `by <brand>`', () => {
            const branded = index([
                ch('LG-SampleCityHawks.us', 'LG - Sample City Hawks'),
                ch('samplequestbystudio.us', 'Sample Quest By Studio'),
            ]);
            expect(branded.resolve('XY: SAMPLE CITY HAWKS', US)).toBe(
                'LG-SampleCityHawks.us'
            );
            expect(branded.resolve('XY: SAMPLE QUEST', US)).toBe(
                'samplequestbystudio.us'
            );
            expect(branded.resolve('XY: SAMPLE QUEST STUDIO', US)).toBe(
                'samplequestbystudio.us'
            );
            const single = index([ch('samplebystudio.us', 'Sample By Studio')]);
            expect(single.resolve('XY: SAMPLE', US)).toBeNull();
        });

        it('keeps `X Network` and `X Channel` apart', () => {
            const kinds = index([ch('samplechannel.us', 'Sample Channel')]);
            expect(kinds.resolve('XY: SAMPLE NETWORK', US)).toBeNull();
            expect(kinds.resolve('XY: SAMPLE', US)).toBe('samplechannel.us');
        });

        it('keeps regional feeds apart; an unmarked feed is the east one', () => {
            const feeds = index([
                ch('samplemax.us', 'Sample Max'),
                ch('samplemaxwest.us', 'Sample Max West'),
            ]);
            expect(feeds.resolve('XY: SAMPLE MAX EAST', US)).toBe(
                'samplemax.us'
            );
            expect(feeds.resolve('XY: SAMPLE MAX', US)).toBe('samplemax.us');
            expect(feeds.resolve('XY: SAMPLE MAX WEST', US)).toBe(
                'samplemaxwest.us'
            );
            expect(feeds.resolve('XY: SAMPLE MAX PACIFIC', US)).toBeNull();
            const inside = index([ch('wildsamplewest.us', 'Wild Sample West')]);
            expect(inside.resolve('XY: WILD WEST SAMPLE', US)).toBeNull();
            const region = index([ch('samplesouth.uk', 'Sample One South')]);
            expect(region.resolve('UK: SAMPLE ONE SOUTH EAST')).toBeNull();
            const westOnly = index([ch('demowest.us', 'Demo Stream West')]);
            expect(westOnly.resolve('XY: DEMO STREAM', US)).toBeNull();
        });
    });

    describe('call signs', () => {
        const guide = index([
            ch('kqzx.us', 'NET-B KQZX KQZX'),
            ch('netawqzrcity.us', 'ABC WQZR Sample City'),
            ch('wqzt.us', 'National Broadcasting Company WQZT'),
            ch('samplewqzy.us', 'Sample Wqzy'),
        ]);

        it('matches a bracketed call sign', () => {
            expect(guide.match('US: NET 7 (KQZX) SAMPLE CITY HD', US)).toEqual({
                ids: ['kqzx.us'],
                tier: 'callSign',
            });
            expect(guide.resolve('US: ABC 9 (WQZR-DT) CITY', US)).toBe(
                'netawqzrcity.us'
            );
        });

        it('takes an unbracketed call sign only next to a network name', () => {
            expect(guide.resolve('XY: SAMPLE CITY WQZR ABC 9', US)).toBe(
                'netawqzrcity.us'
            );
            expect(guide.resolve('XY: SAMPLE CITY WQZR 9', US)).toBeNull();
        });

        it('reads spelled-out network names and rejects another network', () => {
            expect(guide.resolve('US: NBC 4 (WQZT) CITY', US)).toBe('wqzt.us');
            expect(guide.resolve('US: CBS (WQZT) CITY', US)).toBeNull();
        });

        it('ignores a call-sign-shaped word of a guide name without a network', () => {
            expect(guide.resolve('US: NBC (WQZY) CITY', US)).toBeNull();
        });
    });

    describe('partial tier', () => {
        const guide = index([
            ch('NETLocalSampleCity(KQAAFST).us', 'NET Local Sample City'),
            ch('fox9.us', 'Sample Sports Arena'),
            ch('samplesportsgolf.us', 'Sample Sports Golf Extra'),
            ch('hubregional.us', 'Example Hub Regional'),
        ]);

        it('accepts extra bracketed detail', () => {
            const hub = index([ch('examplehub.us', 'Example Hub Sports')]);
            expect(
                hub.match('US: EXAMPLE HUB SPORTS (NORTH CITY) HD', US)
            ).toEqual({ ids: ['examplehub.us'], tier: 'partial' });
        });

        it('accepts a local station number missing on one side', () => {
            const station = index([ch('abcsamplecity.us', 'ABC Sample City')]);
            expect(station.resolve('XY: ABC 7 SAMPLE CITY', US)).toBe(
                'abcsamplecity.us'
            );
            // Without a network name the number must agree.
            const plain = index([ch('samplecity.us', 'Sample City')]);
            expect(plain.resolve('XY: SAMPLE 7 CITY', US)).toBeNull();
        });

        it('accepts a trailing `show`', () => {
            const show = index([ch('samplefamily.us', 'Sample Family')]);
            expect(show.resolve('XY: THE SAMPLE FAMILY SHOW', US)).toBe(
                'samplefamily.us'
            );
        });

        it('rejects an extra word that makes a sibling channel', () => {
            expect(
                guide.resolve('XY: SAMPLE SPORTS ARENA GOLF', US)
            ).toBeNull();
            expect(guide.resolve('XY: EXAMPLE HUB', US)).toBeNull();
        });

        it('needs the bracketed share to stay under the coverage limit', () => {
            const short = index([ch('samplehub.us', 'Sample Hub')]);
            // `Sample Hub` covers well under 60% of the longer name.
            expect(
                short.resolve('XY: SAMPLE HUB (NORTHERN DISTRICT EAST)', US)
            ).toBeNull();
            expect(short.resolve('XY: SAMPLE HUB (NORTH)', US)).toBe(
                'samplehub.us'
            );
            expect(short.resolve('XY: SAMPLE HUB (A)', US)).toBe(
                'samplehub.us'
            );
            // A two-letter region code in brackets is another feed.
            expect(short.resolve('XY: SAMPLE HUB (QX)', US)).toBeNull();
        });

        it('needs a country hint', () => {
            const hub = index([ch('examplehub.us', 'Example Hub Sports')]);
            expect(hub.resolve('EXAMPLE HUB SPORTS (NORTH CITY)')).toBeNull();
        });
    });

    describe('country hints', () => {
        const guide = index([
            ch('samplecinema.us', 'Sample Cinema'),
            ch('samplecinema.uk', 'Sample Cinema'),
            ch('samplecinema.ca', 'Sample Cinema'),
            ch('exampleworldnews.in', 'Example World News'),
            ch('demokids.uk', 'Demo Kids'),
            ch('demomovies.us', 'Demo Movies'),
            ch('demomovies.fr', 'Demo Movies HD'),
        ]);

        it('chooses the hinted country from the name or category prefix', () => {
            expect(guide.resolve('US: SAMPLE CINEMA')).toBe('samplecinema.us');
            expect(guide.resolve('UK| SAMPLE CINEMA')).toBe('samplecinema.uk');
            expect(
                guide.resolve('XY: SAMPLE CINEMA', { categoryName: 'CA| MAIN' })
            ).toBe('samplecinema.ca');
            expect(
                guide.resolve('XY: SAMPLE CINEMA', { categoryName: 'GB: MAIN' })
            ).toBe('samplecinema.uk');
        });

        it('reads the country of a second prefix after a package tag', () => {
            expect(guide.resolve('VIP: US: SAMPLE CINEMA')).toBe(
                'samplecinema.us'
            );
            expect(guide.resolve('XY| UK: SAMPLE CINEMA')).toBe(
                'samplecinema.uk'
            );
            // A country first prefix stays the hint.
            expect(guide.resolve('CA: XY: SAMPLE CINEMA')).toBe(
                'samplecinema.ca'
            );
        });

        it('lets a name prefix narrow a regional category', () => {
            const regional = index([
                ch('samplecanal2.co', 'Sample Canal 2'),
                ch('samplecanal2.sv', 'Sample Canal 2'),
            ]);
            expect(
                regional.resolve('CO: SAMPLE CANAL 2', {
                    categoryName: 'LA| X',
                })
            ).toBe('samplecanal2.co');
            // Two countries of the region carry the name: no answer.
            expect(
                regional.match('XY: SAMPLE CANAL 2', { categoryName: 'LA| X' })
            ).toBeNull();
        });

        it('lets a spelled-out name prefix override the category', () => {
            const ambiguous = index([
                ch('samplefour.sa', 'Sample Four'),
                ch('samplefour.ar', 'Sample Four'),
            ]);
            // `AR` lists are Arabic; `ARG` is Argentina.
            expect(
                ambiguous.resolve('ARG: SAMPLE FOUR', { categoryName: 'AR| X' })
            ).toBe('samplefour.ar');
            expect(
                ambiguous.resolve('XY: SAMPLE FOUR', { categoryName: 'AR| X' })
            ).toBe('samplefour.sa');
        });

        it('gives no answer for one name in several countries without a hint', () => {
            expect(guide.match('SAMPLE CINEMA HD')).toBeNull();
            expect(
                guide.match('XY: SAMPLE CINEMA', { categoryName: '24/7 MIX' })
            ).toBeNull();
        });

        it('lets a distinctive international name match abroad, word for word', () => {
            expect(guide.resolve('US: EXAMPLE WORLD NEWS HD')).toBe(
                'exampleworldnews.in'
            );
            expect(guide.resolve('US: EXAMPLE WORLD NEWS CHANNEL')).toBeNull();
            // One word, however long, is not distinctive enough abroad.
            const single = index([ch('samplevision.in', 'Samplevision')]);
            expect(single.resolve('US: SAMPLEVISION')).toBeNull();
        });

        it('keeps a short or nationally branded name at home', () => {
            // `Demo` has guide channels in the US: the UK one is a variant.
            expect(guide.resolve('US: DEMO KIDS')).toBeNull();
            const short = index([ch('qzv.uk', 'QZV')]);
            expect(short.resolve('US: QZV')).toBeNull();
            expect(short.resolve('UK: QZV')).toBe('qzv.uk');
        });

        it('ranks a guide channel without a country between home and abroad', () => {
            const mixed = index([
                ch('samplearena', 'Sample Arena'),
                ch('samplearena.de', 'Sample Arena'),
            ]);
            expect(mixed.resolve('US: SAMPLE ARENA')).toBe('samplearena');
            expect(mixed.resolve('DE: SAMPLE ARENA')).toBe('samplearena.de');
        });

        it('reads region prefixes and timeshift ids', () => {
            const regional = index([
                ch('samplesport1.sa', 'Sample Sport 1'),
                ch('samplefour.uk.plus1', 'Sample Four +1'),
                ch('sampletoons.latino', 'Sample Toons'),
            ]);
            expect(regional.resolve('AR: SAMPLE SPORT 1 HD')).toBe(
                'samplesport1.sa'
            );
            expect(regional.resolve('UK: SAMPLE FOUR+1')).toBe(
                'samplefour.uk.plus1'
            );
            expect(regional.resolve('LA: SAMPLE TOONS')).toBe(
                'sampletoons.latino'
            );
            expect(regional.resolve('MK: SAMPLE TOONS')).toBeNull();
        });
    });

    describe('ties and candidates', () => {
        it('lists every same-channel duplicate, deterministically', () => {
            const channels = [
                ch('samplesports.b.us', 'Sample Sports'),
                ch('samplesports.a.us', 'SAMPLE SPORTS HD'),
                ch('SampleSports(SMPS).us', 'SampleSports'),
            ];
            const forward = index(channels);
            const reverse = index([...channels].reverse());
            const expected = {
                ids: [
                    'SampleSports(SMPS).us',
                    'samplesports.a.us',
                    'samplesports.b.us',
                ],
                tier: 'name',
            };
            expect(forward.match('US: SAMPLE SPORTS FHD')).toEqual(expected);
            expect(reverse.match('US: SAMPLE SPORTS FHD')).toEqual(expected);
        });

        it('caps the candidates', () => {
            const many = index(
                Array.from({ length: 6 }, (_, n) =>
                    ch(`samplenews${n}.us`, 'Sample News')
                )
            );
            expect(many.match('US: SAMPLE NEWS')?.ids).toHaveLength(3);
        });

        it('gives no answer when two different channels fit a partial name equally', () => {
            const two = index([
                ch('net5north.us', 'NET North Sample'),
                ch('net5south.us', 'NET South Sample'),
            ]);
            expect(two.resolve('XY: NET 5 SAMPLE (NORTH)', US)).toBeNull();
        });
    });

    describe('placeholders, separators, short and non-Latin names', () => {
        it('never loose-matches a placeholder; an exact name reaches it last', () => {
            const guide = index([
                ch('dummy-1', 'XY: SAMPLE FILLER ᴿᴬᵂ'),
                ch('dummy-2', 'Sample Movies HD'),
                ch('samplemovies.us', 'Sample Movies'),
            ]);
            expect(guide.resolve('XY: SAMPLE FILLER', US)).toBeNull();
            expect(guide.match('XY: SAMPLE FILLER ᴿᴬᵂ', US)).toEqual({
                ids: ['dummy-1'],
                tier: 'placeholder',
            });
            expect(guide.resolve('Sample Movies HD', US)).toBe(
                'samplemovies.us'
            );
        });

        it('skips list section headers', () => {
            const guide = index([ch('samplenews.us', 'Sample News')]);
            expect(guide.resolve('##### SAMPLE NEWS #####', US)).toBeNull();
        });

        it('matches generic or two-letter names only in the hinted country', () => {
            const guide = index([
                ch('tv1.us', 'TV One'),
                ch('qz.us', 'QZ'),
                ch('qz.za', 'QZ TV'),
            ]);
            expect(guide.resolve('XY: TV 1', US)).toBe('tv1.us');
            expect(guide.resolve('TV 1')).toBeNull();
            expect(guide.resolve('XY: QZ', US)).toBe('qz.us');
            expect(guide.resolve('XY: QZ')).toBeNull();
            // The whole name, exactly, is not a loose match.
            expect(guide.match('QZ')).toEqual({
                ids: ['qz.us'],
                tier: 'exact',
            });
        });

        it('ignores blank input and channels without id or name', () => {
            const guide = index([
                ch('', 'No Id'),
                ch('blank', '  '),
                { id: null, displayName: 'Null Id' } as never,
            ]);
            expect(guide.resolve('No Id')).toBeNull();
            expect(guide.resolve('')).toBeNull();
            expect(guide.resolve(null)).toBeNull();
            expect(guide.resolve(undefined)).toBeNull();
        });

        it('keeps non-Latin names apart', () => {
            const guide = index([
                ch('ru.sample', 'Пример Канал'),
                ch('ru.other', 'Другой Канал'),
                ch('ar.sample', 'قناة تجريبية'),
                ch('jp.sample', 'サンプル放送'),
            ]);
            expect(guide.resolve('RU: Пример Канал HD')).toBe('ru.sample');
            expect(guide.resolve('RU: Другой Канал')).toBe('ru.other');
            expect(guide.resolve('RU: Третий Канал')).toBeNull();
            expect(guide.resolve('AR: قناة تجريبية HD')).toBe('ar.sample');
            expect(guide.resolve('JP: サンプル放送 ᴴᴰ')).toBe('jp.sample');
        });

        it('answers repeated lookups from its memo', () => {
            const guide = index([ch('samplenews.us', 'Sample News')]);
            const first = guide.match('US: SAMPLE NEWS');
            expect(guide.match('US: SAMPLE NEWS')).toBe(first);
            expect(guide.match('US: SAMPLE NEWS', US)).toEqual(first);
        });
    });
});
