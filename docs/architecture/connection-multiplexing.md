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
