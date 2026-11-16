import {
    ChangeDetectionStrategy,
    Component,
    DestroyRef,
    computed,
    effect,
    inject,
    signal,
    untracked,
    viewChildren,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import {
    XtreamStore,
    XtreamUrlService,
} from '@iptvnator/portal/xtream/data-access';
import { SettingsStore } from '@iptvnator/services';
import { StreamFormat } from '@iptvnator/shared/interfaces';
import {
    MultiplexSessionService,
    MultiviewTileComponent,
    MultiviewTilePlayback,
} from '@iptvnator/ui/playback';
import {
    MultiviewChannel,
    MultiviewChannelPickerComponent,
} from './multiview-channel-picker.component';
import { createMultiviewLayouts } from './multiview-layouts.controller';
import { MultiviewLayoutsMenuComponent } from './multiview-layouts-menu.component';
import {
    readSavedMultiviewChannels,
    saveMultiviewChannels,
} from './multiview-persistence';

const MAX_TILES = 4;
const PROGRESS_INTERVAL_MS = 500;

interface MultiviewTile {
    readonly id: string;
    readonly channel: MultiviewChannel;
    /** Null until the tile's stream URL is ready. */
    readonly playback: MultiviewTilePlayback | null;
}

interface LiveStreamLike {
    readonly xtream_id?: number;
    readonly title?: string;
    readonly name?: string;
    readonly poster_url?: string;
    readonly stream_icon?: string;
}

/**
 * Multiview for an Xtream playlist: up to four live channels side by side.
 *
 * With connection multiplexing on, every tile plays from the local relay and
 * the main process rotates one provider connection between them. Otherwise
 * each tile opens its own connection, as far as the account allows.
 */
@Component({
    selector: 'app-xtream-multiview',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        MatButtonModule,
        MatIcon,
        MultiviewChannelPickerComponent,
        MultiviewLayoutsMenuComponent,
        MultiviewTileComponent,
        RouterLink,
        TranslatePipe,
    ],
    providers: [MultiplexSessionService],
    templateUrl: './xtream-multiview.component.html',
    styleUrl: './xtream-multiview.component.scss',
})
export class XtreamMultiviewComponent {
    private readonly xtreamStore = inject(XtreamStore);
    private readonly xtreamUrlService = inject(XtreamUrlService);
    private readonly settingsStore = inject(SettingsStore);
    private readonly session = inject(MultiplexSessionService);
    private readonly tileComponents = viewChildren(MultiviewTileComponent);
    private nextTileNumber = 1;
    private restoredFor: string | null = null;

    readonly maxTiles = MAX_TILES;
    readonly tiles = signal<MultiviewTile[]>([]);
    readonly focusedId = signal<string | null>(null);
    /** Open picker: the tile being replaced, or 'new' for an added tile. */
    readonly pickerTarget = signal<string | null>(null);
    readonly statuses = this.session.statuses;

    /** Tiles share one connection (setting on and the desktop shell has it). */
    readonly sharing = computed(
        () =>
            this.settingsStore.connectionMultiplexing?.() === true &&
            this.session.available
    );
    readonly canEnableSharing = computed(
        () => this.session.available && !this.sharing()
    );
    readonly canAdd = computed(() => this.tiles().length < MAX_TILES);

    readonly channels = computed<MultiviewChannel[]>(() =>
        (this.xtreamStore.liveStreams() as unknown as LiveStreamLike[])
            .filter((item) => typeof item.xtream_id === 'number')
            .map((item) => ({
                xtreamId: item.xtream_id as number,
                title: item.title ?? item.name ?? '',
                logo: item.poster_url ?? item.stream_icon ?? null,
            }))
    );

    readonly layouts = createMultiviewLayouts<MultiviewChannel>({
        playlistId: computed(() => this.xtreamStore.currentPlaylist()?.id ?? null),
        tileIds: computed(() =>
            this.tiles().map((tile) => tile.channel.xtreamId)
        ),
        channelsById: computed(
            () =>
                new Map(
                    this.channels().map((channel) => [channel.xtreamId, channel])
                )
        ),
        show: (channels) => this.showChannels(channels),
    });

    constructor() {
        // Bring back the last set of tiles once the channel list is loaded.
        effect(() => {
            const playlistId = this.xtreamStore.currentPlaylist()?.id;
            const channels = this.channels();
            if (!playlistId || channels.length === 0) {
                return;
            }
            untracked(() => this.restore(playlistId, channels));
        });

        const timer = setInterval(
            () => this.reportProgress(),
            PROGRESS_INTERVAL_MS
        );
        inject(DestroyRef).onDestroy(() => clearInterval(timer));
    }

    openPicker(target: string): void {
        this.pickerTarget.set(target);
    }

    async onPicked(channel: MultiviewChannel): Promise<void> {
        const target = this.pickerTarget();
        this.pickerTarget.set(null);
        if (target && target !== 'new') {
            await this.replaceTile(target, channel);
        } else {
            await this.addTile(channel);
        }
        this.persist();
    }

