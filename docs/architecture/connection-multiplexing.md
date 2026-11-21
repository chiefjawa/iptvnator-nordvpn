# Connection multiplexing (multiview on one connection)

The Xtream multiview (`live/multiview`) shows up to four live channels. With
the `connectionMultiplexing` setting on, all tiles of a playlist share one
connection to the provider and take turns on it. Single-channel playback never
uses any of this.

## Why it works

When a live MPEG-TS channel is opened, most servers send a burst: 15-25 s of
content as fast as the line allows, then real-time pacing. A tile takes the
burst, plays from that reserve, and gives the connection to the tile with the
least media left. A tile can never hold more than its distance behind the live
edge, so once delivery falls to real time the tile is full.

A revisit can only be stitched on while the tile's last frame is still inside
the provider's burst window: the time since that frame was live must stay
below the burst depth. This is a different quantity from the tile's reserve
(media ahead of its playhead), which is what the rotation orders by. A visit
cut short leaves the tile behind the live edge by the burst it did not take.
That is why a tile with nothing on screen yet never interrupts a burst (only
after `coldPreemptAfterMs` on a provider that bursts unusually long): every
first visit runs to the live edge, so each tile starts with the full depth as
headroom. When cold tiles could interrupt at `minNewMediaMs` (12 s of a 25 s
burst), four tiles reached their second visit with no overlap left, and a
slightly slower open or player start showed "skipped". The cost is a later
first picture on the last tile: about one visit (connect + burst + 1 s) per
tile before it.

Whether a provider bursts is measurable: launch with
`IPTVNATOR_MULTIPLEX_PROBE=1` (optionally `_CHANNEL=<title part>` and
`_OUT=<report path>`). The probe opens one channel, reopens it after 2, 5, 10
and 20 s, and writes numbers only: burst depth and rate, overlap between
connections, and whether timestamps continue across connections.

## Pieces (`apps/electron-backend/src/app/multiplex/`)

| Part | Role |
| --- | --- |
| `ts/` | Packet alignment, PAT/PMT, PES timestamps, keyframe detection, clock and continuity rewriting |
| `splicer/segmenter.ts` | Cuts a connection's mux into keyframe-to-keyframe segments |
| `splicer/tile-splicer.ts` | Drops the repeated start of each visit and joins the rest into one gapless stream |
| `scheduler/group-scheduler.ts` | Rotates the single connection; `visit-policy.ts` decides when a visit ends |
| `relay/relay-server.ts` | Loopback HTTP server each tile plays from |
| `multiplex-manager.ts` | Sessions; one scheduler per group key (playlist id) |

Renderer: `libs/ui/playback/src/lib/multiview/` (tile player, session
service) and `libs/portal/xtream/feature/src/lib/multiview/` (screen, picker).
IPC is `MULTIPLEX:*` in `connection-multiplex.interface.ts`.

The screen restores its last tiles per playlist (`multiview-persistence.ts`)
and keeps up to 12 named layouts (`multiview-layouts.ts`); both store stream
ids and names only, never URLs. Switching layouts keeps the tiles whose
channel stays, so their shared-connection reserve is not thrown away.

Keys (`multiview-keyboard.ts`, listed in the shortcuts help): `1`-`4` give a
tile the sound, `F`/`Enter` enlarge it, `Escape` returns to the grid, `M`
mutes it. They are bare keys, ignored in fields, dialogs, menus and the
picker. An enlarged tile fills the grid while the others shrink into a
strip beside it rather than being hidden: they keep playing and reporting
progress, so the scheduler neither starves nor over-serves them.

## Invariants

- **One connection per group.** A connection is closed, confirmed closed, and
  a gap passes before the next opens. A refusal is answered by backoff and a
  longer gap, never by a second connection.
- **Segments are cut on the whole mux at video keyframes**, so segments from
  different connections join at identical byte positions.
- **Alignment is by keyframe content first** (hash of the keyframe's leading
  bytes), which also handles servers that restart timestamps; matching
  timestamps are the fallback.
- **The output timeline has no gaps.** Missed content is skipped by pulling
  the output clock back and reporting `skippedMs`; mpegts.js would otherwise
  fill audio gaps with silence.
- **Tiles do not use `WebPlayerViewComponent`.** Its recovery controller would
  reload a tile that is only waiting for its turn.
- **Sessions die with their window** (destroyed, crashed, reloaded) and on
  shutdown, so no provider connection outlives the multiview.
- **The relay is loopback only**, on an ephemeral port, with an unguessable
  token in every URL and a `Host` check. Stream URLs and credentials never
  appear in relay URLs, logs or the probe report.

