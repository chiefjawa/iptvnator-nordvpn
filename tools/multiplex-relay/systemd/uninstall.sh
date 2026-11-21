#!/usr/bin/env bash
# Removes the IPTV LAN relay's systemd USER units installed by install.sh.
#
#   tools/multiplex-relay/systemd/uninstall.sh
#
# Stops and disables the units (the relay closes its provider connection and
# its VPN namespace on stop), removes the unit files and the relayctl link,
# and reloads the user manager. Keeps ~/.config/iptv-relay/ (it holds only
# the config path) and never touches the private relay config. Safe to run
# again. Overrides as in install.sh: SYSTEMD_USER_DIR, RELAY_CONFIG_DIR,
# RELAY_BIN_DIR.
set -euo pipefail

here=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
repo=$(cd "$here/../../.." && pwd)
config_home=${XDG_CONFIG_HOME:-$HOME/.config}
units_dir=${SYSTEMD_USER_DIR:-$config_home/systemd/user}
config_dir=${RELAY_CONFIG_DIR:-$config_home/iptv-relay}
bin_dir=${RELAY_BIN_DIR:-$HOME/.local/bin}
# Timer first, so it cannot start a health check while the relay stops.
units=(iptv-relay-health.timer iptv-relay-health.service iptv-relay.service iptv-relay-forwarder.service)
lan_subnet=192.168.1.0/24
lan_port=8790

note() { printf '%s\n' "$*"; }

if [[ -z ${SYSTEMD_USER_DIR:-} ]]; then
    for unit in "${units[@]}"; do
        if [[ -f $units_dir/$unit ]]; then
            # Static units (forwarder, health service) cannot be disabled; stop only.
            systemctl --user disable --now "$unit" >/dev/null 2>&1 ||
                systemctl --user stop "$unit" >/dev/null 2>&1 || true
            note "stopped    $unit"
        fi
    done
fi

for unit in "${units[@]}"; do
    if [[ -e $units_dir/$unit || -L $units_dir/$unit ]]; then
        rm -f "$units_dir/$unit"
        note "removed    $units_dir/$unit"
    fi
done

if [[ $(readlink "$bin_dir/relayctl" 2>/dev/null || true) == "$repo/tools/multiplex-relay/relayctl" ]]; then
    rm -f "$bin_dir/relayctl"
    note "removed    $bin_dir/relayctl"
fi

if [[ -z ${SYSTEMD_USER_DIR:-} ]]; then
    systemctl --user daemon-reload
    systemctl --user reset-failed "${units[@]}" >/dev/null 2>&1 || true
    note "reloaded   systemd user manager"
fi

cat <<MSG

Kept $config_dir (only the config path; delete it by hand if wanted):
  rm -r $config_dir

To close the firewall port again (needs your sudo password):
  sudo ufw delete allow from $lan_subnet to any port $lan_port proto tcp
(or find it with: sudo ufw status numbered, then: sudo ufw delete <number>)

Lingering was left as it is (other user services may rely on it).
Point TiviMate back at the provider's own server URL and login to watch directly.
MSG
