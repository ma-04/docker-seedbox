#!/bin/sh
# Plain-sh test (no Docker, no root): a compromised qBittorrent owns /config and can plant symlinks in it. The entrypoint
# used to run as root and write `$CONF.tmp` there, so a link at that name made root overwrite /entrypoint.sh.
# This simulates the plants in a temp dir against conf-edit.sh (what now touches /config, as the unprivileged user) and
# checks that no write ever goes through a link, and that the root part (seed-config.sh) only does `chown -h <dir>`.
# Usage: services/qbittorrent/test/symlink.sh
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
EDIT=$HERE/conf-edit.sh
SEED=$HERE/seed-config.sh
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
PASS=0; FAILN=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAILN=$((FAILN+1)); printf '  FAIL %s\n' "$1"; }
check(){ d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }

SENTINEL="victim: must never be modified"
fresh() { # fresh NAME : new config dir + a victim file, echoes the dir
  d="$WORK/$1"; mkdir -p "$d/config" "$d/victim"
  printf '%s\n' "$SENTINEL" > "$d/victim/entrypoint.sh"
  echo "$d"
}
victim_intact() { [ "$(cat "$1/victim/entrypoint.sh")" = "$SENTINEL" ] && [ "$(ls -A "$1/victim" | wc -l | tr -d ' ')" = 1 ]; }
run_edit() { CONFIG_DIR="$1/config" QBT_TRUSTED_IPS=172.31.250.3,172.31.250.4 QBT_WEBUI_PORT=8080 "$EDIT"; }

echo "== conf-edit.sh: planted links"
D=$(fresh plain); run_edit "$D" 2>/dev/null
check "baseline: config seeded (WebUI whitelist, SSRF mitigation, no autorun)" sh -c "grep -q 'AuthSubnetWhitelist=172.31.250.3/32, 172.31.250.4/32' '$D/config/qBittorrent/config/qBittorrent.conf' && grep -q 'Session.SSRFMitigation=true' '$D/config/qBittorrent/config/qBittorrent.conf' && grep -q 'enabled=false' '$D/config/qBittorrent/config/qBittorrent.conf'"
check "baseline: no temp files left behind" test -z "$(ls -A "$D/config/qBittorrent/config" | grep -v '^qBittorrent.conf$')"

D=$(fresh tmp-link); mkdir -p "$D/config/qBittorrent/config"
ln -s "$D/victim/entrypoint.sh" "$D/config/qBittorrent/config/qBittorrent.conf.tmp"
run_edit "$D" 2>/dev/null
check "symlink at qBittorrent.conf.tmp -> victim: victim untouched" victim_intact "$D"

D=$(fresh conf-link); mkdir -p "$D/config/qBittorrent/config"
ln -s "$D/victim/entrypoint.sh" "$D/config/qBittorrent/config/qBittorrent.conf"
run_edit "$D" 2>/dev/null
check "symlink at qBittorrent.conf -> victim: victim untouched" victim_intact "$D"
check "...and the config is now a regular file with the seeded keys" sh -c "[ ! -L '$D/config/qBittorrent/config/qBittorrent.conf' ] && grep -q 'LocalHostAuth=true' '$D/config/qBittorrent/config/qBittorrent.conf'"

D=$(fresh dir-link); mkdir -p "$D/config/qBittorrent"
ln -s "$D/victim" "$D/config/qBittorrent/config"
run_edit "$D" 2>/dev/null
check "symlink in place of qBittorrent/config -> victim dir: nothing written into the victim" victim_intact "$D"
check "...a real directory took its place" sh -c "[ ! -L '$D/config/qBittorrent/config' ] && [ -f '$D/config/qBittorrent/config/qBittorrent.conf' ]"

D=$(fresh qbt-link)
ln -s "$D/victim" "$D/config/qBittorrent"
run_edit "$D" 2>/dev/null
check "symlink in place of qBittorrent -> victim dir: nothing written into the victim" victim_intact "$D"

