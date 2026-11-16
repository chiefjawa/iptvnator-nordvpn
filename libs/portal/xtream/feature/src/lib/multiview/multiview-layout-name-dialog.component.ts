import {
    ChangeDetectionStrategy,
    Component,
    computed,
    inject,
    signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import {
    MAT_DIALOG_DATA,
    MatDialogModule,
    MatDialogRef,
} from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslatePipe } from '@ngx-translate/core';
import {
    DialogFooterDirective,
    DialogShellComponent,
} from '@iptvnator/ui/components';
import {
    MAX_MULTIVIEW_LAYOUT_NAME,
    normalizeLayoutName,
} from './multiview-layouts';

export interface MultiviewLayoutNameDialogData {
    readonly mode: 'save' | 'rename';
    readonly name: string;
    /** Names already used, compared case-insensitively. */
    readonly takenNames: readonly string[];
}

/** Asks for a layout name; closes with the name, or undefined. */
@Component({
    selector: 'app-multiview-layout-name-dialog',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        DialogFooterDirective,
        DialogShellComponent,
        MatButtonModule,
        MatDialogModule,
        MatFormFieldModule,
        MatInputModule,
        TranslatePipe,
    ],
    template: `
        <form novalidate (submit)="$event.preventDefault(); submit()">
            <app-dialog-shell
                icon="dashboard_customize"
                [heading]="
                    (data.mode === 'save'
                        ? 'MULTIVIEW.LAYOUTS.SAVE_TITLE'
                        : 'MULTIVIEW.LAYOUTS.RENAME_TITLE'
                    ) | translate
                "
            >
                <mat-form-field appearance="outline" subscriptSizing="dynamic">
                    <mat-label>{{
                        'MULTIVIEW.LAYOUTS.NAME_LABEL' | translate
                    }}</mat-label>
                    <input
                        matInput
                        name="layoutName"
                        data-test-id="multiview-layout-name"
                        cdkFocusInitial
                        autocomplete="off"
                        [attr.maxlength]="maxLength"
                        [value]="name()"
                        (input)="onInput($event)"
                    />
                    @if (overwrites()) {
                        <mat-hint>{{
                            'MULTIVIEW.LAYOUTS.OVERWRITE_HINT' | translate
                        }}</mat-hint>
                    }
                </mat-form-field>
                <div appDialogFooter>
                    <button mat-button type="button" mat-dialog-close>
                        {{ 'CANCEL' | translate }}
                    </button>
                    <button
                        mat-flat-button
                        type="submit"
                        data-test-id="multiview-layout-name-submit"
                        [disabled]="!valid()"
                    >
                        {{
                            (data.mode === 'save'
                                ? 'MULTIVIEW.LAYOUTS.SAVE'
                                : 'MULTIVIEW.LAYOUTS.RENAME'
                            ) | translate
                        }}
                    </button>
                </div>
            </app-dialog-shell>
        </form>
    `,
    styles: `
        mat-form-field {
            width: 100%;
        }
    `,
})
export class MultiviewLayoutNameDialogComponent {
    readonly data = inject<MultiviewLayoutNameDialogData>(MAT_DIALOG_DATA);
    private readonly dialogRef = inject(
        MatDialogRef<MultiviewLayoutNameDialogComponent, string>
    );

    readonly maxLength = MAX_MULTIVIEW_LAYOUT_NAME;
    readonly name = signal(this.data.name);
    private readonly normalized = computed(() =>
        normalizeLayoutName(this.name())
    );
    private readonly taken = computed(() => {
        const name = this.normalized().toLocaleLowerCase();
        return this.data.takenNames.some(
            (taken) => taken.toLocaleLowerCase() === name
        );
    });
    /** Saving under an existing name replaces that layout. */
    readonly overwrites = computed(
        () => this.data.mode === 'save' && this.taken()
    );
    readonly valid = computed(
        () =>
            this.normalized().length > 0 &&
            (this.data.mode === 'save' || !this.taken())
    );

    onInput(event: Event): void {
        this.name.set((event.target as HTMLInputElement).value);
    }

    submit(): void {
        if (this.valid()) {
            this.dialogRef.close(this.normalized());
        }
    }
}
