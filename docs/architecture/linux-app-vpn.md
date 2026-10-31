# Linux app-only NordVPN

This personal fork adds NordVPN account setup and app-only protection to the
Linux Electron player. It is independent of the NordVPN desktop app and does
not change the computer's default route.

## Usage

1. Install the token-capable **vopono** helper, `wireguard-tools`, and its
   privileged daemon. Use the current upstream source whose NordVPN provider
   implements token-based WireGuard sync; older OpenVPN-only builds are not
   compatible. Consult the [helper's guide](https://github.com/jamesmcm/vopono/blob/master/USERGUIDE.md#nordvpn).
   On Arch, the `vopono-git` package is an option. Follow the helper's service
   installation instructions; the player never runs as root and does not
   install sudo rules.
2. In **Settings > General > App VPN**, paste an access token from your Nord
   Account and choose **Set up account**. The helper exchanges it for NordLynx
   credentials. IPTVnator does not retain the account token. The helper owns
   its derived-key configuration and applies its normal private permissions.
3. Choose a region and **Connect and restart player**. All playlist requests,
   artwork, built-in playback, downloads and newly launched native MPV/VLC
   players inherit the protected connection.
4. **Disconnect and close player** closes this protected session. Reopen the
   desktop launcher to use normal internet. A process cannot move its running
   Chromium threads back to the host network safely, so disconnect does not
   pretend to be an in-place toggle.

This does not provide an IPTV subscription or change a provider's concurrent
connection limit. Test with synthetic/local media first; do not open another
subscription stream on a phone or TV during a one-connection playback test.

## Enforcement and process ownership

`linux-vpn-startup.ts` gates ordinary application bootstrap **before** the
viewing window, its deferred events, update checks or provider requests start.
An unprotected controller starts vopono with a fixed NordVPN/WireGuard command
and a per-profile namespace name. The daemon runs the child player as the user.
The controller holds a separate, temporary Chromium session directory, drains
helper/player output without logging it, and lives until the protected app exits.
It must not acquire the viewing player's single-instance lock or Chromium data.

The protected child verifies its actual kernel network namespace inode against
the named namespace and the original host inode. An environment variable alone
never makes the UI report protection. The helper's default WireGuard kill switch
remains enabled; there is no normal-network fallback on a connection failure.
Only an explicit native-dialog action can turn protection off and open normally.
The status label means the app is inside the managed protected namespace; it is
not a promise that the remote server is reachable at every instant.

External-player reuse is disabled during protected sessions. VLC also receives
`--no-one-instance` after custom arguments, preventing a handoff to an already
running unprotected VLC. Host-spawn bridges in Flatpak are refused while app VPN
is active; use the built-in player. AppImage/native builds are the intended
installation targets. Do not add a proxy-only implementation: it would miss
Node requests, DNS, external players or media subrequests.

## Credentials and persistence

A separate main-owned `linux-vpn.json` under Electron userData stores only the
server prefix, configured flag and enable preference. Writes use a mode0600
sibling followed by atomic rename. Malformed existing settings fail closed;
they do not silently become a disabled VPN. A missing file starts disabled.
Tokens go through a named `token` IPC field for shared-log redaction, then the
one-time helper's environment. They never enter command arguments, settings
exports, errors, status responses or application logging. The input clears after
setup, including failed setup. Never use a real token in automated tests.

Changing the connection closes/restarts the player, so save any other pending
settings before using the connection button. The fork's updater repositories
point to `chiefjawa/iptvnator-nordvpn`; upstream official builds must not replace
the added protection. The nightly feed is reserved at
`chiefjawa/iptvnator-nordvpn-nightly`; this fork does not currently publish nightly
builds. Use the stable update channel. The original MIT license and upstream
credits remain.

## Validation and limits

Focused Jest tests cover configuration corruption, namespace identity, shell
argument escaping through a real shell, token handoff, connection preconditions,
and startup failure. Electron E2E exercises the real preload/settings/account
setup workflow using an isolated synthetic helper. This proves UI and IPC, not a
real NordVPN handshake or firewall behavior. Live acceptance additionally needs
the helper/daemon and a real account token: compare host/app egress, confirm a
player's namespace, interrupt its tunnel and verify traffic stays blocked, then
close the app and confirm the host route is unchanged. Never report mocked tests
as proof that those live network checks passed.
