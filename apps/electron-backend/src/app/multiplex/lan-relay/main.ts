/**
 * Command-line entry of the standalone LAN relay (trial).
 *
 *   node dist/apps/multiplex-relay/main.js --config <path>
 *
 * Plain Node: no Electron, no prompts, no files written. Logs go to stdout.
 */

import { openTileUpstream } from '../scheduler/upstream-connection';
import { LanRelay } from './lan-relay';
import {
    closeRelayServer,
    createRelayHttpServer,
    listenRelay,
} from './lan-relay-http';
import {
    CONFIG_ENV,
    loadRelayConfig,
    RelayConfig,
    RelayConfigError,
    resolveConfigPath,
    secretsOf,
} from './relay-config';
import { createRelayLogger } from './relay-log';

const USAGE = `Usage: multiplex-relay --config <path>   (or ${CONFIG_ENV}=<path>)`;

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    if (argv.includes('--help') || argv.includes('-h')) {
        process.stdout.write(`${USAGE}\n`);
        return;
    }
    const path = resolveConfigPath(argv, process.env);
    if (!path) {
        process.stderr.write(`${USAGE}\n`);
        process.exitCode = 2;
        return;
    }

    let config: RelayConfig;
    try {
        config = loadRelayConfig(path);
    } catch (error) {
        const message =
            error instanceof RelayConfigError
                ? error.message
                : 'invalid config';
        process.stderr.write(`multiplex-relay: ${message}\n`);
        process.exitCode = 2;
        return;
    }

    const log = createRelayLogger(secretsOf(config));
    const relay = new LanRelay({ config, open: openTileUpstream, log });
    const server = createRelayHttpServer(relay, config, log);
    const address = await listenRelay(server, config.host, config.port);
    relay.start();
    log.info(
        `listening on ${address.address}:${address.port}; playlist at /<token>/playlist.m3u; channels: ${config.channels
            .map((c) => `${c.streamId} "${c.name}"`)
            .join(', ')}`
    );

    let stopping = false;
    const shutdown = async (signal: string) => {
        if (stopping) {
            return;
        }
        stopping = true;
        log.info(`${signal}: closing the upstream connection and clients`);
        await relay.stop();
        await closeRelayServer(server);
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('unhandledRejection', (reason) => {
        log.warn(
            `unhandled rejection: ${(reason as Error)?.name ?? 'unknown'}`
        );
    });
}

main().catch((error: unknown) => {
    const code = (error as { code?: string })?.code;
    process.stderr.write(
        `multiplex-relay: failed to start (${code ?? (error as Error)?.name ?? 'Error'})\n`
    );
    process.exit(1);
});
