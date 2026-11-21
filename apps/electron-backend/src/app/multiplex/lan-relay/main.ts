/**
 * Command-line entry of the standalone LAN relay.
 *
 *   node dist/apps/multiplex-relay/main.js --config <path> [--listen <spec>]
 *
 * Plain Node: no Electron, no prompts. Logs go to stdout (the journal under
 * systemd). The only files written are the API/guide cache in `cacheDir`
 * and, with `--listen unix:<path>`, the socket.
 */

import { openTileUpstream } from '../scheduler/upstream-connection';
import { closeRelayServer, createRelayHttpServer } from './lan-relay-http';
import { RELAY_BUILD, RelayApp } from './relay-app';
import {
    CONFIG_ENV,
    loadRelayConfig,
    RelayConfig,
    RelayConfigError,
    resolveConfigPath,
    secretsOf,
} from './relay-config';
import { listenEndpoint, parseListenSpec } from './relay-listen';
import { createRelayLogger } from './relay-log';

const USAGE = `Usage: multiplex-relay --config <path> [--listen host:port|unix:/path]   (or ${CONFIG_ENV}=<path>)`;

/** `--listen <spec>` or `--listen=<spec>`, overriding the config. */
function listenOverride(argv: readonly string[]): string | null {
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === '--listen') {
            return argv[index + 1] ?? '';
        }
        if (argv[index].startsWith('--listen=')) {
            return argv[index].slice('--listen='.length);
        }
    }
    return null;
}

function loadConfig(argv: readonly string[]): RelayConfig | null {
    const path = resolveConfigPath(argv, process.env);
    if (!path) {
        process.stderr.write(`${USAGE}\n`);
        process.exitCode = 2;
        return null;
    }
    try {
        const config = loadRelayConfig(path);
        const listen = listenOverride(argv);
        return listen === null
            ? config
            : {
                  ...config,
                  listen: parseListenSpec(listen, 'listen (--listen)'),
              };
    } catch (error) {
        const message =
            error instanceof RelayConfigError
                ? error.message
                : 'invalid config';
        process.stderr.write(`multiplex-relay: ${message}\n`);
        process.exitCode = 2;
        return null;
    }
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    if (argv.includes('--help') || argv.includes('-h')) {
        process.stdout.write(`${USAGE}\n`);
        return;
    }
    if (argv.includes('--version')) {
        process.stdout.write(`${RELAY_BUILD.version} ${RELAY_BUILD.commit}\n`);
        return;
    }
    const config = loadConfig(argv);
    if (!config) {
        return;
    }

    const log = createRelayLogger(secretsOf(config));
    const app = new RelayApp({ config, open: openTileUpstream, log });
    const server = createRelayHttpServer(app);
    const endpoint = await listenEndpoint(server, config.listen);
    void app.start();
    log.info(
        `relay ${RELAY_BUILD.version} (${RELAY_BUILD.commit}) listening on ${endpoint.port === null ? `unix:${endpoint.address}` : `${endpoint.address}:${endpoint.port}`};` +
            ` logins=${config.clients.length} maxLiveChannels=${config.maxLiveChannels} vodPolicy=${config.vodPolicy}`
    );
    if (config.clients.length === 0) {
        log.warn(
            'no "clients" configured: Xtream logins are disabled, only token paths work'
        );
    }

    let stopping = false;
    const shutdown = async (signal: string) => {
        if (stopping) {
            return;
        }
        stopping = true;
        log.info(`${signal}: closing the upstream connection, then clients`);
        const force = setTimeout(() => process.exit(1), 10_000);
        force.unref();
        await app.stop();
        await endpoint.close().catch(() => closeRelayServer(server));
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('unhandledRejection', (reason) => {
        log.warn(
            `unhandled rejection: ${(reason as Error)?.name ?? 'unknown'}`
        );
    });
    process.on('uncaughtException', (error) => {
        // State is unknown now; exit and let the service manager restart.
        log.warn(`uncaught exception: ${(error as Error)?.name ?? 'unknown'}`);
        process.exit(1);
    });
}

main().catch((error: unknown) => {
    const code = (error as { code?: string })?.code;
    process.stderr.write(
        `multiplex-relay: failed to start (${code ?? (error as Error)?.name ?? 'Error'})\n`
    );
    process.exit(1);
});
