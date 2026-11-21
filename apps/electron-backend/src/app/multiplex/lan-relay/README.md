# LAN multiplex relay

A plain-Node program that holds the single provider connection of a
one-connection Xtream account and serves the home network through it: an
Xtream-compatible front (login, catalogue, guide, live, VOD, catch-up) so a
TV player's existing "Xtream Codes" playlist can be re-pointed at it. Design
and limits: [connection multiplexing](../../../../../../docs/architecture/connection-multiplexing.md#standalone-lan-relay).
Running it as a protected service: [`tools/multiplex-relay/INTERFACE.md`](../../../../../../tools/multiplex-relay/INTERFACE.md).

## Build and run

```bash
pnpm nx run electron-backend:build-multiplex-relay
node dist/apps/multiplex-relay/main.js --config /path/to/relay.json [--listen unix:/run/user/1000/iptv-relay/relay.sock]
node dist/apps/multiplex-relay/main.js --version
```

`MULTIPLEX_RELAY_CONFIG=/path/to/relay.json` works instead of `--config`.
The only files written are the API/guide cache (`cacheDir`) and the socket.
SIGTERM closes the provider connection(s) first, then the clients.
`forwarder.js` is the host-side LAN forwarder for the unix socket (reads
only `lan.*`).

## Config

See [`multiplex-relay.example.json`](multiplex-relay.example.json) (fake
values). Required: `serverUrl`, `username`, `password` (the provider
account), `token` (16-128 of `A-Z a-z 0-9 _ -`). Optional, with defaults:

| Field | Default | Meaning |
| --- | --- | --- |
| `clients` | `[]` | Local logins `{username, password}` (3-64 of `A-Z a-z 0-9 . _ ~ -`, must differ from the provider's). Without any, only token paths work. |
| `listen` | `0.0.0.0:8790` | `host:port` or `unix:/abs/path` (PROXY v1 required on the socket). `--listen` overrides. |
| `maxLiveChannels` | `4` | Live channels rotated at once (1-16); more gets HTTP 503. Reported as `max_connections`. |
| `vodPolicy` | `refuse` | `refuse`: VOD while live is watched gets 503. `preempt`: live rotation pauses for the movie. |
| `cacheDir` | `$XDG_CACHE_HOME/iptv-relay` | Absolute path. Holds sanitized answers only, never the account. |
| `cache.*` | 21600 / 60 / 300 / 43200 s, 1024 MB | `catalogueTtlSec`, `shortTtlSec`, `loginTtlSec`, `xmltvTtlSec`, `maxCacheMb`. |
| `channels` | `[]` | Optional `{streamId, name}` for the token playlist and log names. |
| `lan` | `0.0.0.0:8790`, `["127.0.0.0/8"]` | Forwarder only: `listen`, `allowFrom` (CIDRs), `maxConnections`. |
| `userAgent`, `pacing`, `scheduler` | | As before; `pacing` adds `zapGraceSec` 1, `zapWindowSec` 2, `endAfterStarveSec` 60, `upstreamStallSec` 20. |

Errors name the field, never its value. Logs and `/status` hold ids,
names, addresses of LAN clients and counters only.

## Endpoints

- Xtream (local logins): `/player_api.php` (GET/POST), `/xmltv.php`,
  `/get.php?type=m3u_plus`, live `/live/<u>/<p>/<id>.ts`, `/<u>/<p>/<id>`,
  `/<u>/<p>/<id>.ts` (`.m3u8` is a 404), `/movie|series/<u>/<p>/<id>.<ext>`,
  `/timeshift/<u>/<p>/<min>/<start>/<id>.<ext>`, `/streaming/timeshift.php`.
- Token: `/<token>/playlist.m3u`, `/<token>/live/<id>.ts`, `/<token>/status`.

## Tests

```bash
pnpm nx test electron-backend --testPathPatterns='lan-relay|relay-|lan-forwarder'
```
