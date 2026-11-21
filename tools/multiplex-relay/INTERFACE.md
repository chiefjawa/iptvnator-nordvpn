# Relay service interface (launcher, forwarder, status)

Contract between the protected launcher (`relay-vpn.mjs`, `relay-guard.mjs`,
`relay-vpn-lib.mjs`) and the units, `relayctl` and operator docs built on it.

## Relay launcher (VPN namespace + relay)

```
<node> <repo>/tools/multiplex-relay/relay-vpn.mjs
```

No arguments. Runs on the host network as the user (no sudo); needs the root
`vopono daemon` (system `vopono.service`) and `vopono` on `PATH`.

| Env | Default | Meaning |
| --- | --- | --- |
| `MULTIPLEX_RELAY_CONFIG` | (required) | Relay config path. Only checked to exist here; the relay reads it. |
| `RELAY_SOCKET` | `$XDG_RUNTIME_DIR/iptv-relay/relay.sock` | Unix socket the relay listens on (`--listen unix:<path>`). Dir 0700, socket 0600. |
| `RELAY_STATE_FILE` | `$XDG_RUNTIME_DIR/iptv-relay/guard-state.json` | Guard's last check: `{namespace, checkedAt, ok, egress:"differs"}` or `{ok:false, reason}`. No IPs. |
| `RELAY_BUNDLE` | `<repo>/dist/apps/multiplex-relay/main.js` | Relay entry. |
| `RELAY_NODE` | the launcher's own node | Node used for guard and relay. |
| `RELAY_VPN_SERVER` | empty | NordVPN region or server. Empty: `server` of the app's `linux-vpn.json`, else `canada`. |
| `IPTVNATOR_VPN_SETTINGS` | `/home/jackd/Work/iptvnator-private/profile/user-data/linux-vpn.json` | App VPN settings (server/configured/enabled only). |
| `RELAY_VPN_DEBUG` | unset | `1` passes vopono's stderr through (may name servers/addresses). |

What it does, in order:

1. Waits up to 2 min for `vopono daemon status` available+compatible, and up
   to 5 min for the host's public IP (this is the network-online wait; a user
   manager has no `network-online.target`).
2. Stops leftover relay namespaces of an earlier run: ids matching
   `iptvrelay-<8 hex>-u<uid>` whose applications' argv contains the guard
   script path (`vopono stop application <pid>`). Removes stale
   `$XDG_RUNTIME_DIR/iptv-relay/launch-*` dirs.
3. Server: lists file NAMES in `~/.config/vopono/nordvpn/wireguard/` (never
   contents), takes those matching the region (prefix or alias), removes
   servers used by any running namespace (`vopono list namespaces`), prefers
   plain `country-cc-ccNNN` names, picks one at random. A busy specific server
   falls back to its country.
