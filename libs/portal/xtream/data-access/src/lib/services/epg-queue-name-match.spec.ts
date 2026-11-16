import { TestBed } from '@angular/core/testing';
import { EpgPreferencesService, SettingsStore } from '@iptvnator/services';
import type { EpgItem } from '@iptvnator/shared/interfaces';
import { buildEpgNameIndex } from './epg-name-match.util';
import { EpgQueueEntry, EpgQueueService } from './epg-queue.service';
import { XtreamApiService } from './xtream-api.service';
import { XtreamXmltvFallbackService } from './xtream-xmltv-fallback.service';

/**
 * Row previews and the XMLTV name match. A channel without mapping and
 * `epg_channel_id` is answered by the name-matched XMLTV programme from the
 * viewport's one batch IPC, without the provider; with an `epg_channel_id`
 * the name match stays the last resort.
 */
describe('EpgQueueService name match', () => {
    const original = window.electron;
    let service: EpgQueueService;
    let getShortEpg: jest.Mock;
    let getCurrentProgramsBatch: jest.Mock;
    let matchChannelNames: jest.Mock;
    let getEpgMappingsBatch: jest.Mock;
    let preferUploaded: boolean;
    let indexKey: string | null;
    let guide = buildEpgNameIndex([]);

    const credentials = {
        serverUrl: 'https://xtream.example.com',
        username: 'user',
        password: 'pass',
    };
    const named: EpgQueueEntry = {
        streamId: 1,
        epgChannelId: null,
        playlistId: 'playlist-1',
        channelName: 'XY: SAMPLE NEWS ᴿᴬᵂ',
        categoryName: 'US| SAMPLE ᴿᴬᵂ',
    };

    beforeEach(() => {
        jest.useFakeTimers();
        preferUploaded = false;
        indexKey = 'index-1';
        guide = buildEpgNameIndex([
            { id: 'samplenews.us', displayName: 'Sample News' },
            { id: 'dummy-1', displayName: 'XY: FILLER ONLY ᴿᴬᵂ' },
        ]);
        getShortEpg = jest.fn().mockResolvedValue([]);
        getCurrentProgramsBatch = jest.fn(async (ids: string[]) =>
            Object.fromEntries(ids.map((id) => [id, item(id, `${id} (XMLTV)`)]))
        );
        matchChannelNames = jest.fn(
            async (
                requests: Array<{
                    channelName?: string | null;
                    categoryName?: string | null;
                }>
            ) => ({
                matches: requests.map((request) =>
                    guide.match(request.channelName, request)
                ),
                indexKey,
            })
        );
        getEpgMappingsBatch = jest.fn().mockResolvedValue({});
        Object.defineProperty(window, 'electron', {
            configurable: true,
            value: { getEpgMappingsBatch },
        });
        TestBed.configureTestingModule({
            providers: [
                EpgQueueService,
                {
                    provide: XtreamApiService,
                    useValue: { getShortEpg, getFullEpg: jest.fn() },
                },
                {
                    provide: XtreamXmltvFallbackService,
                    useValue: {
                        getCurrentProgramsBatch,
                        matchChannelNames,
                        nameIndexKey: () => indexKey,
                    },
                },
                {
                    provide: SettingsStore,
                    useValue: {
                        preferUploadedEpgOverXtream: () => preferUploaded,
                        resolvedEpgOffsetMinutes: () => 0,
                    },
                },
            ],
        });
        service = TestBed.inject(EpgQueueService);
    });

    afterEach(() => {
        jest.useRealTimers();
        Object.defineProperty(window, 'electron', {
            configurable: true,
            value: original,
        });
    });

    function visibleOf(entries: ReadonlyArray<EpgQueueEntry>): Set<number> {
        return new Set(entries.map((entry) => entry.streamId));
    }

    async function enqueueAndSettle(
        entries: ReadonlyArray<EpgQueueEntry>
    ): Promise<void> {
        await service.enqueue(entries, visibleOf(entries), credentials);
        await jest.advanceTimersByTimeAsync(1000);
    }

    function providerCalledFor(streamId: number): boolean {
        return getShortEpg.mock.calls.some((call) => call[1] === streamId);
    }

    it('answers a channel without epg_channel_id from the name match, without the provider', async () => {
        const results: number[] = [];
        service.epgResult$.subscribe(({ streamId }) => results.push(streamId));

        await service.enqueue([named], visibleOf([named]), credentials);

        // Recorded as soon as the batch returns — no queue, no timers.
        expect(service.getCached(1)?.[0].title).toBe('samplenews.us (XMLTV)');
        expect(results).toEqual([1]);
        expect(matchChannelNames).toHaveBeenCalledWith([named]);
        await jest.advanceTimersByTimeAsync(5000);
        expect(getShortEpg).not.toHaveBeenCalled();
    });

    it('reads id and name matches of a viewport in one batch IPC', async () => {
        await enqueueAndSettle([
            { ...named, streamId: 1, epgChannelId: 'sample.id' },
            { ...named, streamId: 2 },
            { streamId: 3, epgChannelId: 'sample.other' },
        ]);

        expect(getCurrentProgramsBatch).toHaveBeenCalledTimes(1);
        expect(getCurrentProgramsBatch).toHaveBeenCalledWith([
            'sample.id',
            'sample.other',
            'samplenews.us',
        ]);
        expect(matchChannelNames).toHaveBeenCalledTimes(1);
    });

    it('takes the first candidate that has a current programme', async () => {
        guide = buildEpgNameIndex([
            { id: 'samplenews.a.us', displayName: 'Sample News' },
            { id: 'samplenews.b.us', displayName: 'SAMPLE NEWS' },
        ]);
        getCurrentProgramsBatch.mockResolvedValue({
            'samplenews.b.us': item('samplenews.b.us', 'Second source'),
        });

        await enqueueAndSettle([named]);

        expect(getCurrentProgramsBatch).toHaveBeenCalledWith([
            'samplenews.a.us',
            'samplenews.b.us',
        ]);
        expect(service.getCached(1)?.[0].title).toBe('Second source');
        expect(getShortEpg).not.toHaveBeenCalled();
    });

    it('answers from the name match under preferUploadedEpgOverXtream too', async () => {
        preferUploaded = true;

        await enqueueAndSettle([named]);

        expect(getShortEpg).not.toHaveBeenCalled();
        expect(service.getCached(1)?.[0].title).toBe('samplenews.us (XMLTV)');
    });

    describe('channels with an epg_channel_id keep their precedence', () => {
        const withId = { ...named, epgChannelId: 'sample.id' };

        it('provider first, under preferUploadedEpgOverXtream off', async () => {
            getShortEpg.mockResolvedValue([item('provider', 'Provider now')]);

            await enqueueAndSettle([withId]);

            expect(service.getCached(1)?.[0].title).toBe('Provider now');
        });

        it('the epg_channel_id XMLTV next, then the name match', async () => {
            await enqueueAndSettle([withId]);
            expect(service.getCached(1)?.[0].title).toBe('sample.id (XMLTV)');

            getCurrentProgramsBatch.mockImplementation(async () => ({
                'samplenews.us': item('samplenews.us', 'By name'),
            }));
            service.invalidate(1);
            await enqueueAndSettle([withId]);
            expect(getShortEpg).toHaveBeenCalledTimes(2);
            expect(service.getCached(1)?.[0].title).toBe('By name');
        });

        it('the epg_channel_id XMLTV without the provider when uploaded EPG is preferred', async () => {
            preferUploaded = true;

            await enqueueAndSettle([withId]);

            expect(getShortEpg).not.toHaveBeenCalled();
            expect(service.getCached(1)?.[0].title).toBe('sample.id (XMLTV)');
        });
    });

    it('never uses the name match of a manually mapped channel', async () => {
        getEpgMappingsBatch.mockResolvedValue({
            'xtream:playlist-1:1': 'sample.mapped',
        });
        getCurrentProgramsBatch.mockResolvedValue({});

        await enqueueAndSettle([named]);

        expect(getCurrentProgramsBatch).toHaveBeenCalledWith(['sample.mapped']);
        expect(providerCalledFor(1)).toBe(true);
        expect(service.getCached(1)).toEqual([]);
    });

    it('asks the provider before a placeholder match, and uses it only when the provider is empty', async () => {
        const filler = { ...named, channelName: 'XY: FILLER ONLY ᴿᴬᵂ' };

        await enqueueAndSettle([filler]);
        expect(providerCalledFor(1)).toBe(true);
        expect(service.getCached(1)?.[0].title).toBe('dummy-1 (XMLTV)');

        getShortEpg.mockResolvedValue([item('provider', 'Provider now')]);
        service.invalidate(1);
        await enqueueAndSettle([filler]);
        expect(service.getCached(1)?.[0].title).toBe('Provider now');
    });

    it('queues channels the XMLTV knows nothing about after the ones with an epg_channel_id', async () => {
        getCurrentProgramsBatch.mockResolvedValue({});
        const unknown = { ...named, streamId: 1, channelName: 'Unknown One' };
        const withId = { streamId: 2, epgChannelId: 'sample.id' };
        const unknownToo = { ...named, streamId: 3, channelName: 'Unknown 2' };

        await enqueueAndSettle([unknown, withId, unknownToo]);

        expect(getShortEpg.mock.calls.map((call) => call[1])).toEqual([
            2, 1, 3,
        ]);
    });

    describe('starvation under fast scrolling', () => {
        const rows = (from: number, count: number): EpgQueueEntry[] =>
            Array.from({ length: count }, (_, offset) => {
                const n = from + offset;
                return {
                    streamId: n,
                    epgChannelId: null,
                    playlistId: 'playlist-1',
                    // Every third row has nothing in the guide.
                    channelName:
                        n % 3 === 0
                            ? `XY: NOTHING ${n} ᴿᴬᵂ`
                            : `XY: SAMPLE CHANNEL ${n} ᴿᴬᵂ`,
                    categoryName: 'US| SAMPLE',
                };
            });

        beforeEach(() => {
            guide = buildEpgNameIndex(
                Array.from({ length: 120 }, (_, n) => ({
                    id: `samplechannel${n}.us`,
                    displayName: `Sample Channel ${n}`,
                }))
            );
            // A slow provider that knows nothing about these channels.
            getShortEpg.mockImplementation(
                () =>
                    new Promise((resolve) =>
                        setTimeout(() => resolve([]), 5000)
                    )
            );
            // The batch IPC takes a moment, so scrolls overlap it.
            const read = getCurrentProgramsBatch.getMockImplementation();
            getCurrentProgramsBatch.mockImplementation(
                (ids: string[]) =>
                    new Promise((resolve) =>
                        setTimeout(() => resolve(read?.(ids)), 50)
                    )
            );
        });

        it('gives every name-matchable row its programme without a provider call', async () => {
            const viewports = [rows(1, 20), rows(21, 20), rows(41, 20)];
            // Three scroll steps, each superseding the previous enqueue
            // before its batch IPC returned; then scrolling back up.
            const pending = viewports.map((viewport) =>
                service.enqueue(viewport, visibleOf(viewport), credentials)
            );
            await jest.advanceTimersByTimeAsync(60);
            await Promise.all(pending);
            await jest.advanceTimersByTimeAsync(60_000);

            const matchable = viewports
                .flat()
                .filter((row) => row.streamId % 3 !== 0);
            for (const row of matchable) {
                expect(service.getCached(row.streamId)?.[0]?.title).toBe(
                    `samplechannel${row.streamId}.us (XMLTV)`
                );
                expect(providerCalledFor(row.streamId)).toBe(false);
            }
            // Only rows without any XMLTV hit ever reach the provider.
            expect(getShortEpg).toHaveBeenCalled();
            expect(
                getShortEpg.mock.calls.every((call) => call[1] % 3 === 0)
            ).toBe(true);
        });

        it('renders a row that scrolls back into view from the cache, without IPC', async () => {
            for (const viewport of [rows(1, 20), rows(21, 20)]) {
                const done = service.enqueue(
                    viewport,
                    visibleOf(viewport),
                    credentials
                );
                await jest.advanceTimersByTimeAsync(60);
                await done;
            }
            const batches = getCurrentProgramsBatch.mock.calls.length;

            // Scrolling back: the rows read the cache synchronously.
            expect(service.getCached(2)?.[0]?.title).toBe(
                'samplechannel2.us (XMLTV)'
            );
            expect(getCurrentProgramsBatch).toHaveBeenCalledTimes(batches);
        });
    });

    describe('cached empty answers and the name index', () => {
        it('does not let an empty answer from before the index was ready hide a match', async () => {
            const realGuide = guide;
            guide = buildEpgNameIndex([]);
            indexKey = null;
            await enqueueAndSettle([named]);
            expect(providerCalledFor(1)).toBe(true);
            // Recorded, but under no index: not a usable answer.
            expect(service.getCached(1)).toBeNull();

            guide = realGuide;
            indexKey = 'index-1';
            await enqueueAndSettle([named]);

            expect(service.getCached(1)?.[0].title).toBe(
                'samplenews.us (XMLTV)'
            );
        });

        it('lets a newly built index reach a row whose empty answer is cached', async () => {
            const unmatched = { ...named, channelName: 'XY: LATER NEWS' };
            await enqueueAndSettle([unmatched]);
            expect(service.getCached(1)).toEqual([]);

            // A completed import adds the channel; a new index is built.
            guide = buildEpgNameIndex([
                { id: 'laternews.us', displayName: 'Later News' },
            ]);
            indexKey = 'index-2';
            expect(service.getCached(1)).toBeNull();
            await enqueueAndSettle([unmatched]);

            expect(service.getCached(1)?.[0].title).toBe(
                'laternews.us (XMLTV)'
            );
        });

        it('keeps an empty answer for its TTL while the same index is current', async () => {
            const unmatched = { ...named, channelName: 'XY: NOWHERE' };
            await enqueueAndSettle([unmatched]);
            await enqueueAndSettle([unmatched]);

            expect(getShortEpg).toHaveBeenCalledTimes(1);
            expect(service.getCached(1)).toEqual([]);
        });

        /** Holds the next provider answer until the returned call. */
        function holdProvider(): () => void {
            let release: (() => void) | undefined;
            getShortEpg.mockImplementationOnce(
                () =>
                    new Promise<EpgItem[]>((resolve) => {
                        release = () => resolve([]);
                    })
            );
            return () => release?.();
        }

        it('keeps a name match recorded while an empty provider answer was in flight', async () => {
            const later = { ...named, channelName: 'XY: LATER NEWS' };
            const release = holdProvider();
            await enqueueAndSettle([later]);
            expect(providerCalledFor(1)).toBe(true);

            // An import adds the channel while the provider request runs.
            guide = buildEpgNameIndex([
                { id: 'laternews.us', displayName: 'Later News' },
            ]);
            indexKey = 'index-2';
            await enqueueAndSettle([later]);
            expect(service.getCached(1)?.[0].title).toBe(
                'laternews.us (XMLTV)'
            );

            release();
            await jest.advanceTimersByTimeAsync(0);

            expect(service.getCached(1)?.[0].title).toBe(
                'laternews.us (XMLTV)'
            );
        });

        it('caches an empty answer under the index its name lookup used', async () => {
            const later = { ...named, channelName: 'XY: LATER NEWS' };
            const release = holdProvider();
            await enqueueAndSettle([later]);

            // Another view builds a newer index before the provider
            // answers empty; that answer says nothing about the new index.
            indexKey = 'index-2';
            release();
            await jest.advanceTimersByTimeAsync(0);

            expect(service.getCached(1)).toBeNull();
        });
    });

    it('does nothing with EPG turned off', async () => {
        await TestBed.inject(EpgPreferencesService).apply(false);

        await enqueueAndSettle([named]);

        expect(matchChannelNames).not.toHaveBeenCalled();
        expect(getCurrentProgramsBatch).not.toHaveBeenCalled();
        expect(getShortEpg).not.toHaveBeenCalled();
        expect(service.getCached(1)).toBeNull();
    });

    it('drops the name match with the rest of the stream state on invalidate', async () => {
        await enqueueAndSettle([named]);
        expect(service.getCached(1)).not.toBeNull();

        guide = buildEpgNameIndex([]);
        service.invalidate(1);
        await enqueueAndSettle([named]);

        expect(service.getCached(1)).toEqual([]);
    });

    it('discards a name match whose stream was invalidated while the batch was in flight', async () => {
        let release!: () => void;
        getCurrentProgramsBatch.mockImplementation(
            (ids: string[]) =>
                new Promise((resolve) => {
                    release = () =>
                        resolve(
                            Object.fromEntries(
                                ids.map((id) => [id, item(id, 'Stale')])
                            )
                        );
                })
        );
        const done = service.enqueue([named], visibleOf([named]), credentials);
        await jest.advanceTimersByTimeAsync(0);
        service.invalidate(1);
        release();
        await done;

        expect(service.getCached(1)?.[0]?.title).not.toBe('Stale');
    });
});

function item(channelId: string, title: string): EpgItem {
    return {
        id: `${channelId}|x`,
        epg_id: '',
        title,
        lang: '',
        start: '2026-05-07T08:00:00Z',
        end: '2026-05-07T09:00:00Z',
        stop: '2026-05-07T09:00:00Z',
        description: '',
        channel_id: channelId,
        start_timestamp: '0',
        stop_timestamp: '0',
    };
}
