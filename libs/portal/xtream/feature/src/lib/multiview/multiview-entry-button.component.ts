import {
    ChangeDetectionStrategy,
    Component,
    inject,
    input,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Router } from '@angular/router';

/** Path of the route that owns one Xtream playlist's pages. */
const PLAYLIST_ROUTE_PATH = 'xtreams/:id';

/** Opens the playlist's multiview from the live TV page. */
@Component({
    selector: 'app-multiview-entry-button',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [MatButtonModule, MatIcon, MatTooltipModule],
    template: `
        <button
            mat-icon-button
            type="button"
            data-test-id="open-multiview"
            [attr.aria-label]="label()"
            [matTooltip]="label()"
            (click)="open()"
        >
            <mat-icon>grid_view</mat-icon>
        </button>
    `,
})
export class MultiviewEntryButtonComponent {
    /** Translated by the host, which owns the page's translation setup. */
    readonly label = input.required<string>();

    private readonly router = inject(Router);
    private readonly route = inject(ActivatedRoute);

    open(): void {
        // The live page is reached as `live` and as `live/:categoryId`, so
        // the target is resolved from the playlist route, not from here.
        let playlistRoute: ActivatedRoute | null = this.route;
        while (
            playlistRoute &&
            playlistRoute.routeConfig?.path !== PLAYLIST_ROUTE_PATH
        ) {
            playlistRoute = playlistRoute.parent;
        }
        if (playlistRoute) {
            void this.router.navigate(['live', 'multiview'], {
                relativeTo: playlistRoute,
            });
        }
    }
}
