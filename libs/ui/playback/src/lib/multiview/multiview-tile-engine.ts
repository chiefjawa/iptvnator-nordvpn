import type Hls from 'hls.js';
import mpegts from 'mpegts.js';

export type MultiviewTileSourceKind = 'mpegts' | 'hls';

export interface MultiviewTileEngineConfig {
    /** The tile shares one connection: delivery comes in bursts with pauses. */
    readonly shared: boolean;
    readonly onError: () => void;
}

/**
 * Keep this much already-played media; the rest is evicted. Four tiles each
 * holding the live default (minutes of video) would waste memory for no use.
 */
const KEEP_BEHIND_MAX_SEC = 30;
const KEEP_BEHIND_MIN_SEC = 10;

/**
 * The player of one multiview tile: a bare engine on a `<video>` element.
 *
 * It deliberately has none of the single-player machinery (recovery
 * controller, header overrides, controls): a shared tile that receives
 * nothing for a while is waiting for its turn, not failing, and must not be
 * reloaded for it.
 */
export class MultiviewTileEngine {
    private mpegtsPlayer: mpegts.Player | null = null;
    private hls: Hls | null = null;
    private video: HTMLVideoElement | null = null;
    private destroyed = false;

    constructor(private readonly config: MultiviewTileEngineConfig) {}

    async start(
        url: string,
        kind: MultiviewTileSourceKind,
        video: HTMLVideoElement
    ): Promise<void> {
        this.video = video;
        if (kind === 'hls') {
            await this.startHls(url, video);
        } else {
            this.startMpegTs(url, video);
        }
    }

    /** Seconds of media buffered ahead of the playhead. */
    bufferedAheadSec(): number {
        const video = this.video;
        if (!video) {
            return 0;
        }
        const ranges = video.buffered;
        for (let index = ranges.length - 1; index >= 0; index -= 1) {
            // A small tolerance: the playhead can sit just before a range.
            if (ranges.start(index) <= video.currentTime + 0.5) {
                return Math.max(0, ranges.end(index) - video.currentTime);
            }
        }
        return 0;
    }

    destroy(): void {
        this.destroyed = true;
        const engine = this.mpegtsPlayer;
        this.mpegtsPlayer = null;
        if (engine) {
            engine.pause();
            engine.unload();
            engine.detachMediaElement();
            engine.destroy();
        }
        this.hls?.destroy();
        this.hls = null;
        this.video = null;
    }

    private startMpegTs(url: string, video: HTMLVideoElement): void {
        const engine = mpegts.createPlayer(
            { type: 'mpegts', isLive: true, url },
            {
                // A shared tile is intentionally behind the live edge and is
                // fed in bursts; chasing the edge would throw its reserve away.
                liveBufferLatencyChasing: false,
                liveSync: false,
                autoCleanupSourceBuffer: true,
                autoCleanupMaxBackwardDuration: KEEP_BEHIND_MAX_SEC,
                autoCleanupMinBackwardDuration: KEEP_BEHIND_MIN_SEC,
                fixAudioTimestampGap: true,
                // The relay sends whole bursts; let them through unstashed.
                enableStashBuffer: !this.config.shared,
            }
        );
        this.mpegtsPlayer = engine;
        engine.attachMediaElement(video);
        engine.on(mpegts.Events.ERROR, () => this.config.onError());
        engine.load();
        void engine.play()?.catch(() => undefined);
    }

    private async startHls(url: string, video: HTMLVideoElement): Promise<void> {
        const { default: HlsEngine } = await import('hls.js');
        if (this.destroyed) {
            return;
        }
        if (!HlsEngine.isSupported()) {
            video.src = url;
            void video.play().catch(() => undefined);
            return;
        }
        const hls = new HlsEngine({ backBufferLength: KEEP_BEHIND_MAX_SEC });
        this.hls = hls;
        hls.on(HlsEngine.Events.ERROR, (_event, data) => {
            if (data.fatal) {
                this.config.onError();
            }
        });
        hls.loadSource(url);
        hls.attachMedia(video);
        void video.play().catch(() => undefined);
    }
}
