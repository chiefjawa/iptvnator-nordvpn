/**
 * Logging for the standalone relay.
 *
 * Lines carry stream ids, channel names and counters only. As a second line
 * of defence every line is scrubbed of the configured secrets (server host,
 * username, password, token) and structured values pass through the shared
 * redactor before they are printed.
 */

import { REDACTED_VALUE, redactSensitiveData } from '@iptvnator/shared/logging';
import type { RelayStatus } from './relay-status';

export interface RelayLogger {
    info(message: string, details?: Record<string, unknown>): void;
    warn(message: string, details?: Record<string, unknown>): void;
}

export function createRelayLogger(
    secrets: readonly string[],
    write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)
): RelayLogger {
    // Longest first, so a value containing another is replaced whole.
    const ordered = [...secrets].sort((a, b) => b.length - a.length);
    const scrub = (text: string): string =>
        ordered.reduce(
            (result, secret) => result.split(secret).join(REDACTED_VALUE),
            text
        );
    const emit = (
        level: string,
        message: string,
        details?: Record<string, unknown>
    ) => {
        const suffix = details
            ? ` ${JSON.stringify(redactSensitiveData(details))}`
            : '';
        write(
            scrub(`${new Date().toISOString()} ${level} ${message}${suffix}`)
        );
    };
    return {
        info: (message, details) => emit('info', message, details),
        warn: (message, details) => emit('warn', message, details),
    };
}

/** The periodic one-line summary. */
export function formatStatusLine(status: RelayStatus): string {
    const up = status.upstream;
    const head =
        `up=${status.uptimeSec}s upstream=${up.open ? `open:${up.streamId}` : 'closed'}` +
        ` opens=${up.opens} refused=${up.refusals} errors=${up.errors}` +
        ` peak=${up.maxOpenAtOnce} mem=${(status.queueBytes / 1048576).toFixed(1)}MB`;
    const channels = status.channels.map(
        (c) =>
            `${c.streamId} "${c.name}" ${c.state} c=${c.clients}` +
            ` q=${c.queuedSec}s res=${c.reserveSec}s sent=${c.sentSec}s v=${c.visits}` +
            ` new=${c.newMediaMs} ov=${c.overlapMs} skip=${c.skippedMs} rs=${c.restarts}` +
            ` dry=${c.dryStalls}/${c.dryStallMs}ms ka=${c.keepAlivePackets}` +
            ` bp=${c.backpressureDrops}/${c.backpressureDroppedMs}ms`
    );
    return [head, ...channels].join(' | ');
}
