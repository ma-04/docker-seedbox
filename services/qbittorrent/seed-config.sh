#!/bin/sh
# Seeds / enforces qBittorrent.conf, then hands over to the official entrypoint
# (which drops to uid/gid $PUID/$PGID = 1000).
set -eu

# Never run the torrent client (internet-facing, parses untrusted input) as root.
case "${PUID:-1000}" in ''|*[!0-9]*) echo "seed-config: PUID must be a number" >&2; exit 1 ;; esac
case "${PGID:-1000}" in ''|*[!0-9]*) echo "seed-config: PGID must be a number" >&2; exit 1 ;; esac
PUID=${PUID:-1000}; PGID=${PGID:-1000}
if [ "$PUID" -eq 0 ] || [ "$PGID" -eq 0 ]; then
  echo "seed-config: refusing to run qBittorrent as uid/gid 0 (PUID=$PUID PGID=$PGID); use a non-zero PUID/PGID" >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ] && [ "$(id -u)" -ne "$PUID" ]; then
  echo "seed-config: running as uid $(id -u), which is not PUID=$PUID" >&2
fi

CONF=/config/qBittorrent/config/qBittorrent.conf
mkdir -p "$(dirname "$CONF")"
[ -f "$CONF" ] || : > "$CONF"

# set_key SECTION KEY VALUE : replace KEY inside [SECTION] or add it (creating the section).
set_key() {
  SEC="$1" KEY="$2" VAL="$3" awk '
    BEGIN { sec = ENVIRON["SEC"]; key = ENVIRON["KEY"]; val = ENVIRON["VAL"] }
    function flush() { if (insec && !done) { print key "=" val; done = 1 } }
    /^\[.*\]$/ { flush(); insec = ($0 == "[" sec "]"); if (insec) seen = 1; print; next }
    insec && index($0, key "=") == 1 { if (!done) { print key "=" val; done = 1 } ; next }
    { print }
    END { flush(); if (!seen) { print "[" sec "]"; print key "=" val } }
  ' "$CONF" > "$CONF.tmp" && cat "$CONF.tmp" > "$CONF" && rm -f "$CONF.tmp"
}

# WebUI access without a password is granted ONLY to the addresses in QBT_TRUSTED_IPS (compose gives `api` and
# `worker` static IPs and passes exactly those two). Everything else in the compose network, e.g. a compromised
# sibling container, must authenticate, and nobody knows the password: with no WebUI password stored, qBittorrent
# (>= 4.6.1) generates a random temporary one at every start and only prints it to the log. Anyone who could call
# setPreferences/autorun would get code execution in this container, so an empty list means "nobody".
TRUSTED=""
for ip in $(printf '%s' "${QBT_TRUSTED_IPS:-}" | tr ',' ' '); do
  case "$ip" in
    ''|*[!0-9a-fA-F:./]*) echo "seed-config: invalid QBT_TRUSTED_IPS entry '$ip'" >&2; exit 1 ;;
  esac
  case "$ip" in */*) ;; *:*) ip="$ip/128" ;; *) ip="$ip/32" ;; esac
  TRUSTED="${TRUSTED:+$TRUSTED, }$ip"   # Qt reads an unquoted "a, b" as a string list
done
if [ -z "$TRUSTED" ]; then
  echo "seed-config: QBT_TRUSTED_IPS is empty: the WebUI will require a password nobody knows, so api/worker cannot reach it" >&2
  set_key WebUI 'AuthSubnetWhitelistEnabled' false
else
  set_key WebUI 'AuthSubnetWhitelistEnabled' true
fi

# Always enforced (the WebUI is only reachable inside the compose network and is never routed by the gateway).
set_key WebUI 'Address' '*'
set_key WebUI 'Port' "${QBT_WEBUI_PORT:-8080}"
set_key WebUI 'AuthSubnetWhitelist' "$TRUSTED"
# Loopback is shared only with the vpn sidecar (same network namespace); siblings arrive with their own address.
set_key WebUI 'LocalHostAuth' false
set_key WebUI 'HostHeaderValidation' false
set_key WebUI 'ServerDomains' '*'
set_key WebUI 'CSRFProtection' false
set_key WebUI 'ClickjackingProtection' false
set_key LegalNotice Accepted true
set_key Network 'PortForwardingEnabled' false   # UPnP / NAT-PMP
set_key BitTorrent 'Session\AnonymousModeEnabled' false
set_key BitTorrent 'Session\Interface' ''
set_key BitTorrent 'Session\InterfaceName' ''
set_key BitTorrent 'Session\InterfaceAddress' ''

# Defaults on first start only (an admin may change these later in the WebUI).
if ! grep -q 'Session.DefaultSavePath=' "$CONF"; then
  set_key BitTorrent 'Session\DefaultSavePath' /downloads/incomplete
  set_key BitTorrent 'Session\TempPathEnabled' false
  set_key BitTorrent 'Session\Preallocation' false
  set_key BitTorrent 'Session\DHTEnabled' true
  set_key BitTorrent 'Session\PeXEnabled' true
  set_key BitTorrent 'Session\LSDEnabled' false
  set_key BitTorrent 'Session\Port' 6881
  set_key Meta 'MigrationVersion' 9999
fi

mkdir -p /downloads/incomplete
chown "$PUID:$PGID" /downloads /downloads/incomplete /config 2>/dev/null || true
exec /entrypoint.sh "$@"