## Limits

- MPEG-TS live channels with H.264/HEVC video. HLS-only accounts and channels
  fall back to one connection per tile.
- Capacity depends on burst depth and line speed versus channel bitrate.
- Direct (non-shared) tiles do not apply per-playlist request headers.
- Open-GOP streams can show a brief artefact where content was skipped.

## Validation

Unit specs sit beside each part; `testing/fake-provider.ts` is a
single-connection server on an accelerated clock, used to assert the
one-connection invariant for one to four tiles. The cold-start specs configure
it like a real deep-burst provider (25 s at 12x, 1 s open, 2 s GOPs, burst
starting on the keyframe after the depth) and require every revisit in the
first minute to overlap by at least one GOP, for two to four tiles. There is no Electron E2E yet;
the feature was validated over CDP against a real provider.

## Standalone LAN relay

`multiplex/lan-relay/` is a plain-Node program built from the same engine
(`pnpm nx run electron-backend:build-multiplex-relay`; see its README for
config and endpoints). It serves players on the home network that cannot
report their buffer, such as ExoPlayer-based TV apps, through one provider
connection, behind an Xtream-compatible front so a player's existing
Xtream playlist can be re-pointed at it with its favourites (stream ids are
the provider's). It lives in the `electron-backend` project because Nx does
not let one app import another, and the engine has no Electron imports; the
bundle fails to build if `electron` is ever pulled in. The protected service
launch (own NordVPN namespace, unix socket, host forwarder) is described in
`tools/multiplex-relay/INTERFACE.md`; running it at home:
[operating the relay](multiplex-relay-operations.md).

- **One connection, live and VOD.** Every provider stream request passes
  `UpstreamGate`, which admits one at a time and is released only when the
  socket is confirmed closed; its peak is in `/status` (`upstream.gate`).
  API requests (`player_api.php`, `xmltv.php`) are not stream connections
  on Xtream panels and do not pass it; they run at most two at once.
- **Live.** Any stream id may be requested; every live channel is a tile of
  one `GroupScheduler`, with the invariants above unchanged. At most
  `maxLiveChannels` (4); a request beyond gets 503 after unwatched
  channels are evicted. A channel left by a zap (same address asks for
  another channel within 2 s) keeps 1 s of grace instead of 8 s.
- **The relay holds the reserve.** Each tile's spliced output is queued as
  whole segments. The reserve reported to the scheduler every 500 ms is the
  slowest client's unsent media plus its estimated player cushion.
- **Paced output and keep-alive** (proven on a real TV; not retuned):
  `fastStartSec` 3, then real time at `overdrive` 1.02 below
  `targetCushionSec` 6; null packets after 300 ms of silence;
  backpressure pauses; queues capped at 120 s / 64 MB per channel and
  256 MB together.
- **Robustness.** A connection that delivers nothing for 20 s is dropped
  (a dead tunnel often leaves a silent socket), the scheduler backs off;
  clients of a channel without media for 60 s are ended cleanly once
  their queue is empty, and reconnect on their own.
- **VOD and catch-up** are byte proxies with Range/HEAD and the same
  validated-redirect policy. They need the connection exclusively: with no
  live clients, unwatched channels are dropped and the movie proceeds; with
  live clients `vodPolicy: "refuse"` answers 503, `"preempt"` suspends the
  rotation and resumes it after the movie. While a movie session exists new
  live requests get 503. Requests for the same item from the same address
  form one session: a newer range cancels the older upstream request and
  waits for its socket to close; the same address asking for another item
  replaces the session; another address gets 503. The session ends 3 s
  after its last request.
- **No provider leaks.** Answers are sanitized into templates when fetched
  (stream URLs rewritten to the relay, `direct_source` and other provider
  URLs blanked, host/account in free text replaced) and only templates are
  cached. The guide is scrubbed while streaming and stored gzip. Response
  headers from the provider are never forwarded except a fixed byte-range
  set for VOD.

Limits: N live channels **or** one movie/catch-up at a time; MPEG-TS only
(no HLS); the cushion is an estimate; credentials shorter than 6
characters are only scrubbed inside URLs; provider-hosted artwork is
blanked, not proxied; `get.php` lists live channels and movies, not series
episodes. Validated with synthetic specs (`lan-relay*.spec.ts`,
`relay-front.spec.ts` with a leak sweep over every endpoint and header,
`relay-vod.spec.ts`, `lan-relay-admission.spec.ts`) against the fake
provider and `testing/fake-panel.ts`, and live on a Fire TV (TiviMate,
two-channel multiview, 9 min, no skips or reconnects) before the Xtream
front was added.