D=$(fresh root-link); rmdir "$D/config"; ln -s "$D/victim" "$D/config"
run_edit "$D" 2>/dev/null; rc=$?
check "symlink as the config directory itself: refused (exit != 0), victim untouched" sh -c "[ $rc -ne 0 ]"
check "...victim untouched" victim_intact "$D"

D=$(fresh predictable); mkdir -p "$D/config/qBittorrent/config"
for n in .qbt-edit.000000 .qbt-edit.aaaaaa qBittorrent.conf.new qBittorrent.conf.tmp; do ln -s "$D/victim/entrypoint.sh" "$D/config/qBittorrent/config/$n"; done
run_edit "$D" 2>/dev/null
check "links at predictable temp names are never written through" victim_intact "$D"

D=$(fresh dir-conf); mkdir -p "$D/config/qBittorrent/config/qBittorrent.conf"
run_edit "$D" 2>/dev/null
check "a directory in place of the config file is replaced by a file" test -f "$D/config/qBittorrent/config/qBittorrent.conf"

echo "== seed-config.sh (the root part): only a non-recursive chown -h of the volume dir, then everything unprivileged"
D=$(fresh rootpart); mkdir -p "$D/bin"
LOG="$D/log"; : > "$LOG"
cat > "$D/bin/id" <<SH
#!/bin/sh
case "\$*" in "-u") echo 0 ;; "-u qbtUser") echo 1000 ;; "-g qbtUser") echo 1000 ;; *) echo 0 ;; esac
SH
cat > "$D/bin/chown" <<SH
#!/bin/sh
echo "chown \$*" >> "$LOG"
SH
cat > "$D/bin/doas" <<SH
#!/bin/sh
echo "doas \$*" >> "$LOG"
[ "\$1" = -u ] && shift 2
exec "\$@"
SH
cat > "$D/bin/qbittorrent-nox" <<SH
#!/bin/sh
echo "qbt \$*" >> "$LOG"
SH
chmod +x "$D/bin/"*
ln -s "$D/victim/entrypoint.sh" "$D/config/qBittorrent.conf.tmp" 2>/dev/null
PATH="$D/bin:$PATH" CONFIG_DIR="$D/config" CONF_EDIT="$EDIT" QBT_TRUSTED_IPS=172.31.250.3 QBT_LEGAL_NOTICE=confirm QBT_WEBUI_PORT=8080 PUID=1000 PGID=1000 sh "$SEED" 2>/dev/null
check "the planted .tmp link is never followed by the full entrypoint flow" victim_intact "$D"
check "chown is called exactly once, as 'chown -h 1000:1000 <config dir>' (no -R, no other path)" test "$(grep -c '^chown' "$LOG")" = 1 -a "$(grep '^chown' "$LOG")" = "chown -h 1000:1000 $D/config"
check "the config editor runs through the privilege drop (doas -u qbtUser ... conf-edit.sh)" grep -q "^doas -u qbtUser /usr/bin/env .*$EDIT" "$LOG"
check "qbittorrent-nox is started through the privilege drop with the profile and legal notice" grep -q '^doas -u qbtUser /usr/bin/env HOME=/tmp qbittorrent-nox --confirm-legal-notice --profile=' "$LOG"
check "seed-config.sh itself has no write redirection into /config, no awk/mkdir, no recursive chown" sh -c "! grep -v '^ *#' '$SEED' | grep -qE 'chown -R|awk|mkdir|>>|[^2]> *[\"\\$]'"
check "(control) that grep does flag the old pattern" sh -c "printf '%s\\n' 'awk x > \"\$CONF.tmp\"' | grep -qE 'awk'"
check "PUID=0 is refused" sh -c "PUID=0 sh '$SEED' 2>&1 | grep -q 'refusing to run'"

echo
echo "passed=$PASS failed=$FAILN"
[ "$FAILN" = 0 ]
