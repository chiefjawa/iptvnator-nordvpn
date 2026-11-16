import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import {
    XtreamApiService,
    XtreamUrlService,
    XtreamXmltvFallbackService,
} from '@iptvnator/portal/xtream/data-access';
import { StalkerSessionService } from '@iptvnator/portal/stalker/data-access';
import { EpgRuntimeBridgeService } from '@iptvnator/epg/data-access';
import {
    DataService,
    PlaylistsService,
    RuntimeCapabilitiesService,
    SettingsStore,
} from '@iptvnator/services';
import type { EpgProgram } from '@iptvnator/shared/interfaces';
import { UnifiedCollectionItem } from '@iptvnator/portal/shared/util';
import { StreamResolverService } from './stream-resolver.service';

/**
 * Collection, favourites and dashboard previews of an Xtream channel without
 * `epg_channel_id` and manual mapping read the XMLTV channel matched by name
 * before asking the provider.
 */
describe('StreamResolverService XMLTV name match', () => {
    const nowMs = Date.now();
    const item = {
        uid: 'xtream::xtream-1::1',
        name: 'XY: SAMPLE NEWS ᴿᴬᵂ',
        contentType: 'live',
        sourceType: 'xtream',
        playlistId: 'xtream-1',
        playlistName: 'Xtream',
        xtreamId: 1,
    } satisfies UnifiedCollectionItem;
    const programme = (channel: string, title: string): EpgProgram => ({
        channel,
        title,
        start: new Date(nowMs - 60_000).toISOString(),
        stop: new Date(nowMs + 60_000).toISOString(),
        desc: null,
        category: null,
    });

    let epgBridge: {
        supportsProgramLookup: boolean;
        getChannelPrograms: jest.Mock;
        getEpgMapping: jest.Mock;
        getEpgMappingsBatch: jest.Mock;
    };
    let xtreamApi: { getShortEpg: jest.Mock; getFullEpg: jest.Mock };
    let matchChannelByName: jest.Mock;
    let service: StreamResolverService;

    beforeEach(() => {
        epgBridge = {
            supportsProgramLookup: true,
            getChannelPrograms: jest.fn(async (id: string) =>
                id === 'samplenews.b.us' ? [programme(id, 'Named now')] : []
            ),
            getEpgMapping: jest.fn().mockResolvedValue(null),
            getEpgMappingsBatch: jest.fn().mockResolvedValue({}),
        };
        xtreamApi = {
            getShortEpg: jest.fn().mockResolvedValue([]),
            getFullEpg: jest.fn().mockResolvedValue([]),
        };
        matchChannelByName = jest.fn(async () => ({
            ids: ['samplenews.a.us', 'samplenews.b.us'],
            tier: 'name',
        }));

        TestBed.configureTestingModule({
            providers: [
                StreamResolverService,
                {
                    provide: PlaylistsService,
                    useValue: {
                        getPlaylistById: jest.fn(() =>
                            of({
                                _id: 'xtream-1',
                                serverUrl: 'https://xtream.example.com',
                                username: 'user',
                                password: 'pass',
                            })
                        ),
                    },
                },
                { provide: XtreamApiService, useValue: xtreamApi },
                {
                    provide: XtreamUrlService,
                    useValue: { constructLiveUrl: jest.fn() },
                },
                {
                    provide: XtreamXmltvFallbackService,
                    useValue: { matchChannelByName },
                },
                { provide: DataService, useValue: { sendIpcEvent: jest.fn() } },
                {
                    provide: SettingsStore,
                    useValue: { resolvedEpgOffsetMinutes: () => 0 },
                },
                { provide: EpgRuntimeBridgeService, useValue: epgBridge },
                {
                    provide: RuntimeCapabilitiesService,
                    useValue: { supportsProviderEpg: true },
                },
                {
                    provide: StalkerSessionService,
                    useValue: {
                        getCachedToken: jest.fn(() => null),
                        ensureToken: jest.fn(),
                        makeAuthenticatedRequest: jest.fn(),
                    },
                },
            ],
        });
        service = TestBed.inject(StreamResolverService);
    });

    async function previewTitle(
        row: UnifiedCollectionItem
    ): Promise<string | undefined> {
        const map = await service.loadEpgForItems([row]);
        return [...map.values()][0]?.title;
    }

    it('fills a list preview from the first matched candidate with a programme, without the provider', async () => {
        await expect(previewTitle(item)).resolves.toBe('Named now');

        expect(matchChannelByName).toHaveBeenCalledWith(item.name);
        expect(
            epgBridge.getChannelPrograms.mock.calls.map(([id]) => id)
        ).toEqual(['samplenews.a.us', 'samplenews.b.us']);
        expect(xtreamApi.getShortEpg).not.toHaveBeenCalled();
    });

    it('feeds the detail schedule from the name match before the provider', async () => {
        const items = await service.loadEpgItems(item);

        expect(items.map((entry) => entry.title)).toEqual(['Named now']);
        expect(xtreamApi.getFullEpg).not.toHaveBeenCalled();
    });

    it('leaves a channel with an epg_channel_id to its own guide', async () => {
        const withId = { ...item, epgChannelId: 'sample.id' };

        await service.loadEpgForItems([withId]);

        expect(matchChannelByName).not.toHaveBeenCalled();
        expect(xtreamApi.getShortEpg).toHaveBeenCalled();
    });

    it('never name-matches a manually mapped channel', async () => {
        epgBridge.getEpgMappingsBatch.mockResolvedValue({
            'xtream:xtream-1:1': 'sample.mapped',
        });

        await service.loadEpgForItems([item]);

        expect(matchChannelByName).not.toHaveBeenCalled();
        expect(epgBridge.getChannelPrograms).toHaveBeenCalledWith(
            'sample.mapped'
        );
    });

    it('asks the provider for a placeholder match or no match', async () => {
        matchChannelByName.mockResolvedValueOnce({
            ids: ['dummy-1'],
            tier: 'placeholder',
        });
        await service.loadEpgForItems([item]);
        expect(epgBridge.getChannelPrograms).not.toHaveBeenCalled();
        expect(xtreamApi.getShortEpg).toHaveBeenCalledTimes(1);

        matchChannelByName.mockResolvedValueOnce(null);
        await service.loadEpgItems(item);
        expect(xtreamApi.getFullEpg).toHaveBeenCalledTimes(1);
    });
});
