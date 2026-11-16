import {
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    OnDestroy,
    computed,
    effect,
    input,
    output,
    signal,
    viewChild,
} from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import {
    MultiplexTileProgress,
    MultiplexTileStatus,
} from '@iptvnator/shared/interfaces';
import {
    MultiviewTileEngine,
    MultiviewTileSourceKind,
} from './multiview-tile-engine';

export interface MultiviewTilePlayback {
    readonly url: string;
    readonly kind: MultiviewTileSourceKind;
    /** Fed by the shared connection (bursts with pauses in between). */
    readonly shared: boolean;
}

/** A tile that ran dry resumes once it has rebuilt at least this much. */
const DEFAULT_RESUME_SEC = 3;
const DRY_BELOW_SEC = 0.3;
const SKIP_NOTICE_MS = 4000;

type TileNotice =
    'connecting' | 'buffering' | 'waiting' | 'skipped' | 'error' | 'unsupported';

/**
 * One multiview tile: a muted-by-default video with its title and state.
 * Clicking it gives it the sound.
 */
@Component({
    selector: 'app-multiview-tile',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [MatIcon, TranslatePipe],
    templateUrl: './multiview-tile.component.html',
    styleUrl: './multiview-tile.component.scss',
    host: {
        '[class.multiview-tile--focused]': 'focused()',
        '[attr.data-test-id]': '"multiview-tile"',
    },
})
export class MultiviewTileComponent implements OnDestroy {
    readonly tileId = input.required<string>();
    readonly title = input('');
    readonly logo = input<string | null>(null);
    readonly playback = input<MultiviewTilePlayback | null>(null);
    readonly focused = input(false);
    /** Scheduler state for a shared tile; null for a direct one. */
    readonly status = input<MultiplexTileStatus | null>(null);

    readonly focusRequested = output<void>();
    readonly replaceRequested = output<void>();
    readonly removeRequested = output<void>();

    private readonly videoRef =
        viewChild.required<ElementRef<HTMLVideoElement>>('video');
    private engine: MultiviewTileEngine | null = null;
    private readonly failed = signal(false);
    private readonly hasPicture = signal(false);
    /** Paused by this tile because it ran dry, until its buffer is rebuilt. */
    private readonly holding = signal(false);
    private readonly skippedRecently = signal(false);
    private skipTimer: ReturnType<typeof setTimeout> | null = null;
    private lastSkippedMs = 0;

    readonly notice = computed<TileNotice | null>(() => {
        const status = this.status();
        if (status?.state === 'unsupported') {
            return 'unsupported';
        }
        if (this.failed() || status?.state === 'error') {
            return 'error';
        }
        if (!this.hasPicture()) {
            return 'connecting';
        }
        if (this.holding()) {
            return status ? 'waiting' : 'buffering';
        }
        return this.skippedRecently() ? 'skipped' : null;
    });

    readonly noticeKey = computed(() => {
        switch (this.notice()) {
            case 'connecting':
                return 'MULTIVIEW.STATE_CONNECTING';
            case 'buffering':
                return 'MULTIVIEW.STATE_BUFFERING';
            case 'waiting':
                return 'MULTIVIEW.STATE_WAITING_TURN';
            case 'skipped':
                return 'MULTIVIEW.STATE_SKIPPED';
            case 'unsupported':
                return 'MULTIVIEW.STATE_UNSUPPORTED';
            case 'error':
                return this.status()?.httpStatus
                    ? 'MULTIVIEW.STATE_ERROR'
                    : 'MULTIVIEW.STATE_ERROR_GENERIC';
            default:
                return null;
        }
    });

    readonly noticeParams = computed(() => ({
        status: this.status()?.httpStatus ?? '',
    }));

    constructor() {
        effect(() => this.load(this.playback()));
        effect(() => {
            this.videoRef().nativeElement.muted = !this.focused();
        });
        effect(() => this.noteSkip(this.status()?.skippedMs ?? 0));
    }

    /** Called by the multiview a few times a second. */
    progress(): MultiplexTileProgress {
        const video = this.videoRef().nativeElement;
        const bufferedAheadSec = this.engine?.bufferedAheadSec() ?? 0;
        this.resumeWhenRebuilt(video, bufferedAheadSec);
        return {
            tileId: this.tileId(),
            bufferedAheadSec,
            playing: !video.paused && !this.holding(),
            focused: this.focused(),
        };
    }

    onPlaying(): void {
        this.hasPicture.set(true);
    }

    /** The playhead caught up with the buffer. */
    onWaiting(): void {
        const video = this.videoRef().nativeElement;
        if (
            this.playback()?.shared &&
            (this.engine?.bufferedAheadSec() ?? 0) < DRY_BELOW_SEC
        ) {
            // Stop and rebuild a reserve instead of stuttering on every
            // segment as it arrives.
            this.holding.set(true);
            video.pause();
        }
    }

    ngOnDestroy(): void {
        this.unload();
        if (this.skipTimer) {
            clearTimeout(this.skipTimer);
        }
    }

    private load(playback: MultiviewTilePlayback | null): void {
        this.unload();
        if (!playback) {
            return;
        }
        this.engine = new MultiviewTileEngine({
            shared: playback.shared,
            onError: () => this.failed.set(true),
        });
        void this.engine.start(
            playback.url,
            playback.kind,
            this.videoRef().nativeElement
        );
    }

    private unload(): void {
        this.engine?.destroy();
        this.engine = null;
        this.failed.set(false);
        this.hasPicture.set(false);
        this.holding.set(false);
    }

    private resumeWhenRebuilt(
        video: HTMLVideoElement,
        bufferedAheadSec: number
    ): void {
        if (!this.holding()) {
            return;
        }
        const needed = this.status()?.resumeThresholdSec ?? DEFAULT_RESUME_SEC;
        if (bufferedAheadSec >= needed) {
            this.holding.set(false);
            void video.play().catch(() => undefined);
        }
    }

    private noteSkip(skippedMs: number): void {
        if (skippedMs > 0 && skippedMs !== this.lastSkippedMs) {
            this.skippedRecently.set(true);
            if (this.skipTimer) {
                clearTimeout(this.skipTimer);
            }
            this.skipTimer = setTimeout(
                () => this.skippedRecently.set(false),
                SKIP_NOTICE_MS
            );
        }
        this.lastSkippedMs = skippedMs;
    }
}
