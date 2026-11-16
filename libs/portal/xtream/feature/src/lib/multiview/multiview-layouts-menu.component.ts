import {
    ChangeDetectionStrategy,
    Component,
    input,
    output,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDivider } from '@angular/material/divider';
import { MatIcon } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslatePipe } from '@ngx-translate/core';
import { MultiviewLayout } from './multiview-layouts';

/**
 * The multiview header's layouts button: switch to a saved layout in one
 * click, save the current tiles, rename or delete a layout.
 */
@Component({
    selector: 'app-multiview-layouts-menu',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        MatButtonModule,
        MatDivider,
        MatIcon,
        MatMenuModule,
        MatTooltipModule,
        TranslatePipe,
    ],
    template: `
        <button
            mat-icon-button
            type="button"
            data-test-id="multiview-layouts"
            [attr.aria-label]="'MULTIVIEW.LAYOUTS.MENU' | translate"
            [matTooltip]="'MULTIVIEW.LAYOUTS.MENU' | translate"
            [matMenuTriggerFor]="menu"
        >
            <mat-icon>dashboard_customize</mat-icon>
        </button>

        <mat-menu #menu="matMenu">
            @for (layout of layouts(); track layout.name) {
                <button
                    mat-menu-item
                    type="button"
                    data-test-id="multiview-layout-apply"
                    [attr.aria-current]="
                        layout.name === activeName() ? 'true' : null
                    "
                    (click)="applied.emit(layout)"
                >
                    <mat-icon>{{
                        layout.name === activeName() ? 'check' : 'grid_view'
                    }}</mat-icon>
                    <span>{{ layout.name }}</span>
                </button>
            } @empty {
                <p class="multiview-layouts__empty">
                    {{ 'MULTIVIEW.LAYOUTS.EMPTY' | translate }}
                </p>
            }
            <mat-divider />
            <button
                mat-menu-item
                type="button"
                data-test-id="multiview-layout-save"
                [disabled]="!canSave()"
                (click)="saveRequested.emit()"
            >
                <mat-icon>bookmark_add</mat-icon>
                <span>{{ 'MULTIVIEW.LAYOUTS.SAVE_CURRENT' | translate }}</span>
            </button>
            @if (layouts().length > 0) {
                <button
                    mat-menu-item
                    type="button"
                    data-test-id="multiview-layout-rename-menu"
                    [matMenuTriggerFor]="renameMenu"
                >
                    <mat-icon>edit</mat-icon>
                    <span>{{ 'MULTIVIEW.LAYOUTS.RENAME' | translate }}</span>
                </button>
                <button
                    mat-menu-item
                    type="button"
                    data-test-id="multiview-layout-delete-menu"
                    [matMenuTriggerFor]="deleteMenu"
                >
                    <mat-icon>delete</mat-icon>
                    <span>{{ 'MULTIVIEW.LAYOUTS.DELETE' | translate }}</span>
                </button>
            }
        </mat-menu>

        <mat-menu #renameMenu="matMenu">
            @for (layout of layouts(); track layout.name) {
                <button
                    mat-menu-item
                    type="button"
                    data-test-id="multiview-layout-rename"
                    (click)="renameRequested.emit(layout)"
                >
                    {{ layout.name }}
                </button>
            }
        </mat-menu>

        <mat-menu #deleteMenu="matMenu">
            @for (layout of layouts(); track layout.name) {
                <button
                    mat-menu-item
                    type="button"
                    data-test-id="multiview-layout-delete"
                    (click)="deleteRequested.emit(layout)"
                >
                    {{ layout.name }}
                </button>
            }
        </mat-menu>
    `,
    styles: `
        :host {
            display: inline-flex;
            flex: none;
            app-region: no-drag;
        }

        .multiview-layouts__empty {
            max-width: 240px;
            margin: 0;
            padding: 8px 16px;
            color: var(--app-eyebrow-color);
            font-size: 13px;
        }
    `,
})
export class MultiviewLayoutsMenuComponent {
    readonly layouts = input.required<readonly MultiviewLayout[]>();
    /** The layout the grid shows right now, if any. */
    readonly activeName = input<string | null>(null);
    readonly canSave = input(false);

    readonly applied = output<MultiviewLayout>();
    readonly saveRequested = output<void>();
    readonly renameRequested = output<MultiviewLayout>();
    readonly deleteRequested = output<MultiviewLayout>();
}
