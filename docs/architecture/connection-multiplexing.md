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

## Standalone LAN relay (trial)

`multiplex/lan-relay/` is a plain-Node program built from the same engine
(`pnpm nx run electron-backend:build-multiplex-relay`, then
`node dist/apps/multiplex-relay/main.js --config <file>`; see its README).
It serves configured channels to players on the home network that cannot
report their buffer, such as ExoPlayer-based TV apps, through one provider
connection. It lives in the `electron-backend` project because Nx does not
let one app import another, and the engine has no Electron imports; the
bundle fails to build if `electron` is ever pulled in.

- **One group.** Every configured channel is a tile of one
  `GroupScheduler`, with the invariants above unchanged. The relay's opener
  also counts open connections and refuses to open a second one itself.
- **The relay holds the reserve.** Each tile's spliced output is queued as
  whole segments (PAT, PMT, keyframe onward). The reserve reported to the
  scheduler, every 500 ms, is the slowest client's queued-but-unsent media
  plus its estimated player cushion; a tile with no clients reports its
  queue length without draining.
- **Paced output.** A client gets `fastStartSec` (3 s) at once, then media
  at real time, at `overdrive` (1.02) while its estimated cushion is under
  `targetCushionSec` (6 s). After a dry spell at most one fast start is
  sent at once.
- **Keep-alive.** With nothing to send, 4 null packets (PID 0x1FFF) go out
  after every 300 ms of silence, so the socket never goes quiet; dry spells
  are counted.
- **Backpressure and memory.** A client whose socket is full is paused (not
  even keep-alive is written) until it drains. Queues are capped at 120 s or
  64 MB per channel and 256 MB together; the oldest segment is dropped, and
  a client still on it skips ahead to the next segment start (a
  `backpressureDrop`).
- **Clients.** The first request for a stream id creates its tile; more
  clients for it share the queue. A client joining a running tile, or
  reconnecting within the 8 s grace period after the last one left, starts
  on the segment `joinBacklogSec` (3 s) before the queue's end. After the
  grace the tile is removed.

Limits: the cushion is an estimate (the relay cannot see the player); a
joiner starts with only `joinBacklogSec` of relay-side reserve, so the
scheduler serves it next; a skip over dropped media is a timestamp and
continuity jump the player must absorb; there is no transcoding, HLS or
catch-up. Validated with synthetic specs (`lan-relay*.spec.ts`: two and
three channels on the deep-burst fake provider, fan-out, grace, backpressure,
memory cap, secret-free logs, real-socket HTTP) and with ffmpeg on real
H.264/AAC served through a file-backed fake provider; not yet on a real
player.
