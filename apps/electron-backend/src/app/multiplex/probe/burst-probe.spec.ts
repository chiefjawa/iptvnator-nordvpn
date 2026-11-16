import { PassThrough } from 'node:stream';
import { buildChannelSlice, SyntheticTsWriter } from '../testing/synthetic-ts';
import {
    BurstProbeDeps,
    BurstProbeReport,
    BurstProbeRequest,
    OpenedUpstream,
} from './burst-probe';
import {
    buildXtreamLiveTsUrl,
    BurstProbeRunnerDeps,
    runBurstProbeFromEnv,
} from './burst-probe-runner';

jest.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));
jest.mock('../../database/connection', () => ({ getDatabase: jest.fn() }));
jest.mock('../../services/database-worker-client', () => ({
    databaseWorkerClient: { request: jest.fn() },
}));
jest.mock('../../util/validated-axios', () => ({
    requestWithValidatedRedirects: jest.fn(),
}));

const REQUEST: BurstProbeRequest = {
    url: 'http://provider.invalid/live/user/secret/42.ts',
    holdMs: 400,
    reopenDelaysMs: [2000, 5000],
};

/**
 * A fake provider with a virtual clock. Each open bursts 10 s of content
 * ending at the channel's live edge, and the edge advances with the clock.
 */
function fakeProvider(options: { refuseFrom?: number } = {}) {
    let clockMs = 0;
    let opens = 0;
    let openNow = 0;
    let peakOpen = 0;

    const deps: BurstProbeDeps = {
        now: () => clockMs,
        sleep: async (ms) => {
            clockMs += ms;
        },
        open: async (): Promise<OpenedUpstream> => {
            opens += 1;
            openNow += 1;
            peakOpen = Math.max(peakOpen, openNow);
            const stream = new PassThrough();
            stream.once('close', () => {
                openNow -= 1;
            });

            if (options.refuseFrom && opens >= options.refuseFrom) {
                return { status: 403, redirected: false, stream };
            }

            const liveSec = 100 + Math.floor(clockMs / 1000);
            const writer = new SyntheticTsWriter();
            const frames = buildChannelSlice(writer, {
                fromFrame: (liveSec - 10) * 25,
                frames: 10 * 25,
            });
            setImmediate(() => {
                stream.write(writer.psi());
                frames.forEach((frame) => stream.write(frame));
            });
            return { status: 200, redirected: true, stream };
        },
    };

    return { deps, stats: () => ({ opens, openNow, peakOpen }) };
}

describe('runBurstProbe', () => {
    let runBurstProbe: (
        request: BurstProbeRequest,
        deps: BurstProbeDeps
    ) => Promise<BurstProbeReport>;

    beforeAll(async () => {
        ({ runBurstProbe } = await import('./burst-probe'));
    });

    it('measures the first connection and every reopen', async () => {
        const provider = fakeProvider();

        const report = await runBurstProbe(REQUEST, provider.deps);

        expect(report.status).toBe(200);
        expect(report.redirected).toBe(true);
        expect(report.burstMediaSec).toBeGreaterThan(9);
        expect(report.codecs).toEqual({ video: 'h264', audio: 'aac' });
        expect(report.reopens.map((reopen) => reopen.delayMs)).toEqual([
            2000, 5000,
        ]);
        // 10 s bursts reopened 2 s and 5 s later overlap by about 8 s and 5 s.
        expect(report.reopens[0]).toMatchObject({
            status: 200,
            fingerprintMatched: true,
            timestampsContinuous: true,
        });
        expect(report.reopens[0].overlapSec).toBeCloseTo(8, 0);
        expect(report.reopens[1].overlapSec).toBeCloseTo(5, 0);
    });

    it('never holds two connections and closes the last one', async () => {
        const provider = fakeProvider();

        await runBurstProbe(REQUEST, provider.deps);

        expect(provider.stats()).toEqual({ opens: 3, openNow: 0, peakOpen: 1 });
    });

    it('records a refused reopen without measurements', async () => {
        const provider = fakeProvider({ refuseFrom: 2 });

        const report = await runBurstProbe(REQUEST, provider.deps);

        expect(report.reopens).toHaveLength(2);
        expect(report.reopens[0]).toMatchObject({
            status: 403,
            burstMediaSec: 0,
            fingerprintMatched: false,
        });
        expect(provider.stats().openNow).toBe(0);
    });

    it('skips the reopens when the first connection is refused', async () => {
        const provider = fakeProvider({ refuseFrom: 1 });

        const report = await runBurstProbe(REQUEST, provider.deps);

        expect(report.status).toBe(403);
        expect(report.reopens).toEqual([]);
        expect(provider.stats().opens).toBe(1);
    });

    it('reports status 0 when no response arrives', async () => {
        const report = await runBurstProbe(REQUEST, {
            now: () => 0,
            sleep: async () => undefined,
            open: async () => {
                throw new Error('connect timeout');
            },
        });

        expect(report.status).toBe(0);
        expect(report.reopens).toEqual([]);
    });
});