4. Runs, exactly like the app (`vpnLaunchArguments`):
   `vopono exec --provider nordvpn --protocol wireguard --server <server>
   --custom-netns-name iptvrelay-<8 hex> --vopono-config <launch dir>/vopono.toml
   --json '<node>' '<repo>/tools/multiplex-relay/relay-guard.mjs'`
   with `no_killswitch = false` in that toml. Namespace becomes
   `iptvrelay-<8 hex>-u<uid>` (distinct from the app's `iptvnator-*`).
5. Waits for vopono's `{"event":"launched","namespace":...,"pid":...}` line
   (90 s), then forwards guard/relay stdout lines to its stdout (journal).
6. If the guard exits 5 before the relay started (tunnel never passed
   traffic), retries on another server, 3 servers at most.

Exit codes: `0` clean stop after SIGTERM/SIGINT/SIGHUP; `1` launch failure
or the session ended (including the guard exiting 0 because someone stopped
it): systemd should restart (`Restart=on-failure`). Other non-zero codes are
the guard's, passed through by vopono:

| Guard code | Meaning |
| --- | --- |
| 2 | Required env missing. |
| 3 | Namespace identity failed: wrong `VOPONO_NS`, inode = host's, `/run/netns/<name>` gone or replaced, launch permit revoked, launcher gone. |
| 4 | Namespace public IP is the SAME as the host's. |
| 5 | Egress not verifiable (30 s at start, 90 s after resume/recheck). |
| other | The relay's own exit code. |

SIGTERM: removes the launch permit, SIGTERMs the guard (which SIGTERMs the
relay: it closes the provider connection first; SIGKILL after 15 s), waits up
to 25 s for vopono to end, then `vopono stop application <pid>`, waits up to
15 s for the namespace to disappear, exits 0. Typical stop: 3-18 s; use
`TimeoutStopSec=45s`, `KillMode=mixed`.

cgroup note: guard and relay are started by the root vopono daemon, so they
are NOT in the systemd unit's cgroup; systemd can only signal the launcher.
If the launcher is SIGKILLed, the guard notices within 3 s (launcher pid gone)
and stops the relay; observed: namespace gone within seconds.

## Guard checks (fail closed)

Before starting the relay: `VOPONO_NS` equals the expected name;
`/proc/self/ns/net` inode equals `/run/netns/<name>`'s and differs from the
host inode passed by the launcher; permit file exists; namespace public IP
(api.ipify.org, then icanhazip.com) differs from the host's. Only then:

```
<node> <RELAY_BUNDLE> --config <MULTIPLEX_RELAY_CONFIG> --listen unix:<RELAY_SOCKET>
```

Every 3 s: identity, permit and launcher liveness. After a suspend (wall
clock ahead of monotonic by > 15 s) and every 30 min: egress again, 90 s
deadline. Any failure: relay killed, guard exits non-zero. The helper's
WireGuard kill switch stays on underneath. Logs print `differs`/`same`, never
an address.

## Host-side forwarder

```
<node> <repo>/dist/apps/multiplex-relay/forwarder.js --config <cfg> --socket <RELAY_SOCKET>
```

(`MULTIPLEX_RELAY_CONFIG` works instead of `--config`.) Runs on the host
network. Reads only `lan` from the config: `lan.listen` (TCP, default
`0.0.0.0:8790`), `lan.allowFrom` (CIDRs, default `["127.0.0.0/8"]`),
`lan.maxConnections` (default 64). Each admitted connection is piped to the
socket behind a PROXY v1 line with the client address. Exit 2 on config
error (message names the field only), 1 if it cannot listen, 0 on SIGTERM.
It can start before the relay socket exists (connections are closed until
then); summary log line every 60 s (`active= accepted= denied= full=
relayDown= in= out=`).

## Status and login check

- From the LAN/host: `http://<host>:<lan port>/<token>/status`.
- Directly on the socket (no forwarder): connect to `RELAY_SOCKET`, send
  `PROXY UNKNOWN\r\n` then the HTTP request (Node: `http.request` with
  `createConnection` and WITHOUT `agent: false`, which disables it).
- Xtream login check:
  `/player_api.php?username=<clients[0].username>&password=<clients[0].password>`
  → `user_info.auth` (1 ok, 0 bad), `user_info.max_connections`. Contacts the
  real provider; print only those two fields.
- Egress from outside: `vopono exec --existing-netns <namespace id>
  --vopono-config <toml with no_killswitch = false> "<node> <script>"` runs a
  short app inside the running namespace (tested; does not tear it down).
  Or read `RELAY_STATE_FILE`.

## LAN firewall

ufw blocks the port from other devices; the owner runs once:
`sudo ufw allow in on wlp8s0 from 192.168.1.0/24 to any port 8790 proto tcp comment 'IPTV relay'`.
`vopono exec -f <port>` was tested as an alternative: it does listen on all
host interfaces, but every client then appears as the namespace gateway
address and there is no source filter, so the socket + forwarder is used.
