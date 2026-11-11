#!/bin/sh
# Entrypoint (under tini). The only things done as root are: validate PUID/PGID, make the /config volume root
# ownable by that user (a NON-recursive `chown -h` of the directory itself), and drop to PUID:PGID. EVERYTHING that
# touches /config beyond that (conf-edit.sh: seeding qBittorrent.conf) and qBittorrent itself run as the unprivileged
# user, so a compromised qBittorrent, which owns /config and can plant symlinks in it, never gets root to follow them.
#
# The official /entrypoint.sh is deliberately NOT used: it runs `chown -R` on /config and rewrites config as root
# (both follow planted symlinks), and edits /etc/passwd. This script starts qbittorrent-nox exactly like it does
# (--confirm-legal-notice, --profile=/config, webui/torrenting port) minus those root-side steps. The container runs
# with `read_only: true`, so this script, /entrypoint.sh and the rest of the rootfs cannot be replaced either.
set -eu

# Never run the torrent client (internet-facing, parses untrusted input) as root.
case "${PUID:-1000}" in ''|*[!0-9]*) echo "seed-config: PUID must be a number" >&2; exit 1 ;; esac
case "${PGID:-1000}" in ''|*[!0-9]*) echo "seed-config: PGID must be a number" >&2; exit 1 ;; esac
PUID=${PUID:-1000}; PGID=${PGID:-1000}
if [ "$PUID" -eq 0 ] || [ "$PGID" -eq 0 ]; then
  echo "seed-config: refusing to run qBittorrent as uid/gid 0 (PUID=$PUID PGID=$PGID); use a non-zero PUID/PGID" >&2
  exit 1
fi

CONFIG_DIR=${CONFIG_DIR:-/config}
EDIT=${CONF_EDIT:-/conf-edit.sh}
RUN_AS_USER=${RUN_AS_USER:-qbtUser}   # the image's passwd entry (uid/gid 1000); tests override it

if [ "$(id -u)" -eq 0 ]; then
  # The image's qbtUser is 1000:1000. Another PUID/PGID needs a passwd edit, which a read-only rootfs forbids.
  if [ "$PUID" != "$(id -u "$RUN_AS_USER")" ] || [ "$PGID" != "$(id -g "$RUN_AS_USER")" ]; then
    sed -i "s|^$RUN_AS_USER:x:[0-9]*:[0-9]*:|$RUN_AS_USER:x:$PUID:$PGID:|" /etc/passwd 2>/dev/null \
      || { echo "seed-config: PUID/PGID other than the image's $RUN_AS_USER ($(id -u "$RUN_AS_USER"):$(id -g "$RUN_AS_USER")) need a writable /etc/passwd; the container's root filesystem is read-only" >&2; exit 1; }
    sed -i "s|^$RUN_AS_USER:x:[0-9]*:|$RUN_AS_USER:x:$PGID:|" /etc/group 2>/dev/null || true
  fi
  # The one privileged write: ownership of the volume's top directory (-h: never through a link, no -R).
  [ -d "$CONFIG_DIR" ] && [ ! -L "$CONFIG_DIR" ] || { echo "seed-config: $CONFIG_DIR must be a real directory" >&2; exit 1; }
  chown -h "$PUID:$PGID" "$CONFIG_DIR" 2>/dev/null || true
  DROP="doas -u $RUN_AS_USER"
else
  DROP=""
  [ "$(id -u)" -eq "$PUID" ] || echo "seed-config: running as uid $(id -u), which is not PUID=$PUID" >&2
fi

# shellcheck disable=SC2086  # $DROP is a fixed two-word command
$DROP /usr/bin/env "CONFIG_DIR=$CONFIG_DIR" "QBT_TRUSTED_IPS=${QBT_TRUSTED_IPS:-}" "QBT_WEBUI_PORT=${QBT_WEBUI_PORT:-8080}" "$EDIT"

legal=""
case "$(printf '%s' "${QBT_LEGAL_NOTICE:-}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')" in confirm) legal="--confirm-legal-notice" ;; esac
[ -z "${UMASK:-}" ] || umask "$UMASK"
# shellcheck disable=SC2086
exec $DROP /usr/bin/env HOME=/tmp qbittorrent-nox ${legal:+"$legal"} "--profile=$CONFIG_DIR" ${QBT_TORRENTING_PORT:+"--torrenting-port=$QBT_TORRENTING_PORT"} ${QBT_WEBUI_PORT:+"--webui-port=$QBT_WEBUI_PORT"} "$@"
