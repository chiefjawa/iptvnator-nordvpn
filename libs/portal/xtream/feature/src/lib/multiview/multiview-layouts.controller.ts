import { computed, inject, signal, Signal } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslateService } from '@ngx-translate/core';
import { DialogService } from '@iptvnator/ui/components';
import { dialogSize } from '@iptvnator/ui/components/dialog-size';
import { firstValueFrom } from 'rxjs';
import {
    MultiviewLayoutNameDialogComponent,
    MultiviewLayoutNameDialogData,
} from './multiview-layout-name-dialog.component';
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

export interface MultiviewLayoutsHost<T> {
    readonly playlistId: Signal<string | null>;
    /** Stream ids of the tiles on screen, in order. */
    readonly tileIds: Signal<readonly number[]>;
    readonly channelsById: Signal<ReadonlyMap<number, T>>;
    /** Replaces every tile with these channels. */
    show(channels: T[]): Promise<void>;
}

const NOTICE_MS = 5000;

/**
 * Saved layouts of the multiview screen. Create it in a field initializer
 * (an injection context) with `createMultiviewLayouts()`.
 */
export class MultiviewLayoutsController<T> {
    private readonly dialog = inject(MatDialog);
    private readonly dialogService = inject(DialogService);
    private readonly snackBar = inject(MatSnackBar);
    private readonly translate = inject(TranslateService);
    /** Bumped on every write, so `layouts` rereads storage. */
    private readonly revision = signal(0);

    readonly layouts = computed<MultiviewLayout[]>(() => {
        this.revision();
        const playlistId = this.host.playlistId();
        return playlistId ? readMultiviewLayouts(playlistId) : [];
    });

    readonly activeName = computed(() => {
        const ids = this.host.tileIds();
        return (
            this.layouts().find((layout) => layoutMatches(layout, ids))?.name ??
            null
        );
    });

    readonly canSave = computed(() => this.host.tileIds().length > 0);

    constructor(private readonly host: MultiviewLayoutsHost<T>) {}

    async apply(layout: MultiviewLayout): Promise<void> {
        const { channels, missing } = resolveLayoutChannels(
            layout,
            this.host.channelsById()
        );
        if (missing > 0) {
            this.notify(
                channels.length === 0
                    ? 'MULTIVIEW.LAYOUTS.ALL_MISSING'
                    : 'MULTIVIEW.LAYOUTS.SOME_MISSING',
                { name: layout.name, count: missing }
            );
        }
        if (channels.length > 0) {
            await this.host.show(channels);
        }
    }

    async save(): Promise<void> {
        const layouts = this.layouts();
        const name = await this.askName({
            mode: 'save',
            name: this.activeName() ?? '',
            takenNames: layouts.map((layout) => layout.name),
        });
        if (!name) {
            return;
        }
        const result = saveLayout(layouts, name, this.host.tileIds());
        if (result.error === 'full') {
            this.notify('MULTIVIEW.LAYOUTS.FULL', {
                count: MAX_MULTIVIEW_LAYOUTS,
            });
            return;
        }
        this.write(result.layouts);
    }

    async rename(layout: MultiviewLayout): Promise<void> {
        const layouts = this.layouts();
        const name = await this.askName({
            mode: 'rename',
            name: layout.name,
            takenNames: layouts
                .filter((item) => item.name !== layout.name)
                .map((item) => item.name),
        });
        const renamed = name ? renameLayout(layouts, layout.name, name) : null;
        if (renamed) {
            this.write(renamed);
        }
    }

    remove(layout: MultiviewLayout): Promise<void> {
        return this.dialogService.openConfirmDialog({
            title: this.translate.instant('MULTIVIEW.LAYOUTS.DELETE_TITLE'),
            message: this.translate.instant('MULTIVIEW.LAYOUTS.DELETE_MESSAGE', {
                name: layout.name,
            }),
            confirmLabel: this.translate.instant('MULTIVIEW.LAYOUTS.DELETE'),
            tone: 'destructive',
            onConfirm: () =>
                this.write(deleteLayout(this.layouts(), layout.name)),
        });
    }

    private async askName(
        data: MultiviewLayoutNameDialogData
    ): Promise<string | undefined> {
        const ref = this.dialog.open<
            MultiviewLayoutNameDialogComponent,
            MultiviewLayoutNameDialogData,
            string
        >(MultiviewLayoutNameDialogComponent, { ...dialogSize('sm'), data });
        return firstValueFrom(ref.afterClosed());
    }

    private write(layouts: MultiviewLayout[]): void {
        const playlistId = this.host.playlistId();
        if (playlistId) {
            writeMultiviewLayouts(playlistId, layouts);
            this.revision.update((value) => value + 1);
        }
    }

    private notify(key: string, params: Record<string, unknown>): void {
        this.snackBar.open(this.translate.instant(key, params), undefined, {
            duration: NOTICE_MS,
        });
    }
}

export function createMultiviewLayouts<T>(
    host: MultiviewLayoutsHost<T>
): MultiviewLayoutsController<T> {
    return new MultiviewLayoutsController(host);
}
