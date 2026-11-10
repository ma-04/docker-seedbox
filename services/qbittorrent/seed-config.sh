#!/bin/sh
# Seeds / enforces qBittorrent.conf, then hands over to the official entrypoint
# (which drops to uid/gid $PUID/$PGID = 1000).
set -eu
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

# Qt reads an unquoted "a, b" as a string list.
LAN=$(echo "$LAN_CIDRS" | tr -d ' ' | sed 's/,/, /g')

# Always enforced (the WebUI is only reachable inside the compose network and is never routed by the gateway).
set_key WebUI 'Address' '*'
set_key WebUI 'Port' "${QBT_WEBUI_PORT:-8080}"
set_key WebUI 'AuthSubnetWhitelistEnabled' true
set_key WebUI 'AuthSubnetWhitelist' "$LAN"
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
