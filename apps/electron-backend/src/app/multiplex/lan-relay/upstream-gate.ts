/**
 * The account's single stream connection, shared by live and VOD.
 *
 * Every provider stream request — a live visit or a movie/catch-up byte
 * range — enters the gate before it is sent and leaves it only once its
 * socket is confirmed closed. The gate admits one at a time, so the
 * one-connection invariant holds across live and VOD by construction; the
 * peak is reported in `/status` and anything above 1 is a bug.
 *
 * API requests (`player_api.php`, `xmltv.php`) are not stream connections
 * on Xtream panels and do not pass through here.
 */

export type UpstreamKind = 'live' | 'vod';

export interface GateStatus {
    holder: UpstreamKind | null;
    liveEntries: number;
    vodEntries: number;
    /** Requests refused because the connection was held. */
    refused: number;
    /** Most entries ever held at once; anything above 1 is a bug. */
    peak: number;
}

export class UpstreamGate {
    private holderKind: UpstreamKind | null = null;
    private held = 0;
    private readonly waiters = new Set<() => void>();
    private readonly counters: GateStatus = {
        holder: null,
        liveEntries: 0,
        vodEntries: 0,
        refused: 0,
        peak: 0,
    };

    get holder(): UpstreamKind | null {
        return this.holderKind;
    }

    get idle(): boolean {
        return this.held === 0;
    }

    /** Takes the connection; false (and nothing changes) when it is held. */
    tryEnter(kind: UpstreamKind): boolean {
        if (this.held > 0) {
            this.counters.refused += 1;
            return false;
        }
        this.held += 1;
        this.holderKind = kind;
        this.counters.peak = Math.max(this.counters.peak, this.held);
        if (kind === 'live') {
            this.counters.liveEntries += 1;
        } else {
            this.counters.vodEntries += 1;
        }
        return true;
    }

    /** Releases the connection once its socket is closed. */
    leave(): void {
        if (this.held === 0) {
            return;
        }
        this.held -= 1;
        if (this.held === 0) {
            this.holderKind = null;
            const waiters = [...this.waiters];
            this.waiters.clear();
            waiters.forEach((wake) => wake());
        }
    }

    /** Resolves true once the connection is free, false after `timeoutMs`. */
    whenIdle(timeoutMs: number): Promise<boolean> {
        if (this.held === 0) {
            return Promise.resolve(true);
        }
        return new Promise((resolve) => {
            const wake = () => {
                clearTimeout(timer);
                resolve(true);
            };
            const timer = setTimeout(() => {
                this.waiters.delete(wake);
                resolve(this.held === 0);
            }, timeoutMs);
            this.waiters.add(wake);
        });
    }

    status(): GateStatus {
        return { ...this.counters, holder: this.holderKind };
    }
}
