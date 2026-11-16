import {
    AfterViewInit,
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    computed,
    input,
    output,
    signal,
    viewChild,
} from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';

export interface MultiviewChannel {
    readonly xtreamId: number;
    readonly title: string;
    readonly logo: string | null;
}

/** Rows rendered at once; a playlist can hold tens of thousands of channels. */
const MAX_RESULTS = 100;

/** Search-and-pick panel for choosing a multiview tile's channel. */
@Component({
    selector: 'app-multiview-channel-picker',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [MatIcon, TranslatePipe],
    templateUrl: './multiview-channel-picker.component.html',
    styleUrl: './multiview-channel-picker.component.scss',
    host: { '(keydown.escape)': 'closed.emit()' },
})
export class MultiviewChannelPickerComponent implements AfterViewInit {
    readonly channels = input.required<readonly MultiviewChannel[]>();

    readonly picked = output<MultiviewChannel>();
    readonly closed = output<void>();

    readonly limit = MAX_RESULTS;
    readonly term = signal('');
    private readonly searchInput =
        viewChild.required<ElementRef<HTMLInputElement>>('search');

    private readonly matches = computed(() => {
        const term = this.term().trim().toLowerCase();
        const channels = this.channels();
        if (!term) {
            return channels;
        }
        return channels.filter((channel) =>
            channel.title.toLowerCase().includes(term)
        );
    });

    readonly results = computed(() => this.matches().slice(0, MAX_RESULTS));
    readonly truncated = computed(() => this.matches().length > MAX_RESULTS);

    ngAfterViewInit(): void {
        this.searchInput().nativeElement.focus();
    }

    onSearch(event: Event): void {
        this.term.set((event.target as HTMLInputElement).value);
    }
}
