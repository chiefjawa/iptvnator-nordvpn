# LAN multiplex relay (trial)

A small plain-Node program that holds the single provider connection and
serves up to a few live channels to players on the home network (for
example an ExoPlayer-based Android TV app), using the same multiplex
engine as the desktop multiview. Design and limits:
[connection multiplexing](../../../../../../docs/architecture/connection-multiplexing.md#standalone-lan-relay-trial).

## Build and run

From the repository root, with the pinned Node (`.nvmrc`) first on `PATH`:

```bash
pnpm nx run electron-backend:build-multiplex-relay
# or, without Nx: node apps/electron-backend/build-multiplex-relay.js
node dist/apps/multiplex-relay/main.js --config /path/to/relay.json
```

`MULTIPLEX_RELAY_CONFIG=/path/to/relay.json` works instead of `--config`.
The bundle has no Electron dependency, asks nothing interactively and
writes no files, so it can be started inside a network namespace. Stop it
with Ctrl-C or SIGTERM; it closes the provider connection before exiting.

## Config

See [`multiplex-relay.example.json`](multiplex-relay.example.json) (fake
values). Required: `serverUrl`, `username`, `password`, `token` (16-128
characters of `A-Z a-z 0-9 _ -`), `channels` (`streamId` + `name`).
Optional: `listen` (default `0.0.0.0:8790`), `userAgent`, `pacing` (any
key of `RelayTuning` in `relay-config.ts`) and `scheduler` (any key of
`SchedulerConfig`). Generate a token with `openssl rand -hex 24`.

The relay never prints the server, account or token; logs and `/status`
hold stream ids, channel names and counters only.

## Endpoints

All paths begin with the token; anything else is a 404. GET and HEAD only.

- `/<token>/playlist.m3u`: M3U of the configured channels, pointing at
  this relay via the request's `Host` header.
- `/<token>/live/<streamId>.ts`: endless MPEG-TS for one channel.
- `/<token>/status`: JSON diagnostics. A summary line is also logged
  every 10 s.

## Tests

```bash
pnpm nx test electron-backend --testPathPatterns=lan-relay
```
