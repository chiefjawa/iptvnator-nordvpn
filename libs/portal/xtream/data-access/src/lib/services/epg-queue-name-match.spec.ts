import { TestBed } from '@angular/core/testing';
import { EpgPreferencesService, SettingsStore } from '@iptvnator/services';
import type { EpgItem } from '@iptvnator/shared/interfaces';
import { EpgQueueService } from './epg-queue.service';
import { XtreamApiService } from './xtream-api.service';
import { XtreamXmltvFallbackService } from './xtream-xmltv-fallback.service';

/**
 * Row previews: the XMLTV name match is the last resort after a manual
 * mapping, the provider's `epg_channel_id` and the provider API.
 */
describe('EpgQueueService name match', () => {
    const original = window.electron;
    let service: EpgQueueService;
    let getShortEpg: jest.Mock;
    let getCurrentProgramsBatch: jest.Mock;
    let matchChannelsByName: jest.Mock;
    let getEpgMappingsBatch: jest.Mock;
    let preferUploaded: boolean;

    const credentials = {
        serverUrl: 'https://xtream.example.com',
        username: 'user',
        password: 'pass',
    };
    const named = {
        streamId: 1,
        epgChannelId: null,
        playlistId: 'playlist-1',
        channelName: 'US: Sample News ᴿᴬᵂ',
    };

    beforeEach(() => {
        jest.useFakeTimers();
        preferUploaded = false;
        getShortEpg = jest.fn().mockResolvedValue([]);
        getCurrentProgramsBatch = jest.fn(async (ids: string[]) =>
            Object.fromEntries(ids.map((id) => [id, item(id, `${id} (XMLTV)`)]))
        );
        matchChannelsByName = jest.fn(
            async (names: string[]) =>
                new Map(names.map((name) => [name, 'sample.news']))
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
                    useValue: { getCurrentProgramsBatch, matchChannelsByName },
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

    async function enqueueAndSettle(
        entries: Parameters<EpgQueueService['enqueue']>[0]
    ): Promise<void> {
        const visible = new Set(
            entries.map((entry) =>
                typeof entry === 'number' ? entry : entry.streamId
            )
        );
        await service.enqueue(entries, visible, credentials);
        await jest.advanceTimersByTimeAsync(1000);
    }

    it('uses the name-matched XMLTV programme when the provider has none', async () => {
        await enqueueAndSettle([named]);

        expect(matchChannelsByName).toHaveBeenCalledWith([named.channelName]);
        expect(getShortEpg).toHaveBeenCalledTimes(1);
        expect(service.getCached(1)?.[0].title).toBe('sample.news (XMLTV)');
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
            'sample.news',
        ]);
        expect(matchChannelsByName).toHaveBeenCalledTimes(1);
    });

    it('keeps the provider programme over the name match', async () => {
        getShortEpg.mockResolvedValue([item('provider', 'Provider now')]);

        await enqueueAndSettle([named]);

        expect(service.getCached(1)?.[0].title).toBe('Provider now');
    });

    it('keeps the epg_channel_id programme over the name match', async () => {
        await enqueueAndSettle([{ ...named, epgChannelId: 'sample.id' }]);

        expect(service.getCached(1)?.[0].title).toBe('sample.id (XMLTV)');
    });

    it('never name-matches a manually mapped channel', async () => {
        getEpgMappingsBatch.mockResolvedValue({
            'xtream:playlist-1:1': 'sample.mapped',
        });
        getCurrentProgramsBatch.mockResolvedValue({});

        await enqueueAndSettle([named]);

        expect(matchChannelsByName).not.toHaveBeenCalled();
        expect(getCurrentProgramsBatch).toHaveBeenCalledWith(['sample.mapped']);
        expect(service.getCached(1)).toEqual([]);
    });

    it('still asks the provider first when uploaded EPG is preferred', async () => {
        preferUploaded = true;

        await enqueueAndSettle([named]);

        expect(getShortEpg).toHaveBeenCalledTimes(1);
        expect(service.getCached(1)?.[0].title).toBe('sample.news (XMLTV)');
    });

    it('answers from the epg_channel_id XMLTV without the provider when uploaded EPG is preferred', async () => {
        preferUploaded = true;

        await enqueueAndSettle([{ ...named, epgChannelId: 'sample.id' }]);

        expect(getShortEpg).not.toHaveBeenCalled();
        expect(service.getCached(1)?.[0].title).toBe('sample.id (XMLTV)');
    });

    it('does nothing with EPG turned off', async () => {
        await TestBed.inject(EpgPreferencesService).apply(false);

        await enqueueAndSettle([named]);

        expect(matchChannelsByName).not.toHaveBeenCalled();
        expect(getCurrentProgramsBatch).not.toHaveBeenCalled();
        expect(getShortEpg).not.toHaveBeenCalled();
        expect(service.getCached(1)).toBeNull();
    });

    it('drops the name preview with the rest of the stream state on invalidate', async () => {
        await enqueueAndSettle([named]);
        expect(service.getCached(1)).not.toBeNull();

        matchChannelsByName.mockResolvedValue(new Map());
        service.invalidate(1);
        await enqueueAndSettle([named]);

        expect(service.getCached(1)).toEqual([]);
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
