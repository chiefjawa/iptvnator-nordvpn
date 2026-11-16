import { inject, Injectable } from '@angular/core';
import { RuntimeCapabilitiesService, SettingsStore } from '@iptvnator/services';
import {
    buildXtreamEpgMappingKey,
    EpgItem,
} from '@iptvnator/shared/interfaces';
import {
    XtreamApiService,
    XtreamCredentials,
    XtreamRequestOptions,
} from './xtream-api.service';
import { XtreamXmltvFallbackService } from './xtream-xmltv-fallback.service';

@Injectable({ providedIn: 'root' })
export class XtreamFullEpgService {
    private readonly api = inject(XtreamApiService);
    private readonly xmltv = inject(XtreamXmltvFallbackService);
    private readonly runtime = inject(RuntimeCapabilitiesService);
    private readonly settings = inject(SettingsStore);

    async load(
        { id, ...credentials }: XtreamCredentials & { id?: string },
        streamId: number,
        epgChannelId: string | null,
        {
            channelName,
            categoryName,
            ...options
        }: Pick<XtreamRequestOptions, 'signal' | 'sessionId'> & {
            /** Playlist channel name for the automatic XMLTV name match. */
            channelName?: string | null;
            /** Its playlist category name, a country hint for that match. */
            categoryName?: string | null;
        } = {}
    ): Promise<EpgItem[]> {
        options.signal?.throwIfAborted();
        const preferUploaded =
            this.settings.preferUploadedEpgOverXtream?.() ?? false;
        let mapped = false;
        if (this.runtime.supportsEpgMapping && id) {
            try {
                const mapping = await window.electron?.getEpgMapping?.(
                    buildXtreamEpgMappingKey(id, streamId)
                );
                const mappedId = mapping?.epgChannelId?.trim();
                mapped = Boolean(mappedId);
                epgChannelId = mappedId || epgChannelId;
            } catch {
                // Keep the provider's EPG identifier if mapping lookup fails.
            }
        }

        return this.xmltv.resolveCurrentEpg({
            epgChannelId,
            preferUploaded,
            signal: options.signal,
            channelName,
            categoryName,
            mapped,
            fetchProvider: () =>
                this.api.getFullEpg(credentials, streamId, {
                    ...options,
                    suppressErrorLog: true,
                }),
        });
    }
}
