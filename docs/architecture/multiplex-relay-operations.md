# IPTV relay: operating it at home

This page is for running the relay day to day. The design is in
[connection multiplexing](connection-multiplexing.md#standalone-lan-relay);
the service internals (VPN reuse, fail-closed checks, why a socket and a
forwarder) are [below](#service-internals);
the exact launcher contract is in
[`tools/multiplex-relay/INTERFACE.md`](../../tools/multiplex-relay/INTERFACE.md).

## What it is, and why

The IPTV account allows **one connection at a time**. Normally, two TVs
watching at once means two connections, and the provider refuses the second
one (or blocks the account).

The relay is a small program on this PC that holds that one connection and
shares it. TiviMate on each Fire TV connects to the relay instead of the
provider. The relay looks like an ordinary Xtream server to TiviMate (channel
list, guide, live channels, movies and series), and to the provider it looks
like one player at one address.

It runs inside its own NordVPN tunnel, separate from the desktop IPTVnator
app's tunnel, so the provider only ever sees a NordVPN address. A small
"forwarder" on this PC lets the TVs on the home network reach it.

Pieces you will see:

| Name | What it does |
| --- | --- |
| `iptv-relay.service` | Starts the VPN tunnel and the relay inside it. |
| `iptv-relay-forwarder.service` | Lets the TVs reach the relay on port 8790. |
| `iptv-relay-health.timer` | Checks every minute (and right after the PC wakes up) that everything still answers; restarts what is stuck. |
| `relayctl` | The command you use to check on it. |

## Limits (what it cannot do)

- **One connection, shared.** Up to **four live channels at once** across all
  TVs (more TVs on the *same* channel are free). A fifth different channel is
  refused until one of the others is closed.
- **Movies need the whole connection.** A movie or series episode is
  **refused while live TV is playing on another TV**, and live TV is refused
  while a movie plays. (This is the default `vodPolicy: "refuse"`. With
  `"preempt"` a movie pauses live TV instead.) Only one movie at a time.
- **This PC must be on and awake.** If it is off or asleep, the TVs get
  nothing. It recovers by itself after waking up (see below).
- **A few seconds behind live.** The relay rotates the one connection between
  channels and keeps a small reserve for each, so the picture is a few seconds
  behind the provider's.
- **MPEG-TS only.** In TiviMate the stream format must be **TS**, not HLS
  (`.m3u8` requests are refused).
- **The provider sees only the VPN address,** never your home address. If the
  VPN fails, the relay stops rather than connect without it (it "fails
  closed"). TV stops; nothing leaks.
- **Nothing else may use the account directly.** A phone, a TV still pointed
  at the provider, or the desktop IPTVnator app playing from the same account
  is a second connection (from a second address) and will make the provider
  refuse the relay. The desktop app's own VPN can run at the same time; the
  relay picks a different NordVPN server so the two tunnels do not clash.

## Install and enable (once)

The relay must be built first (from the repository, with the pinned Node):

```bash
cd /home/jackd/Work/iptvnator-nordvpn
pnpm nx run electron-backend:build-multiplex-relay
ls dist/apps/multiplex-relay/main.js dist/apps/multiplex-relay/forwarder.js
```

The relay's private config (provider login, the status token, the local
TV logins and the LAN section) lives at
`/home/jackd/Work/iptvnator-private/multiplex-relay.private.json`. It must
contain a `lan` section with `"listen": "0.0.0.0:8790"` and
`"allowFrom": ["192.168.1.0/24"]`, and at least one local login in `clients`
(the username and password the TVs will use; they must differ from the
provider's). Keep that file private; nothing else on this page or in the units
holds a secret.

1. If a trial relay was started by hand, stop it first (port 8790 must be
   free): `ss -ltnp 'sport = :8790'` shows what holds the port.
2. Install the units (copies them to `~/.config/systemd/user/`, creates
   `~/.config/iptv-relay/iptv-relay.env`, links `relayctl` into
   `~/.local/bin`; it starts nothing):

   ```bash
   tools/multiplex-relay/systemd/install.sh
   ```

   Look at `~/.config/iptv-relay/iptv-relay.env`. It only names the config
   file and, optionally, the NordVPN region (`RELAY_VPN_SERVER`, for example
   `canada`; empty means the desktop app's choice).
3. Enable and start:

   ```bash
   systemctl --user enable --now iptv-relay.service iptv-relay-health.timer
   ```

4. Starting takes up to a minute or two (it waits for the network and the VPN).
   Then check:

   ```bash
   relayctl selftest
   ```

5. **Start at boot without logging in:** user services normally run only
   while you are logged in. "Lingering" keeps them running from boot and after
   you log out. It is already enabled for `jackd` on this PC (the installer
   tells you); if it ever is not: `loginctl enable-linger jackd`.

To remove everything: `tools/multiplex-relay/systemd/uninstall.sh` (stops the
relay, removes the units and the `relayctl` link, keeps the config).

## Open the firewall for the TVs (once)

This PC's firewall (ufw) blocks port 8790 from other devices. Allow the home
network only:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 8790 proto tcp comment 'IPTV relay'
```

(Stricter variant, Wi-Fi interface only:
`sudo ufw allow from 192.168.1.0/24 to any port 8790 proto tcp comment 'IPTV relay'`.)
The relay's forwarder also refuses any address outside `lan.allowFrom` itself.

## Keep this PC's address fixed

The TVs are told `192.168.1.96`. If the router hands this PC a different
address after a restart, the TVs lose the relay. In the router's admin page,
find **DHCP reservation** (also called "static lease" or "address
reservation"), pick this PC (by its name or its Wi-Fi MAC address,
`ip link show wlp8s0`), and reserve `192.168.1.96`.

## Point TiviMate at the relay

Edit the existing Xtream playlist rather than adding a new one, so favourites,
groups and the guide stay: the relay keeps the provider's channel ids, so
TiviMate sees the same channels. (Expected from the design; *to confirm* on
the first TV.)

1. Get the address: `relayctl url` prints something like
   `http://192.168.1.96:8790`.
2. In TiviMate: **Settings > Playlists >** the provider's playlist **> Edit**
   (or **Change playlist URL / Xtream details**, depending on the version).
3. Server address: the URL from step 1. Username and password: the **local**
   login from the `clients` list of the relay config, *not* the provider's.
4. In the playlist's settings, stream format **TS** (MPEG-TS).
5. Save, let it update the playlist and guide.

**Switch back to direct** (for example while the PC is off for a long time):
edit the same playlist again and put back the provider's server address,
username and password. Only one TV can then watch at a time, as before.

## Day to day: `relayctl`

| Command | What it tells you |
| --- | --- |
| `relayctl status` | What is playing: the provider connection, each live channel and its players, the movie session, refusals, cache ages, uptime. |
| `relayctl selftest` | PASS/FAIL for: VPN tunnel up; VPN address differs from home address; port 8790 answers on 192.168.1.96; provider login works. Exit code non-zero on any failure. |
| `relayctl url` | The server address to type into TiviMate (never the login). |
| `relayctl logs` / `relayctl logs -f` | Recent log lines / follow them live. |
| `relayctl restart` (`start`, `stop`) | Restart (start, stop) the relay; the forwarder follows. |
| `relayctl health` | The quick local check the minute timer runs. |

`relayctl` reads the private config when it runs and never prints the
provider address, any login, or the status token. In `selftest`, "max
connections" is the relay's own limit (4 live channels), not the provider's.
The LAN check runs from this PC itself, so it cannot prove the firewall lets
the TVs in; if `selftest` passes but a TV cannot connect, check the ufw rule.

## Troubleshooting

`/status` fields are shown by `relayctl status`; names in brackets are the raw
field names.

| Symptom | Look at | Likely cause and fix |
| --- | --- | --- |
| TV says "connection refused" / cannot reach server | `relayctl selftest` | PC asleep or off; relay stopped (`relayctl start`); ufw rule missing (run the command above); PC got another address (DHCP reservation). |
| `selftest`: **egress is VPN: SAME (not protected)** | logs | The tunnel is not carrying traffic. The relay guard stops the relay by itself in this case. Run `relayctl restart`; if it repeats, try another region in `iptv-relay.env` (`RELAY_VPN_SERVER=`) and restart. Do not point TVs at the provider through this relay until it says `differs`. |
| `selftest`: VPN namespace FAIL | `systemctl status vopono.service` | The root vopono daemon is down (it must be running) or the relay is still starting (wait 2 min). |
| `selftest`: provider login FAILED | logs | Provider account problem, or the provider is down (HTTP 502). Check the account directly from one device. |
| Upstream **refusals** rising (`upstream.refusals`, `lastStatus` 4xx/5xx) | `relayctl status` | The provider is refusing the connection: usually another device is using the account directly (a phone, a TV still pointed at the provider). Stop that device. Each refusal makes the relay back off. |
| Upstream **peak** above 1 (`upstream.maxOpenAtOnce`, `gate.peak`) | `relayctl status` | A bug: report it, and restart the relay. |
| Picture freezes now and then; **dry stalls** rising (`dryStalls`) | `relayctl status`, channel row | The channel ran out of media: too many channels for the line speed, or the provider is slow. Watch fewer channels at once. |
| **Skipped** seconds rising (`skippedMs`) | channel row | The relay skipped content to catch up after a slow refill; you see a small jump. Same remedy as dry stalls. |
| **Backpressure** pauses/drops rising (`backpressurePauses`, `backpressureDrops`) | channel row | A TV is not reading fast enough (weak Wi-Fi, TV busy). Move the Fire TV closer to the router or use Ethernet. |
| Channel won't start; **503 live: over channel limit** (`refused503.liveCapacity`) | 503 row | Four different channels are already playing. Close one. |
| Channel won't start; **503 live: movie playing** (`refused503.liveWhileVod`) | 503 row, VOD session | A movie holds the connection. Stop the movie. |
| Movie won't start; **503 movie: live playing** (`refused503.vodWhileLive`) | 503 row | Live TV is playing on some TV. Stop it (or the relay config can use `"vodPolicy": "preempt"`). |
| Movie won't start; **503 movie: busy** (`refused503.vodBusy`) | VOD session | Another movie is playing. |
| "HLS refused" count rising (`http.m3u8Refused`) | `relayctl status` | TiviMate is set to HLS; set the playlist's stream format to TS. |
| "bad logins" rising (`http.unauthorized`) | `relayctl status` | A TV uses the wrong (perhaps the provider's) login; use the local one. |
| Guide or channel list old (cache "last age" large) | cache table | The relay serves its cached copy while the provider API fails; check `provider API failures` and the logs. |
| Restarts keep growing (`restarts` in `units`) | `relayctl logs` | The relay keeps failing to start: usually VPN or network trouble. It retries forever, waiting up to 5 min between tries. |
| Log: `every server of the region is already in use` | `relayctl logs` | Set another country in `RELAY_VPN_SERVER=` in `~/.config/iptv-relay/iptv-relay.env`, then `relayctl restart`. |
| Log: `launch failed: vopono daemon not available` | `systemctl status vopono.service` | The root VPN helper is not running; it is a system service (needs sudo to start). |
| Forwarder log `relayDown=` growing | `relayctl logs` | TVs reach the PC but the relay is not up yet (starting) or failing. |
| Forwarder log `denied=` growing | `relayctl logs` | A device outside `lan.allowFrom` (not on 192.168.1.x) tried to connect. |

## Suspend and resume

When the PC sleeps, the TVs lose the picture. On wake-up:

1. The relay's guard notices the time jump and checks again, within 90
   seconds, that traffic still leaves through the VPN. If the tunnel did not
   survive the sleep, it stops the relay, and systemd starts a fresh tunnel
   and relay (first retry after 5 s).
2. The health timer also runs right after wake-up and then every minute. If
   the relay or forwarder is still not answering after three checks in a row
   (and the relay has been running for 10 minutes, so it is not just slow to
   start), it restarts it. A relay you stopped yourself is left alone.

TiviMate usually reconnects by itself; if not, switch channel once.

Why a timer and not a "wake-up hook": user services cannot hook the system's
sleep events without root. A clock-based timer whose time passed during the
sleep fires as soon as the PC wakes, so the minute timer doubles as the
wake-up hook, and it also catches a relay that hangs at any other time. It
only checks local things (no provider or IP-echo requests every minute); the
VPN address itself is re-checked by the guard after every wake-up and every
30 minutes.

## When the VPN drops

The relay fails closed. The tunnel has a kill switch (no traffic at all
without the VPN), and the guard inside the tunnel stops the relay if its
checks fail: the tunnel is gone, the address is the same as home, or the
address cannot be verified. systemd then retries with a growing delay (5 s up
to 5 min) for as long as it takes; it never gives up and never falls back to
the home connection. While it retries, the TVs get "cannot connect".

## Service internals

### How the VPN is reused

The desktop app's **Settings > General > App VPN** setup had the vopono
helper exchange a Nord access token for NordLynx (WireGuard) credentials;
the helper stores them in its own files under `~/.config/vopono/nordvpn/`
with private permissions. Nothing in this fork stores them again.

The launcher asks the same root `vopono daemon` for a namespace, with the
command the app uses (`vpnLaunchArguments` in `linux-vpn-policy.ts`):
`vopono exec --provider nordvpn --protocol wireguard --server <server>
--custom-netns-name iptvrelay-<random> --vopono-config <own file> --json`.
Its own helper config sets `no_killswitch = false`, so user-wide vopono
defaults cannot turn the kill switch off. The daemon appends `-u<uid>`, so
the namespace is `iptvrelay-<8 hex>-u1000`, distinct from the app's
`iptvnator-<hash>-<session>-u1000`.

The region comes from `RELAY_VPN_SERVER` in the env file, else from the
`server` field of the app's `linux-vpn.json` (it holds only
`server`/`configured`/`enabled`), else `canada`. The launcher then picks one
specific server of that region that no other running namespace uses: it
lists the helper's server file names (never their contents) and skips
servers in `vopono list namespaces`. If the app's own choice is a specific
server already in use, it takes another server of the same country. A server
whose tunnel does not pass traffic within 30 s is replaced by another one,
up to three times; then systemd retries later.

**App and relay at the same time** work: both use the same NordLynx key, but
on two different servers, which was tested live (both namespaces reached the
internet at once, with different public IPs). They must not share a server:
one WireGuard key on one server from two tunnels makes the server flip
between the two endpoints. The launcher prevents that for the relay; the
desktop app does not know about the relay, so start the app first or keep
its region choice specific. Note what the provider sees: if the desktop app
also plays from the same IPTV account, that is a second connection from a
second VPN address. While the relay serves the TVs, do not play from the
account in the desktop app (or point the app at the relay too).

### Fail-closed checks

The relay never runs on the bare host network:

1. The guard only starts if `VOPONO_NS` is the expected name, its own
   `/proc/self/ns/net` inode equals `/run/netns/<name>`'s and differs from
   the host inode the launcher measured, and the launch permit file exists.
2. It compares the namespace's public IP with the host's (neutral echo:
   api.ipify.org, then icanhazip.com; no account data sent) and starts the
   relay only if they differ. Logs say `differs`/`same`, never an address.
3. Every 3 s it repeats the identity checks and checks that the launcher is
   alive; any failure kills the relay and exits non-zero.
4. After a suspend (wall clock jumps ahead of the monotonic clock) and every
   30 min it re-verifies egress, allowing 90 s for the tunnel to come back;
   `same` or no answer kills the relay.
5. Underneath, the helper's WireGuard kill switch stays on: without the
   tunnel the namespace has no route out at all.

Verified live with a synthetic config: the guard refuses on the host network
and with a wrong namespace name (exit 3); a server that never passed traffic
was rejected without starting the relay (exit 5); revoking the permit,
`vopono stop namespace`, `systemctl --user stop` and `SIGKILL` of the
launcher all ended with the relay and its namespace gone.

### Reaching it from the LAN

The helper firewalls the namespace from the host and the LAN. Two ways out
were compared on this PC:

- `vopono exec -f <port>` does expose the port on every host interface
  (`*:<port>`, tested with a dummy server on 18791), but every connection
  then appears to come from the namespace gateway, so the relay cannot tell
  clients apart (zap detection, per-client status), and the listener belongs
  to the root daemon with no source filter.
- A unix socket (chosen): the relay listens on
  `$XDG_RUNTIME_DIR/iptv-relay/relay.sock` (mode 0600, directory 0700) and
  the forwarder on the host listens on `lan.listen` and admits only
  `lan.allowFrom` subnets. It adds a PROXY v1 line, so the relay sees the
  real client address. Proven end to end with the real launcher: a request to
  `http://192.168.1.96:18791/<token>/status` from this host reached the
  relay inside the namespace and was logged as from `192.168.1.96`.

## To confirm

These were written against the launcher and relay code as of this page's
commit and are not yet checked on the real setup:

- TiviMate keeps favourites after editing the playlist's server and login.
- First start time (VPN handshake plus catalogue warm-up) and typical delay
  behind live on the real provider.
- `relayctl selftest` and `relayctl health --repair` against the running
  service (only checked against a fake relay so far).
