#!/bin/sh
# Seeds / enforces qBittorrent.conf. Runs as the UNPRIVILEGED user (PUID:PGID, see seed-config.sh), never as root:
# /config is owned by that user and therefore by a possibly compromised qBittorrent, which can plant symlinks anywhere
# in it. Everything below is written so that a symlink can neither redirect a write nor be followed:
#  - the directory chain is checked with `[ -L ]` (and re-created if it is a link);
#  - the config is edited into a temp file made by mktemp (random name, O_EXCL) in the same directory and moved over
#    the config with rename(2), which replaces a planted link instead of writing through it;
#  - no fixed `*.tmp` name, no `> "$CONF"` redirection.
# Env: CONFIG_DIR (default /config), QBT_TRUSTED_IPS, QBT_WEBUI_PORT.
set -eu
umask 077

CONFIG_DIR=${CONFIG_DIR:-/config}
CONFDIR="$CONFIG_DIR/qBittorrent/config"
CONF="$CONFDIR/qBittorrent.conf"

die() { echo "seed-config: $*" >&2; exit 1; }

[ -d "$CONFIG_DIR" ] && [ ! -L "$CONFIG_DIR" ] || die "$CONFIG_DIR must be a real directory"
for d in "$CONFIG_DIR/qBittorrent" "$CONFDIR"; do
  # A planted link in place of a directory is removed (rm on a link never follows it), then the directory is created.
  if [ -L "$d" ]; then rm -f -- "$d"; fi
  [ -d "$d" ] || mkdir -- "$d"
  [ ! -L "$d" ] && [ -d "$d" ] || die "$d is not a plain directory"
done
if [ -L "$CONF" ] || { [ -e "$CONF" ] && [ ! -f "$CONF" ]; }; then rm -rf -- "$CONF"; fi
[ -f "$CONF" ] || : > "$CONF"

TMPS=""
cleanup() { for f in $TMPS; do rm -f -- "$f"; done; }
trap cleanup EXIT

# newtmp: a fresh private temp file next to the config (same filesystem, so the final mv is a rename).
newtmp() { T=$(mktemp "$CONFDIR/.qbt-edit.XXXXXX") || die "cannot create a temp file in $CONFDIR"; TMPS="$TMPS $T"; }

# set_key SECTION KEY VALUE : replace KEY inside [SECTION] or add it (creating the section).
set_key() {
  newtmp
  SEC="$1" KEY="$2" VAL="$3" awk '
    BEGIN { sec = ENVIRON["SEC"]; key = ENVIRON["KEY"]; val = ENVIRON["VAL"] }
    function flush() { if (insec && !done) { print key "=" val; done = 1 } }
    /^\[.*\]$/ { flush(); insec = ($0 == "[" sec "]"); if (insec) seen = 1; print; next }
    insec && index($0, key "=") == 1 { if (!done) { print key "=" val; done = 1 } ; next }
    { print }
    END { flush(); if (!seen) { print "[" sec "]"; print key "=" val } }
  ' "$CONF" > "$T" && mv -f -- "$T" "$CONF"
}

# WebUI access without a password is granted ONLY to the addresses in QBT_TRUSTED_IPS (compose gives `api` and
# `worker` static IPs and passes exactly those two). Everything else in the compose network, e.g. a compromised
# sibling container, must authenticate, and nobody knows the password: with no WebUI password stored, qBittorrent
# (>= 4.6.1) generates a random temporary one at every start and only prints it to the log. Anyone who could call
# setPreferences/autorun would get code execution in this container, so an empty list means "nobody".
TRUSTED=""
for ip in $(printf '%s' "${QBT_TRUSTED_IPS:-}" | tr ',' ' '); do
  case "$ip" in
    ''|*[!0-9a-fA-F:./]*) die "invalid QBT_TRUSTED_IPS entry '$ip'" ;;
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

# A WebUI password stored by an earlier run/admin would be a credential somebody knows: drop it so the random
# temporary password (verified in qBittorrent 5.3.0: WebUI::WebUI(tempPasswordHash), src/app/application.cpp)
# is the only one. A stored Password_PBKDF2 takes precedence over the temporary one (src/webui/webui.cpp).
newtmp
awk '!/^Password_PBKDF2=/' "$CONF" > "$T" && mv -f -- "$T" "$CONF"

# Security-critical keys, re-applied on EVERY start (the WebUI is only reachable inside the compose network and is never
# routed by the gateway). Nothing an admin can tune from the app's engine settings (apps/api/src/api/engine.ts:
# limits, queueing, DHT/PeX/LSD, encryption, anonymous mode, listen port, extra trackers) may be in this block: those are
# seeded on first start only, below, so a change made in the UI survives a restart.
set_key WebUI 'Address' '*'
set_key WebUI 'Port' "${QBT_WEBUI_PORT:-8080}"
set_key WebUI 'AuthSubnetWhitelist' "$TRUSTED"
# Loopback is shared only with the vpn sidecar (same network namespace): siblings arrive with their own address,
# the tunnel side is dropped by the sidecar's firewall. Keeping it open lets the image HEALTHCHECK work.
set_key WebUI 'LocalHostAuth' false
set_key WebUI 'HostHeaderValidation' false
set_key WebUI 'ServerDomains' '*'
set_key WebUI 'CSRFProtection' false
set_key WebUI 'ClickjackingProtection' false
set_key LegalNotice Accepted true
set_key Network 'PortForwardingEnabled' false   # UPnP / NAT-PMP
# No autorun: a program run on torrent events would be code execution for anyone who can reach setPreferences.
set_key AutoRun 'enabled' false
set_key AutoRun 'OnTorrentAdded\Enabled' false
set_key AutoRun 'OnTorrentFinished\Enabled' false
set_key BitTorrent 'Session\Interface' ''
set_key BitTorrent 'Session\InterfaceName' ''
set_key BitTorrent 'Session\InterfaceAddress' ''
# libtorrent's SSRF mitigation (BitTorrent/Session/SSRFMitigation, default on): a tracker / web seed on a global address
# may not redirect the client to a local/private one. Re-asserted so an admin cannot switch it off from the engine UI.
set_key BitTorrent 'Session\SSRFMitigation' true

# Defaults on first start only (an admin may change these later in the WebUI; every key of the engine-settings whitelist
# that this image seeds belongs here, never in the block above).
if ! grep -q 'Session.DefaultSavePath=' "$CONF"; then
  set_key BitTorrent 'Session\DefaultSavePath' /downloads/incomplete
  set_key BitTorrent 'Session\TempPathEnabled' false
  set_key BitTorrent 'Session\Preallocation' false
  set_key BitTorrent 'Session\DHTEnabled' true
  set_key BitTorrent 'Session\PeXEnabled' true
  set_key BitTorrent 'Session\AnonymousModeEnabled' false
  set_key BitTorrent 'Session\LSDEnabled' false
  set_key BitTorrent 'Session\Port' 6881
  set_key Meta 'MigrationVersion' 9999
fi
