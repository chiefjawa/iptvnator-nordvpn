/**
 * Who may start a live channel, and how long a channel nobody watches is
 * kept.
 *
 * Capacity is a number of channels (`maxLiveChannels`): every channel is a
 * tile on the one rotating connection, and past a few the rotation can no
 * longer keep each one fed. A channel without clients is evicted to make
 * room before a request is refused.
 *
 * A zap — a client leaving one channel and asking for another from the
 * same address within `zapWindowSec` — shortens the left channel's grace to
 * `zapGraceSec`, so rotation is not spent on a channel nobody watches.
 */

export interface ZapEvent {
    readonly streamId: number;
    readonly atMs: number;
}

export class ZapTracker {
    private readonly departures = new Map<string, ZapEvent>();
    private readonly arrivals = new Map<string, ZapEvent>();
    zaps = 0;

    constructor(private readonly windowMs: number) {}

    /** A client arrived; returns the channel it zapped away from, if any. */
    arrived(remote: string, streamId: number, nowMs: number): number | null {
        this.prune(nowMs);
        this.arrivals.set(remote, { streamId, atMs: nowMs });
        const left = this.departures.get(remote);
        if (left && left.streamId !== streamId) {
            this.departures.delete(remote);
            this.zaps += 1;
            return left.streamId;
        }
        return null;
    }

    /** A client left; true when the same address just opened another channel. */
    departed(remote: string, streamId: number, nowMs: number): boolean {
        this.prune(nowMs);
        const next = this.arrivals.get(remote);
        if (next && next.streamId !== streamId) {
            this.arrivals.delete(remote);
            this.zaps += 1;
            return true;
        }
        this.departures.set(remote, { streamId, atMs: nowMs });
        return false;
    }

    private prune(nowMs: number): void {
        for (const map of [this.departures, this.arrivals]) {
            for (const [remote, event] of map) {
                if (nowMs - event.atMs > this.windowMs) {
                    map.delete(remote);
                }
            }
        }
    }
}

export interface LiveRefusals {
    /** Requests for a new channel beyond `maxLiveChannels`. */
    capacity: number;
    /** Live requests while a movie or catch-up stream held the connection. */
    vodActive: number;
}
