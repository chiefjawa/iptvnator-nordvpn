import { TestBed } from '@angular/core/testing';
import {
    EpgPreferencesService,
    EpgSourceSettingsService,
} from '@iptvnator/services';
import type { ElectronBridgeEpgProgress } from '@iptvnator/shared/interfaces';
import { XtreamEpgNameIndexService } from './xtream-epg-name-index.service';

describe('XtreamEpgNameIndexService', () => {
    const original = window.electron;
    let getEpgChannels: jest.Mock;
    let progressListeners: Array<(data: ElectronBridgeEpgProgress) => void>;

    function setChannels(channels: Array<{ id: string; displayName: string }>) {
        getEpgChannels.mockResolvedValue({ channels, programs: [] });
    }

    beforeEach(() => {
        progressListeners = [];
        getEpgChannels = jest.fn();
        setChannels([{ id: 'sample.news', displayName: 'Sample News' }]);
        Object.defineProperty(window, 'electron', {
            configurable: true,
            value: {
                getEpgChannels,
                onEpgProgress: (
                    callback: (data: ElectronBridgeEpgProgress) => void
                ) => progressListeners.push(callback),
            },
        });
        TestBed.configureTestingModule({});
    });

    afterEach(() => {
        Object.defineProperty(window, 'electron', {
            configurable: true,
            value: original,
        });
    });

    it('builds nothing until the first lookup and then reuses one index', async () => {
        const service = TestBed.inject(XtreamEpgNameIndexService);
        expect(getEpgChannels).not.toHaveBeenCalled();

        const [first, second] = await Promise.all([
            service.load(),
            service.load(),
        ]);
        const third = await service.load();

        expect(getEpgChannels).toHaveBeenCalledTimes(1);
        expect(first).toBe(second);
        expect(third).toBe(first);
        expect(first?.resolve('US: Sample News HD')).toBe('sample.news');
    });

    it('rebuilds after an EPG source revision', async () => {
        const service = TestBed.inject(XtreamEpgNameIndexService);
        await service.load();
        setChannels([{ id: 'sample.other', displayName: 'Sample News' }]);

        TestBed.inject(EpgSourceSettingsService).revision.update(
            (revision) => revision + 1
        );
        const index = await service.load();

        expect(getEpgChannels).toHaveBeenCalledTimes(2);
        expect(index?.resolve('Sample News')).toBe('sample.other');
    });

    it('rebuilds after a completed XMLTV import, not on other progress', async () => {
        const service = TestBed.inject(XtreamEpgNameIndexService);
        await service.load();
        expect(progressListeners).toHaveLength(1);

        progressListeners[0]({
            url: 'https://guide.example/epg.xml',
            status: 'loading',
        });
        await service.load();
        expect(getEpgChannels).toHaveBeenCalledTimes(1);

        setChannels([{ id: 'sample.late', displayName: 'Sample Late' }]);
        progressListeners[0]({
            url: 'https://guide.example/epg.xml',
            status: 'complete',
        });
        const index = await service.load();
        expect(getEpgChannels).toHaveBeenCalledTimes(2);
        expect(index?.resolve('Sample Late')).toBe('sample.late');
        // The listener is registered once.
        expect(progressListeners).toHaveLength(1);
    });

    it('retries after a failed channel read instead of caching the failure', async () => {
        const service = TestBed.inject(XtreamEpgNameIndexService);
        getEpgChannels.mockRejectedValueOnce(new Error('db busy'));

        await expect(service.load()).resolves.toBeNull();
        const index = await service.load();

        expect(getEpgChannels).toHaveBeenCalledTimes(2);
        expect(index?.resolve('Sample News')).toBe('sample.news');
    });

    it('answers null without a bridge or with EPG turned off', async () => {
        const service = TestBed.inject(XtreamEpgNameIndexService);
        await TestBed.inject(EpgPreferencesService).apply(false);

        await expect(service.load()).resolves.toBeNull();
        expect(getEpgChannels).not.toHaveBeenCalled();

        Object.defineProperty(window, 'electron', {
            configurable: true,
            value: {},
        });
        await TestBed.inject(EpgPreferencesService).apply(true);
        await expect(service.load()).resolves.toBeNull();
    });
});
