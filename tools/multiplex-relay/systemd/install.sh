#!/usr/bin/env bash
# Installs the IPTV LAN relay as systemd USER units (no root needed).
#
#   tools/multiplex-relay/systemd/install.sh
#
# Renders the unit templates in this directory (@NODE@, @REPO@) into
# ~/.config/systemd/user/, creates ~/.config/iptv-relay/iptv-relay.env if it
# is missing (it only names the private config path, no secrets), links
# relayctl into ~/.local/bin and reloads the user manager. It never enables
# or starts anything: it prints those commands. Safe to run again.
#
# Overrides: RELAY_NODE (node binary), SYSTEMD_USER_DIR (target dir; also
# skips daemon-reload), RELAY_CONFIG_DIR, RELAY_BIN_DIR.
set -euo pipefail

here=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
repo=$(cd "$here/../../.." && pwd)
config_home=${XDG_CONFIG_HOME:-$HOME/.config}
units_dir=${SYSTEMD_USER_DIR:-$config_home/systemd/user}
config_dir=${RELAY_CONFIG_DIR:-$config_home/iptv-relay}
bin_dir=${RELAY_BIN_DIR:-$HOME/.local/bin}
env_file=$config_dir/iptv-relay.env
pinned_node=/home/jackd/Work/.toolchains/iptvnator-mise/installs/node/24.22.1/bin/node
private_config=/home/jackd/Work/iptvnator-private/multiplex-relay.private.json
units=(iptv-relay.service iptv-relay-forwarder.service iptv-relay-health.service iptv-relay-health.timer)
lan_subnet=192.168.1.0/24
lan_port=8790

note() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
fail() { printf 'install: %s\n' "$*" >&2; exit 2; }

node_bin=${RELAY_NODE:-}
if [[ -z $node_bin && -x $pinned_node ]]; then node_bin=$pinned_node; fi
if [[ -z $node_bin ]]; then node_bin=$(command -v node || true); fi
[[ -n $node_bin && -x $node_bin ]] || fail "node not found; set RELAY_NODE=/path/to/node"

# Both paths go into unit files and a sed replacement unquoted.
for value in "$repo" "$node_bin"; do
    [[ $value =~ ^[A-Za-z0-9._/+@-]+$ ]] || fail "path has characters a unit file cannot take: $value"
done

# Prerequisites: reported, not fatal, so the units can be installed first.
for bundle in main.js forwarder.js; do
    [[ -f $repo/dist/apps/multiplex-relay/$bundle ]] ||
        warn "dist/apps/multiplex-relay/$bundle is missing; build it: pnpm nx run electron-backend:build-multiplex-relay"
done
command -v vopono >/dev/null 2>&1 || warn "vopono is not on PATH"
if ! systemctl is-active --quiet vopono.service 2>/dev/null; then
    warn "the system vopono.service (root vopono daemon) is not active"
fi

changed=0
mkdir -p "$units_dir"
for unit in "${units[@]}"; do
    src=$here/$unit
    dst=$units_dir/$unit
    [[ -f $src ]] || fail "missing template $src"
    tmp=$(mktemp "$units_dir/.$unit.XXXXXX")
    sed -e "s#@NODE@#$node_bin#g" -e "s#@REPO@#$repo#g" "$src" >"$tmp"
    chmod 0644 "$tmp"
    if [[ -f $dst ]] && cmp -s "$tmp" "$dst"; then
        rm -f "$tmp"
        note "unchanged  $dst"
    else
        mv -f "$tmp" "$dst"
        changed=1
        note "installed  $dst"
    fi
done

(umask 077 && mkdir -p "$config_dir")
if [[ -f $env_file ]]; then
    note "kept       $env_file"
else
    example=$repo/tools/multiplex-relay/iptv-relay.env.example
    (
        umask 077
        if [[ -f $example ]]; then
            cat "$example"
        else
            printf '# Not secret: names where the private relay config lives.\n'
            printf 'MULTIPLEX_RELAY_CONFIG=%s\n' "$private_config"
            printf 'RELAY_VPN_SERVER=\n'
        fi
        printf 'RELAY_NODE=%s\n' "$node_bin"
    ) >"$env_file"
    chmod 0600 "$env_file"
    note "created    $env_file (review it)"
fi

mkdir -p "$bin_dir"
if [[ $(readlink "$bin_dir/relayctl" 2>/dev/null || true) == "$repo/tools/multiplex-relay/relayctl" ]]; then
    note "unchanged  $bin_dir/relayctl"
else
    ln -sfn "$repo/tools/multiplex-relay/relayctl" "$bin_dir/relayctl"
    note "linked     $bin_dir/relayctl"
fi
case ":$PATH:" in
*":$bin_dir:"*) ;;
*) warn "$bin_dir is not on PATH; call relayctl by its full path" ;;
esac

if [[ -z ${SYSTEMD_USER_DIR:-} ]]; then
    systemctl --user daemon-reload
    note "reloaded   systemd user manager"
elif ((changed)); then
    note "(SYSTEMD_USER_DIR set: daemon-reload skipped)"
fi

config_from_env=$(sed -n 's/^MULTIPLEX_RELAY_CONFIG=//p' "$env_file" | tail -n 1)
if [[ -z $config_from_env ]]; then
    warn "MULTIPLEX_RELAY_CONFIG is empty in $env_file"
elif [[ ! -f $config_from_env ]]; then
    warn "the relay config named in $env_file does not exist yet"
fi

linger=$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo unknown)

cat <<MSG

Nothing was enabled or started. Next steps (run them yourself):

1. If a trial relay was started by hand, stop it first (port $lan_port must be free):
     ss -ltnp 'sport = :$lan_port'

2. Enable and start the relay and its minute health check:
     systemctl --user enable --now iptv-relay.service iptv-relay-health.timer

3. Check it:
     relayctl selftest
     relayctl status
     relayctl url

4. Let the TVs in through the firewall (once, needs your sudo password):
     sudo ufw allow from $lan_subnet to any port $lan_port proto tcp comment 'IPTV relay'

MSG
if [[ $linger == yes ]]; then
    note "5. Lingering is already enabled for $(id -un): the relay starts at boot and keeps"
    note "   running after you log out. Nothing to do."
else
    note "5. Needed so the relay starts at boot and keeps running after you log out"
    note "   (without it, user services run only while you are logged in):"
    note "     loginctl enable-linger $(id -un)"
fi