describe('runBurstProbeFromEnv', () => {
    const playlist = {
        _id: 'p1',
        serverUrl: 'http://provider.invalid:8080/',
        username: 'user',
        password: 'secret',
        userAgent: 'TestAgent',
    };

    function runnerDeps(overrides: Partial<BurstProbeRunnerDeps> = {}) {
        const written: { path: string; report: unknown }[] = [];
        const probed: BurstProbeRequest[] = [];
        const deps: BurstProbeRunnerDeps = {
            listPlaylists: async () => [{ id: 'm3u' }, playlist],
            listLiveChannels: async (playlistId) => [
                { title: `News One ${playlistId}`, xtream_id: 7 },
                { title: 'Sports Two', xtream_id: 9 },
            ],
            probe: async (request) => {
                probed.push(request);
                return { status: 200 } as BurstProbeReport;
            },
            writeReport: async (path, report) => {
                written.push({ path, report });
            },
            defaultReportPath: () => '/data/report.json',
            log: () => undefined,
            ...overrides,
        };
        return { deps, written, probed };
    }

    it('does nothing unless the environment opts in', async () => {
        const { deps, written, probed } = runnerDeps();

        await runBurstProbeFromEnv({}, deps);

        expect(probed).toEqual([]);
        expect(written).toEqual([]);
    });

    it('probes the first live channel of the first Xtream playlist', async () => {
        const { deps, written, probed } = runnerDeps();

        await runBurstProbeFromEnv({ IPTVNATOR_MULTIPLEX_PROBE: '1' }, deps);

        expect(probed).toEqual([
            {
                url: 'http://provider.invalid:8080/live/user/secret/7.ts',
                userAgent: 'TestAgent',
                referer: undefined,
                origin: undefined,
            },
        ]);
        expect(written).toEqual([
            {
                path: '/data/report.json',
                report: { channel: 'News One p1', status: 200 },
            },
        ]);
    });

    it('selects a channel by title and honours the report path', async () => {
        const { deps, written, probed } = runnerDeps();

        await runBurstProbeFromEnv(
            {
                IPTVNATOR_MULTIPLEX_PROBE: '1',
                IPTVNATOR_MULTIPLEX_PROBE_CHANNEL: 'sports',
                IPTVNATOR_MULTIPLEX_PROBE_OUT: '/elsewhere/out.json',
            },
            deps
        );

        expect(probed[0].url).toContain('/9.ts');
        expect(written[0].path).toBe('/elsewhere/out.json');
    });

    it('never writes the stream URL or credentials', async () => {
        const logs: string[] = [];
        const { deps, written } = runnerDeps({
            log: (message) => logs.push(message),
            probe: async () => {
                throw new Error('failed for http://provider.invalid/secret');
            },
        });

        await runBurstProbeFromEnv({ IPTVNATOR_MULTIPLEX_PROBE: '1' }, deps);

        const output = JSON.stringify(written) + logs.join('\n');
        expect(written[0].report).toEqual({ error: 'probe-failed' });
        expect(output).not.toContain('secret');
        expect(output).not.toContain('provider.invalid');
    });

    it('reports when there is nothing to probe', async () => {
        const none = runnerDeps({ listPlaylists: async () => [{ id: 'm3u' }] });
        await runBurstProbeFromEnv(
            { IPTVNATOR_MULTIPLEX_PROBE: '1' },
            none.deps
        );
        expect(none.written[0].report).toEqual({ error: 'no-xtream-playlist' });

        const noMatch = runnerDeps();
        await runBurstProbeFromEnv(
            {
                IPTVNATOR_MULTIPLEX_PROBE: '1',
                IPTVNATOR_MULTIPLEX_PROBE_CHANNEL: 'absent',
            },
            noMatch.deps
        );
        expect(noMatch.written[0].report).toMatchObject({
            error: 'no-matching-live-channel',
        });
    });

    it('requires complete Xtream credentials to build a URL', () => {
        expect(buildXtreamLiveTsUrl({ id: 'x' }, 1)).toBeNull();
        expect(
            buildXtreamLiveTsUrl({ ...playlist, password: '' }, 1)
        ).toBeNull();
    });
});
