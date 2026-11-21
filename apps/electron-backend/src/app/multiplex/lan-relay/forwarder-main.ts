/**
 * Command-line entry of the host-side LAN forwarder.
 *
 *   node dist/apps/multiplex-relay/forwarder.js --config <relay config> --socket <path>
 *
 * Runs on the host network (not in the VPN namespace). Reads only the
 * config's `lan` section. Logs go to stdout.
 */

import {
    createLanForwarder,
    formatForwarderStats,
    ForwarderLogger,
    loadForwarderConfig,
} from './lan-forwarder';
import {
    CONFIG_ENV,
    RelayConfigError,
    resolveConfigPath,
} from './relay-config';

const USAGE = `Usage: multiplex-relay-forwarder --config <path> --socket <unix socket path>   (or ${CONFIG_ENV}=<path>)`;
const SUMMARY_EVERY_MS = 60_000;

function argValue(argv: readonly string[], name: string): string | null {
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === name) {
            return argv[index + 1] ?? null;
        }
        if (argv[index].startsWith(`${name}=`)) {
            return argv[index].slice(name.length + 1) || null;
        }
    }
    return null;
}

function main(): void {
    const argv = process.argv.slice(2);
    if (argv.includes('--help') || argv.includes('-h')) {
        process.stdout.write(`${USAGE}\n`);
        return;
    }
    const configPath = resolveConfigPath(argv, process.env);
    const socketPath = argValue(argv, '--socket');
    if (!configPath || !socketPath || !socketPath.startsWith('/')) {
        process.stderr.write(`${USAGE}\n`);
        process.exitCode = 2;
        return;
    }
    const log: ForwarderLogger = {
        info: (m) =>
            process.stdout.write(`${new Date().toISOString()} info ${m}\n`),
        warn: (m) =>
            process.stdout.write(`${new Date().toISOString()} warn ${m}\n`),
    };
    let config;
    try {
        config = loadForwarderConfig(configPath);
    } catch (error) {
        const message =
            error instanceof RelayConfigError
                ? error.message
                : 'invalid config';
        process.stderr.write(`multiplex-relay-forwarder: ${message}\n`);
        process.exitCode = 2;
        return;
    }
    const forwarder = createLanForwarder(config, socketPath, log);
    forwarder.server.once('error', (error) => {
        process.stderr.write(
            `multiplex-relay-forwarder: cannot listen (${(error as NodeJS.ErrnoException).code ?? 'Error'})\n`
        );
        process.exit(1);
    });
    forwarder.server.listen(config.port, config.host, () => {
        log.info(
            `listening on ${config.host}:${config.port}; allowing ${config.allowFrom.join(', ')}; relay socket ${socketPath}`
        );
    });
    const summary = setInterval(
        () => log.info(formatForwarderStats(forwarder.stats)),
        SUMMARY_EVERY_MS
    );
    let stopping = false;
    const shutdown = (signal: string) => {
        if (stopping) {
            return;
        }
        stopping = true;
        clearInterval(summary);
        log.info(
            `${signal}: closing; ${formatForwarderStats(forwarder.stats)}`
        );
        void forwarder.close().then(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
