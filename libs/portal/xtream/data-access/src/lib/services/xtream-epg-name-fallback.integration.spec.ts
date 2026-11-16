import { TestBed } from '@angular/core/testing';
import {
    EpgPreferencesService,
    RuntimeCapabilitiesService,
    SettingsStore,
} from '@iptvnator/services';
import type { EpgItem, EpgProgram } from '@iptvnator/shared/interfaces';
import { EpgQueueService } from './epg-queue.service';
import { XtreamApiService } from './xtream-api.service';
import { XtreamFullEpgService } from './xtream-full-epg.service';
import { XtreamXmltvFallbackService } from './xtream-xmltv-fallback.service';

jest.mock('@iptvnator/portal/shared/util', () => ({
    createLogger: () => ({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    }),
}));

/**
 * Real queue, full-EPG resolver, XMLTV fallback and name index against a
 * synthetic Electron EPG bridge: an Xtream channel without `epg_channel_id`
 * gets its programmes from the XMLTV channel whose display name matches,
 * before — and instead of — the provider.
 */
describe('Xtream XMLTV name match (integration)', () => {
    const original = window.electron;
    const NOW_MS = Date.parse('2026-05-07T08:30:00Z');
    const xmltvChannels = [
        { id: 'dummy-17', displayName: 'SAMPLE NEWS LIVE' },
        { id: 'sample.news.us', displayName: 'SAMPLE NEWS LIVE' },
        { id: 'dummy-18', displayName: 'Sample Filler' },
        { id: 'sample.id.us', displayName: 'Sample Id Channel' },
        { id: 'sample.mapped', displayName: 'Sample Mapped' },
        { id: 'samplecinema.us', displayName: 'Sample Cinema' },
        { id: 'samplecinema.uk', displayName: 'Sample Cinema' },
    ];
    const programmeOf = (channel: string): EpgProgram => ({
        channel,
        start: '2026-05-07T08:00:00Z',
        stop: '2026-05-07T09:00:00Z',
        startTimestamp: Date.parse('2026-05-07T08:00:00Z') / 1000,
        stopTimestamp: Date.parse('2026-05-07T09:00:00Z') / 1000,
        title: `${channel} programme`,
        desc: null,
        category: null,
    });
    const credentials = {
        id: 'playlist-1',
        serverUrl: 'https://xtream.example.com',
        username: 'user',
        password: 'pass',
    };
    const channelName = 'XY&Z: SAMPLE NEWS LIVE ᴿᴬᵂ';

    let bridge: {
        getEpgChannels: jest.Mock;
        getCurrentProgramsBatch: jest.Mock;
        getChannelPrograms: jest.Mock;
        getEpgMapping: jest.Mock;
        getEpgMappingsBatch: jest.Mock;
        onEpgProgress: jest.Mock;
    };
    let api: { getShortEpg: jest.Mock; getFullEpg: jest.Mock };
    let preferUploaded: boolean;
    let offsetMinutes: number;

    beforeEach(() => {
        jest.useFakeTimers({ now: NOW_MS });
        preferUploaded = false;
        offsetMinutes = 0;
        const known = new Set(xmltvChannels.map((channel) => channel.id));
        bridge = {
            getEpgChannels: jest.fn(async () => ({
                channels: xmltvChannels,
                programs: [],
            })),
            getCurrentProgramsBatch: jest.fn(async (ids: string[]) =>
                Object.fromEntries(
                    ids.map((id) => [
                        id,
                        known.has(id) ? programmeOf(id) : null,
                    ])
                )
            ),
            getChannelPrograms: jest.fn(async (id: string) =>
                known.has(id) ? [programmeOf(id)] : []
            ),
            getEpgMapping: jest.fn(async () => null),
            getEpgMappingsBatch: jest.fn(async () => ({})),
            onEpgProgress: jest.fn(),
        };
        Object.defineProperty(window, 'electron', {
            configurable: true,
            value: bridge,
        });
        api = {
            getShortEpg: jest.fn(async () => []),
            getFullEpg: jest.fn(async () => []),
        };
        TestBed.configureTestingModule({
            providers: [
                { provide: XtreamApiService, useValue: api },
                {
                    provide: RuntimeCapabilitiesService,
                    useValue: { supportsEpgMapping: true },
                },
                {
                    provide: SettingsStore,
                    useValue: {
                        preferUploadedEpgOverXtream: () => preferUploaded,
                        resolvedEpgOffsetMinutes: () => offsetMinutes,
                    },
                },
            ],
        });
    });

    afterEach(() => {
        jest.useRealTimers();
        Object.defineProperty(window, 'electron', {
            configurable: true,
            value: original,
        });
    });

    function loadSchedule(
        epgChannelId: string | null,
        name: string | null = channelName
    ): Promise<EpgItem[]> {
        return TestBed.inject(XtreamFullEpgService).load(
            credentials,
            1,
            epgChannelId,
            { channelName: name }
        );
    }

    it('shows the "now" row preview from the XMLTV channel matched by name', async () => {
        const queue = TestBed.inject(EpgQueueService);
        const results: Array<{ streamId: number; items: EpgItem[] }> = [];
        queue.epgResult$.subscribe((result) => results.push(result));

        await queue.enqueue(
            [
                {
                    streamId: 1,
                    epgChannelId: null,
                    playlistId: credentials.id,
                    channelName,
                },
            ],
            new Set([1]),
            credentials
        );
        await jest.advanceTimersByTimeAsync(1000);

        expect(api.getShortEpg).not.toHaveBeenCalled();
        expect(bridge.getEpgChannels).toHaveBeenCalledTimes(1);
        expect(bridge.getCurrentProgramsBatch).toHaveBeenCalledTimes(1);
        // Same provider-clock "now" as the epg_channel_id path.
        expect(bridge.getCurrentProgramsBatch).toHaveBeenCalledWith(
            ['sample.news.us'],
            { nowMs: NOW_MS }
        );
        expect(results).toEqual([
            {
                streamId: 1,
                items: [
                    expect.objectContaining({
                        title: 'sample.news.us programme',
                        channel_id: 'sample.news.us',
                    }),
                ],
            },
        ]);
    });

    it('asks for "now" at the same provider clock as the id path under a display offset', async () => {
        offsetMinutes = 60;
        const fallback = TestBed.inject(XtreamXmltvFallbackService);

        const match = await fallback.matchChannelByName(channelName);
        await fallback.getCurrentProgramsBatch([match?.ids[0]]);

        expect(match?.ids).toEqual(['sample.news.us']);
        expect(bridge.getCurrentProgramsBatch).toHaveBeenCalledWith(
            ['sample.news.us'],
            { nowMs: NOW_MS - 60 * 60_000 }
        );
    });

    it('feeds the panel and guide schedule from the name match, without the provider', async () => {
        const items = await loadSchedule(null);

        expect(api.getFullEpg).not.toHaveBeenCalled();
        expect(bridge.getChannelPrograms).toHaveBeenCalledWith(
            'sample.news.us',
            { rejectOnError: true }
        );
        expect(items.map((item) => item.title)).toEqual([
            'sample.news.us programme',
        ]);
    });

    it('uses the category as the country hint of the name match', async () => {
        const items = await TestBed.inject(XtreamFullEpgService).load(
            credentials,
            1,
            null,
            { channelName: 'XY: SAMPLE CINEMA', categoryName: 'UK| MOVIES' }
        );
        expect(items[0].channel_id).toBe('samplecinema.uk');

        // Without a hint, one name in two countries is no answer.
        await expect(loadSchedule(null, 'XY: SAMPLE CINEMA')).resolves.toEqual(
            []
        );
    });

    it('keeps the manual mapping ahead of the name match', async () => {
        bridge.getEpgMapping.mockResolvedValue({
            epgChannelId: 'sample.missing',
        });

        await expect(loadSchedule(null)).resolves.toEqual([]);
        expect(bridge.getChannelPrograms).toHaveBeenCalledTimes(1);
        expect(bridge.getChannelPrograms).toHaveBeenCalledWith(
            'sample.missing',
            { rejectOnError: true }
        );
    });

    it('keeps the epg_channel_id XMLTV ahead of the name match', async () => {
        const items = await loadSchedule('sample.id.us');

        expect(items[0].channel_id).toBe('sample.id.us');
        expect(bridge.getEpgChannels).not.toHaveBeenCalled();
    });

    it('asks the provider when the name match has no schedule', async () => {
        const provider = [{ title: 'Provider now' } as EpgItem];
        api.getFullEpg.mockResolvedValue(provider);

        await expect(loadSchedule(null, 'Unmatched Name')).resolves.toBe(
            provider
        );
        bridge.getChannelPrograms.mockResolvedValue([]);
        await expect(loadSchedule(null)).resolves.toBe(provider);
        expect(api.getFullEpg).toHaveBeenCalledTimes(2);
    });

    it('keeps the provider schedule of an epg_channel_id ahead of the name match', async () => {
        const provider = [{ title: 'Provider now' } as EpgItem];
        api.getFullEpg.mockResolvedValue(provider);

        await expect(loadSchedule('sample.unknown')).resolves.toBe(provider);
        expect(bridge.getEpgChannels).not.toHaveBeenCalled();
    });

    it('keeps the provider error when neither the name nor the provider answers', async () => {
        const failure = new Error('provider down');
        api.getFullEpg.mockRejectedValue(failure);

        const items = await loadSchedule(null);
        expect(items[0].channel_id).toBe('sample.news.us');
        expect(api.getFullEpg).not.toHaveBeenCalled();

        await expect(loadSchedule(null, 'Unmatched Name')).rejects.toBe(
            failure
        );
    });

    it('with uploaded EPG preferred, reads id XMLTV, then provider, then the name match', async () => {
        preferUploaded = true;

        const items = await loadSchedule('sample.unknown');

        expect(bridge.getChannelPrograms.mock.calls.map(([id]) => id)).toEqual([
            'sample.unknown',
            'sample.news.us',
        ]);
        expect(api.getFullEpg).toHaveBeenCalledTimes(1);
        expect(
            bridge.getChannelPrograms.mock.invocationCallOrder[0]
        ).toBeLessThan(api.getFullEpg.mock.invocationCallOrder[0]);
        expect(items[0].channel_id).toBe('sample.news.us');
    });

    it('never matches a placeholder channel loosely', async () => {
        await expect(
            loadSchedule(null, 'US: Sample Filler HD')
        ).resolves.toEqual([]);
        expect(bridge.getChannelPrograms).not.toHaveBeenCalled();
    });

    it('does no XMLTV or name work with EPG turned off', async () => {
        await TestBed.inject(EpgPreferencesService).apply(false);
        const fallback = TestBed.inject(XtreamXmltvFallbackService);

        await expect(fallback.matchChannelByName(channelName)).resolves.toBe(
            null
        );
        await expect(
            fallback.matchChannelNames([{ channelName }])
        ).resolves.toEqual({ matches: [null], indexKey: 'unavailable' });
        await expect(loadSchedule(null)).resolves.toEqual([]);
        expect(bridge.getEpgChannels).not.toHaveBeenCalled();
        expect(bridge.getChannelPrograms).not.toHaveBeenCalled();
    });
});