    async removeTile(tileId: string): Promise<void> {
        this.tiles.update((tiles) => tiles.filter((tile) => tile.id !== tileId));
        if (this.focusedId() === tileId) {
            this.focusedId.set(this.tiles()[0]?.id ?? null);
        }
        this.persist();
        await this.session.removeTile(tileId).catch(() => undefined);
    }

    /**
     * Shows exactly these channels, in order. Tiles already showing one of
     * them keep playing (and keep their reserve); the rest are replaced.
     */
    private async showChannels(channels: MultiviewChannel[]): Promise<void> {
        const pool = [...this.tiles()];
        const kept = new Set<MultiviewTile>();
        const next = channels.slice(0, MAX_TILES).map((channel) => {
            const index = pool.findIndex(
                (tile) => tile.channel.xtreamId === channel.xtreamId
            );
            if (index < 0) {
                return this.createTile(channel);
            }
            const [tile] = pool.splice(index, 1);
            kept.add(tile);
            return tile;
        });
        this.tiles.set(next);
        if (!next.some((tile) => tile.id === this.focusedId())) {
            this.focusedId.set(next[0]?.id ?? null);
        }
        this.persist();
        await Promise.all(
            pool.map((tile) =>
                this.session.removeTile(tile.id).catch(() => undefined)
            )
        );
        for (const tile of next) {
            if (!kept.has(tile)) {
                await this.startTile(tile);
            }
        }
    }

    private async addTile(channel: MultiviewChannel): Promise<void> {
        if (!this.canAdd()) {
            return;
        }
        const tile = this.createTile(channel);
        this.tiles.update((tiles) => [...tiles, tile]);
        this.focusedId.update((focused) => focused ?? tile.id);
        await this.startTile(tile);
    }

    /** A replaced tile gets a new id, so its player starts from scratch. */
    private async replaceTile(
        tileId: string,
        channel: MultiviewChannel
    ): Promise<void> {
        const tile = this.createTile(channel);
        this.tiles.update((tiles) =>
            tiles.map((existing) => (existing.id === tileId ? tile : existing))
        );
        if (this.focusedId() === tileId) {
            this.focusedId.set(tile.id);
        }
        await this.session.removeTile(tileId).catch(() => undefined);
        await this.startTile(tile);
    }

    private createTile(channel: MultiviewChannel): MultiviewTile {
        const id = `tile-${this.nextTileNumber}`;
        this.nextTileNumber += 1;
        return { id, channel, playback: null };
    }

    private async startTile(tile: MultiviewTile): Promise<void> {
        const playback = await this.resolvePlayback(tile);
        this.tiles.update((tiles) =>
            tiles.map((existing) =>
                existing.id === tile.id ? { ...existing, playback } : existing
            )
        );
    }

    private async resolvePlayback(
        tile: MultiviewTile
    ): Promise<MultiviewTilePlayback | null> {
        const playlist = this.xtreamStore.currentPlaylist();
        if (!playlist) {
            return null;
        }

        // Falls back to another format when the account does not offer TS.
        const tsUrl = this.xtreamUrlService.constructLiveUrl(
            playlist,
            tile.channel.xtreamId,
            StreamFormat.TsStreamFormat
        );
        const offersTs = tsUrl.endsWith('.ts');

        if (this.sharing() && offersTs) {
            try {
                const url = await this.session.setTile(tile.id, {
                    url: tsUrl,
                    groupKey: playlist.id,
                    userAgent: playlist.userAgent,
                    referer: playlist.referrer,
                    origin: playlist.origin,
                });
                return { url, kind: 'mpegts', shared: true };
            } catch {
                // Fall through to a direct connection for this tile.
            }
        }

        const url = offersTs
            ? tsUrl
            : this.xtreamUrlService.constructLiveUrl(
                  playlist,
                  tile.channel.xtreamId
              );
        return url
            ? { url, kind: offersTs ? 'mpegts' : 'hls', shared: false }
            : null;
    }

    private restore(playlistId: string, channels: MultiviewChannel[]): void {
        if (this.restoredFor === playlistId) {
            return;
        }
        this.restoredFor = playlistId;
        const byId = new Map(channels.map((channel) => [channel.xtreamId, channel]));
        const saved = readSavedMultiviewChannels(playlistId)
            .map((xtreamId) => byId.get(xtreamId))
            .filter((channel): channel is MultiviewChannel => !!channel)
            .slice(0, MAX_TILES);
        void (async () => {
            for (const channel of saved) {
                await this.addTile(channel);
            }
        })();
    }

    private persist(): void {
        const playlistId = this.xtreamStore.currentPlaylist()?.id;
        if (playlistId) {
            saveMultiviewChannels(
                playlistId,
                this.tiles().map((tile) => tile.channel.xtreamId)
            );
        }
    }

    private reportProgress(): void {
        const reports = this.tileComponents()
            .filter((tile) => tile.playback()?.shared)
            .map((tile) => tile.progress());
        this.session.reportProgress(reports);
    }
}
