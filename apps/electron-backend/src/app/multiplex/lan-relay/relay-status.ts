/**
 * Shape of `/status` and the periodic log line. Ids, names and numbers
 * only: no URL, account or token ever goes in here.
 */

import { TileState } from '../scheduler/scheduler-types';
import { LiveRefusals } from './live-admission';
import { RelayChannel } from './relay-channel';
import { GateStatus } from './upstream-gate';

export interface UpstreamStatus {
    open: boolean;
    /** Stream id the connection is on, when open. */
    streamId: number | null;
    /** Successful opens. */
    opens: number;
    attempts: number;
    /** Opens answered with a non-2xx status (each one causes a backoff). */
    refusals: number;
    /** Opens that failed without a response. */
    errors: number;
    lastStatus: number | null;
    /** Most connections ever open at once; anything above 1 is a bug. */
    maxOpenAtOnce: number;
    /** Connections dropped because they delivered nothing for too long. */
    stalls: number;
    /** The connection shared with VOD; its peak counts live and VOD. */
    gate?: GateStatus;
}

export interface ClientStatus {
    id: number;
    remote: string;
    connectedSec: number;
    startupWaitMs: number | null;
    aheadSec: number;
    cushionSec: number;
    sentSec: number;
    paused: boolean;
}

export interface ChannelStatus {
    streamId: number;
    name: string;
    state: TileState | 'grace' | 'idle';
    clients: number;
    queuedSec: number;
    queueBytes: number;
    reserveSec: number;
    sentSec: number;
    visits: number;
    newMediaMs: number;
    overlapMs: number;
    skippedMs: number;
    restarts: number;
    dryStalls: number;
    dryStallMs: number;
    keepAlivePackets: number;
    backpressurePauses: number;
    backpressureDrops: number;
    backpressureDroppedMs: number;
    capDroppedMs: number;
    starvedEnds: number;
    clientDetails: ClientStatus[];
}

export interface RelayStatus {
    uptimeSec: number;
    upstream: UpstreamStatus;
    queueBytes: number;
    maxLiveChannels: number;
    /** Live rotation paused for a movie (`vodPolicy: "preempt"`). */
    suspended: boolean;
    zaps: number;
    refused: LiveRefusals;
    channels: ChannelStatus[];
}

const round1 = (value: number) => Math.round(value * 10) / 10;

export function channelStatus(
    channel: RelayChannel,
    state: ChannelStatus['state'],
    nowMs: number
): ChannelStatus {
    const counters = channel.counters();
    const queue = channel.queue;
    return {
        streamId: channel.streamId,
        name: channel.name,
        state: channel.graceUntilMs !== null ? 'grace' : state,
        clients: channel.clients.size,
        queuedSec: round1(queue.durationMs / 1000),
        queueBytes: queue.bytes,
        reserveSec: round1(channel.reserveSec()),
        sentSec: round1(counters.sentMediaMs / 1000),
        ...channel.totals,
        capDroppedMs: Math.round(channel.totals.capDroppedMs),
        starvedEnds: channel.starvedEnds,
        newMediaMs: Math.round(channel.totals.newMediaMs),
        dryStalls: counters.dryStalls,
        dryStallMs: counters.dryStallMs,
        keepAlivePackets: counters.keepAlivePackets,
        backpressurePauses: counters.backpressurePauses,
        backpressureDrops: counters.backpressureDrops,
        backpressureDroppedMs: counters.backpressureDroppedMs,
        clientDetails: [...channel.clients].map((client) => ({
            id: client.id,
            remote: client.remote,
            connectedSec: round1((nowMs - client.connectedAtMs) / 1000),
            startupWaitMs: client.startupWaitMs,
            aheadSec: round1(client.aheadMs(queue) / 1000),
            cushionSec: round1(client.cushionSec),
            sentSec: round1(client.counters.sentMediaMs / 1000),
            paused: client.isPaused,
        })),
    };
}
