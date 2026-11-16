/**
 * Developer-only entry point for the provider burst probe.
 *
 * Opt-in through the environment, so it never runs for a normal launch:
 *
 *   IPTVNATOR_MULTIPLEX_PROBE=1            run once after startup
 *   IPTVNATOR_MULTIPLEX_PROBE_CHANNEL=...  channel title to look for
 *                                          (default: the first live channel)
 *   IPTVNATOR_MULTIPLEX_PROBE_OUT=...      report path (default: userData)
 *
 * It runs inside the app rather than as a script so the request leaves
 * through the same network path as playback (including the app-only VPN
 * namespace). The stream URL is built here from the stored playlist and is
 * never logged or written to the report.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { getDatabase } from '../../database/connection';
import { databaseWorkerClient } from '../../services/database-worker-client';
import {
    BurstProbeReport,
    BurstProbeRequest,
    runBurstProbe,
} from './burst-probe';

const REPORT_FILE_NAME = 'multiplex-burst-probe.json';

interface PlaylistRow {
    /** App playlists are keyed `_id`; raw table rows use `id`. */
    readonly _id?: string;
    readonly id?: string;
    readonly serverUrl?: string | null;
    readonly username?: string | null;
    readonly password?: string | null;
    readonly userAgent?: string | null;
    readonly referrer?: string | null;
    readonly origin?: string | null;
}

interface LiveRow {
    readonly title?: string | null;
    readonly xtream_id?: number | null;
}

export interface BurstProbeRunnerDeps {
    listPlaylists(): Promise<readonly PlaylistRow[]>;
    listLiveChannels(playlistId: string): Promise<readonly LiveRow[]>;
    probe(request: BurstProbeRequest): Promise<BurstProbeReport>;
    writeReport(path: string, report: unknown): Promise<void>;
    defaultReportPath(): string;
    log(message: string): void;
}

const defaultDeps: BurstProbeRunnerDeps = {
    listPlaylists: async () => {
        await getDatabase();
        return databaseWorkerClient.request<PlaylistRow[]>(
            'DB_GET_APP_PLAYLIST_METAS',
            undefined
        );
    },
    listLiveChannels: (playlistId) =>
        databaseWorkerClient.request<LiveRow[]>('DB_GET_CONTENT', {
            playlistId,
            type: 'live',
        }),
    probe: runBurstProbe,
    writeReport: (path, report) =>
        writeFile(path, `${JSON.stringify(report, null, 2)}\n`, {
            mode: 0o600,
        }),
    defaultReportPath: () => join(app.getPath('userData'), REPORT_FILE_NAME),
    log: (message) => console.log(`[multiplex-probe] ${message}`),
};

/** Builds the direct MPEG-TS URL of an Xtream live channel. */
export function buildXtreamLiveTsUrl(
    playlist: PlaylistRow,
    xtreamId: number
): string | null {
    const serverUrl = playlist.serverUrl?.trim().replace(/\/+$/, '');
    if (!serverUrl || !playlist.username || !playlist.password) {
        return null;
    }
    return `${serverUrl}/live/${playlist.username}/${playlist.password}/${xtreamId}.ts`;
}

/** Runs the probe when the environment asks for it; otherwise does nothing. */
export async function runBurstProbeFromEnv(
    env: NodeJS.ProcessEnv = process.env,
    deps: BurstProbeRunnerDeps = defaultDeps
): Promise<void> {
    if (env['IPTVNATOR_MULTIPLEX_PROBE'] !== '1') {
        return;
    }

    const reportPath =
        env['IPTVNATOR_MULTIPLEX_PROBE_OUT']?.trim() ||
        deps.defaultReportPath();
    const wanted = env['IPTVNATOR_MULTIPLEX_PROBE_CHANNEL']
        ?.trim()
        .toLowerCase();

    try {
        const outcome = await probeFirstXtreamChannel(wanted, deps);
        await deps.writeReport(reportPath, outcome);
        deps.log(`finished; report written to ${reportPath}`);
    } catch {
        // The error could carry the request URL, so it is not echoed.
        await deps
            .writeReport(reportPath, { error: 'probe-failed' })
            .catch(() => undefined);
        deps.log('failed; see the report file');
    }
}

async function probeFirstXtreamChannel(
    wantedTitle: string | undefined,
    deps: BurstProbeRunnerDeps
): Promise<unknown> {
    const playlists = await deps.listPlaylists();
    const playlist = playlists.find(
        (candidate) => buildXtreamLiveTsUrl(candidate, 0) !== null
    );
    const playlistId = playlist?._id ?? playlist?.id;
    if (!playlist || !playlistId) {
        return { error: 'no-xtream-playlist' };
    }

    const rows = await deps.listLiveChannels(playlistId);
    const channels = rows.filter(
        (channel) => typeof channel.xtream_id === 'number'
    );
    const channel = wantedTitle
        ? channels.find((candidate) =>
              candidate.title?.toLowerCase().includes(wantedTitle)
          )
        : channels[0];
    const url =
        channel && buildXtreamLiveTsUrl(playlist, channel.xtream_id as number);
    if (!channel || !url) {
        return {
            error: 'no-matching-live-channel',
            liveRows: rows.length,
            usableRows: channels.length,
        };
    }

    deps.log(`probing "${channel.title ?? 'untitled'}"; this takes a minute`);
    const report = await deps.probe({
        url,
        userAgent: playlist.userAgent,
        referer: playlist.referrer,
        origin: playlist.origin,
    });
    return { channel: channel.title ?? null, ...report };
}
