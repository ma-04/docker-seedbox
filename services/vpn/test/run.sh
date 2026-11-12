#!/usr/bin/env bash
# Hermetic test of the vpn sidecar: kill switch, rotation, restart behaviour.
# Needs docker + compose v2.33+ and a kernel with WireGuard. Uses project name "sbvpn";
# all keys are generated at run time into a temp dir that is removed on exit.
# Usage: ./run.sh [--keep]   (--keep leaves the stack up for debugging)
set -u
cd "$(dirname "$0")"
export COMPOSE_PROJECT_NAME=sbvpn
# Every `exec` is bounded: `docker compose exec -T` has been seen to hang after its command finished (CI sat 20 min in
# one `status` call until the job timeout). A hung exec now fails that one check instead of the whole job.
dc() { if [ "${1:-}" = exec ]; then timeout -k 10 120 docker compose -f compose.yaml "$@"; else docker compose -f compose.yaml "$@"; fi; }
DC=dc
KEEP=0; [ "${1:-}" = "--keep" ] && KEEP=1
PASS=0; FAILN=0
TOKEN=test-token-0123456789
WORK=$(mktemp -d)

pass() { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
fail() { FAILN=$((FAILN+1)); printf '  FAIL %s\n' "$1"; }
check() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$d"; else fail "$d"; fi; }
checkno() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then fail "$d"; else pass "$d"; fi; }
section() { printf '\n== %s\n' "$1"; }

ctl()   { $DC exec -T lan-client /t/ctl.sh "$@"; }
probe() { $DC exec -T -u 1000 probe "$@"; }            # as qBittorrent would run (uid 1000)
probe_ip() { probe curl -sS -m 4 "http://$1/"; }
jqs()   { jq -r "$1"; }
sh_()   { bash -c "$1"; }
OUT=""
has()    { printf '%s\n' "$OUT" | grep -q -- "$1"; }
jqok()   { printf '%s\n' "$OUT" | head -1 | jq -e "$1"; }
intruder_code() { $DC exec -T lan-intruder curl -s -m 5 -o /dev/null -w '%{http_code}' "$@"; }
mode_noop() { echo '{"mode":"required"}' | $DC exec -T lan-client /t/ctl.sh POST /mode | head -1 | jq -e '.connected and .mode=="required"'; }
qbt_refuses_root() { docker run --rm -e PUID=0 sbvpn-qbittorrent 2>&1 | grep -q 'refusing to run'; }
status() { ctl GET /status </dev/null | head -1; }
probe_rc() { probe curl -sS -m 4 -o /dev/null "$@" >/dev/null 2>&1; echo $?; }   # curl exit code: 0 ok, 28 = timed out (dropped)
# LAN policy: nothing running in the namespace, as uid 1000 (qBittorrent, or any URL it is made to fetch) OR as root
# (there is no uid exemption: root in the qbittorrent container shares this namespace), may open a connection to the LAN
# (bridge gateway = the host, sibling containers). Every "blocked" check expects a TIMEOUT (exit 28), not "refused" (7):
# refused would mean the packet got through and nothing listened. Positive control: the one VPN_LAN_ALLOW_OUT entry
# (client:9000) is reachable while client:9001 is not.
probe_rc0() { $DC exec -T -u 0 probe curl -sS -m 4 -o /dev/null "$@" >/dev/null 2>&1; echo $?; }   # same, as root
lan_policy() { # mode-label
  check "$1: uid 1000 -> sibling container :9999 times out (dropped)" test "$(probe_rc http://172.31.250.51:9999/)" = 28
  check "$1: uid 1000 -> bridge gateway (the host) :22 times out (dropped)" test "$(probe_rc http://172.31.250.1:22/)" = 28
  check "$1: uid 1000 -> allow-listed IP on another port (client:9001) times out" test "$(probe_rc http://172.31.250.50:9001/)" = 28
  # positive probes retry (first packets after a container start can be slow on a loaded host); "blocked" ones never do
  check "$1: uid 1000 -> allow-listed ip:port (VPN_LAN_ALLOW_OUT client:9000) works" retry 5 sh_ '[ "$(probe_rc http://172.31.250.50:9000/)" = 0 ]'
  check "$1: root in the namespace -> sibling container :9999 times out (no uid exemption)" test "$(probe_rc0 http://172.31.250.51:9999/)" = 28
  check "$1: root in the namespace -> bridge gateway (the host) :22 times out" test "$(probe_rc0 http://172.31.250.1:22/)" = 28
  check "$1: root in the namespace -> sibling container, arbitrary other port :4242 times out" test "$(probe_rc0 http://172.31.250.51:4242/)" = 28
  check "$1: root in the namespace -> the WebUI port of a sibling-less address (172.31.250.60:8080) times out" test "$(probe_rc0 http://172.31.250.60:8080/)" = 28
  check "$1: private-range probe: echo-priv (10.77.0.20, routed, alive) is unreachable for uid 1000" test "$(probe_rc http://10.77.0.20/)" = 28
  check "$1: private-range probe: echo-priv is unreachable for root too" test "$(probe_rc0 http://10.77.0.20/)" = 28
  check "$1: positive control: echo-priv does answer on its own network" retry 5 $DC exec -T priv-client curl -fsS -m 4 http://10.77.0.20/
  for ip in 172.17.0.1 169.254.169.254 192.168.1.1 10.0.0.1 100.64.0.1 172.16.5.5; do
    check "$1: uid 1000 -> $ip times out (private / link-local / CGNAT / other bridge)" test "$(probe_rc http://$ip/)" = 28
  done
  checkno "$1: IPv6 is unreachable (uid 1000)" probe curl -g -6 -sS -m 3 "http://[2606:4700:4700::1111]/"
  check "$1: positive control: the in-namespace listener answers on loopback" retry 5 probe curl -fsS -m 4 http://127.0.0.1:9100/
  check "$1: sibling -> in-namespace listener :9100 times out (LAN input only reaches the WebUI/control ports)" test "$($DC exec -T lan-intruder curl -s -m 4 -o /dev/null -w '%{http_code}' http://vpn:9100/)" = 000
  check "$1: sibling -> WebUI :8080 still answers (403: not whitelisted)" test "$(intruder_code http://vpn:8080/api/v2/app/version)" = 403
}
# Search companions (Jackett, FlareSolverr) run in the same namespace; their own egress is what the kill switch must stop.
jk_rc() { $DC exec -T jackett curl -sS -m 4 -o /dev/null "$@" >/dev/null 2>&1; echo $?; }        # as Jackett (uid 1000)
fs_rc() { $DC exec -T flaresolverr curl -sS -m 4 -o /dev/null "$@" >/dev/null 2>&1; echo $?; }   # as FlareSolverr
fs_fetch() { # FlareSolverr's own headless browser fetching $1: prints "ok" only when it got the page
  $DC exec -T probe curl -sS -m 40 -H 'Content-Type: application/json' -d "{\"cmd\":\"request.get\",\"url\":\"$1\",\"maxTimeout\":20000}" http://127.0.0.1:8191/v1 2>/dev/null \
    | jq -r 'if .status == "ok" and .solution.status == 200 then "ok" else "failed" end' 2>/dev/null || echo failed
}
lan_code() { $DC exec -T "$1" curl -s -m 4 -o /dev/null -w '%{http_code}' "$2"; }
connect() { # name file : POST /connect with the generated config
  $DC cp "$WORK/$2.conf" lan-client:/tmp/cfg.conf >/dev/null 2>&1
  $DC exec -T lan-client sh -c "jq -Rs --arg name '$1' '{name:\$name, config:.}' /tmp/cfg.conf | /t/ctl.sh POST /connect"
}
cleanup() {
  if [ "$KEEP" = 0 ]; then
    $DC down -v --remove-orphans >/dev/null 2>&1
    docker rmi sbvpn-vpn sbvpn-qbittorrent sbvpn-tools >/dev/null 2>&1   # the pulled jackett/flaresolverr images stay cached
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
# Positive probes right after /connect or a restart: the tunnel needs a moment on a loaded host. Retries only for
# "does work" checks (never for the "must not work" ones) and reports when more than one attempt was needed.
retry() { local n=$1 i; shift; for i in $(seq 1 "$n"); do if "$@"; then [ "$i" -gt 1 ] && echo "needed $i attempts: ${*:1:4}" >> "$WORK/retries"; return 0; fi; sleep 1; done; return 1; }
export -f dc retry ctl probe probe_rc probe_rc0 probe_ip jqs status connect sh_ has jqok intruder_code mode_noop qbt_refuses_root jk_rc fs_rc fs_fetch lan_code
export DC WORK

section "build + keys"
$DC build tools-build vpn qbittorrent >/dev/null || { echo "build failed"; exit 2; }
$DC pull -q jackett flaresolverr >/dev/null || { echo "pull of the search companions failed"; exit 2; }
gen() { docker run --rm sbvpn-tools sh -c 'k=$(wg genkey); echo $k; echo $k | wg pubkey' | paste -sd' ' -; }
read -r C_PRIV C_PUB < <(gen)
read -r S1_PRIV S1_PUB < <(gen)
read -r S2_PRIV S2_PUB < <(gen)
export CLIENT_PUB=$C_PUB WG1_PRIV=$S1_PRIV WG2_PRIV=$S2_PRIV
# Config A: hostname endpoint + IPv6 default route; config B: IP endpoint. DNS = the server's tunnel address.
mkconf() { # name tunnel-net server-pub endpoint [extra Interface line, e.g. "MTU = 1380"]
cat > "$WORK/$1.conf" <<CONF
[Interface]
PrivateKey = $C_PRIV
Address = $2.2/32, fd99::2/128
DNS = $2.1
${5:-}
[Peer]
PublicKey = $3
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = $4
CONF
}
mkconf A 10.99.1 "$S1_PUB" wg1:51820
mkconf B 10.99.2 "$S2_PUB" 198.51.100.12:51820 "MTU = 1380"
{ cat "$WORK/A.conf"; echo "PostUp = touch /tmp/pwned"; } > "$WORK/evil.conf"

$DC up -d echo-direct echo-behind echo-priv priv-client wg1 wg2 lan-client lan-intruder >/dev/null
VPN_DEFAULT_MODE=off $DC up -d --wait vpn qbittorrent probe jackett flaresolverr >/dev/null || { $DC ps; $DC logs vpn qbittorrent jackett flaresolverr | tail -40; exit 2; }
sleep 1

# ---------------------------------------------------------------- 1
section "1. off mode"
check "status mode=off, not connected" test "$(status | jqs '.mode+" "+(.connected|tostring)')" = "off false"
check "namespace reaches the direct echo service" retry 10 sh_ "probe_ip 198.51.100.20 | grep -q '^direct 198.51.100.2\$'"
check "WebUI :8080 reachable from LAN client" $DC exec -T lan-client curl -fsS -m 5 http://vpn:8080/api/v2/app/version
check "resolv.conf = Docker resolver" $DC exec -T probe grep -q 127.0.0.11 /etc/resolv.conf
check "qBittorrent healthy" $DC exec -T lan-client curl -fsS -m 5 http://vpn:8080/api/v2/app/version
OUT=$($DC exec -T lan-client curl -fsS -m 5 http://vpn:8080/api/v2/app/preferences)
check "qBittorrent seeded: port 8080, whitelist = only QBT_TRUSTED_IPS (/32), no host-header/CSRF checks" jqok '.web_ui_port==8080 and .bypass_auth_subnet_whitelist_enabled and .bypass_auth_subnet_whitelist=="172.31.250.50/32" and (.web_ui_host_header_validation_enabled|not) and (.web_ui_csrf_protection_enabled|not)'
check "qBittorrent seeded: no UPnP, DHT/PeX on, save path, no prealloc, anonymous off" jqok '(.upnp|not) and .dht and .pex and .save_path=="/downloads/incomplete" and (.preallocate_all|not) and (.anonymous_mode|not) and .current_network_interface==""'
OUT=""
check "untrusted sibling container: WebUI API is 403 (needs a password nobody knows)" test "$(intruder_code http://vpn:8080/api/v2/app/version)" = 403
check "untrusted sibling container: setPreferences (autorun = RCE) is 403" test "$(intruder_code -X POST --data-urlencode 'json={"autorun_enabled":true}' http://vpn:8080/api/v2/app/setPreferences)" = 403
checkno "untrusted sibling container: default password adminadmin does not log in" bash -c "$DC exec -T lan-intruder curl -s -m 5 -d 'username=admin&password=adminadmin' http://vpn:8080/api/v2/auth/login | grep -q 'Ok.'"
check "qBittorrent entrypoint refuses PUID=0" qbt_refuses_root
check "start a listener as uid 1000 inside the namespace (for the inbound checks)" $DC exec -T -d -u 1000 -e LISTEN_NAME=ns probe socat TCP4-LISTEN:9100,fork,reuseaddr EXEC:"/t/listen.sh reply 9100"
sleep 1
section "1a. LAN policy in off mode (internet-direct stays open, LAN is restricted)"
lan_policy off
check "off: uid 1000 still reaches the 'internet' directly" retry 5 sh_ '[ "$(probe_rc http://198.51.100.20/)" = 0 ]'
check "qBittorrent runs as uid 1000" bash -c "$DC exec -T qbittorrent sh -c 'ps -o user,args | grep \"[q]bittorrent-nox\"' | grep -q qbtUser"
check "off: the public (TEST-NET) 'internet' is reachable from uid 1000 while every private range is not" retry 5 sh_ '[ "$(probe_rc http://198.51.100.20/)" = 0 ] && [ "$(probe_rc http://10.77.0.20/)" = 28 ]'

section "1a2. qbittorrent container hardening (read-only rootfs, reduced capabilities, no root write access to /config)"
QC=$($DC ps -q qbittorrent)
check "qbittorrent: root filesystem is read-only" test "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$QC")" = true
check "qbittorrent: capabilities added = CHOWN SETUID SETGID KILL only (no DAC_OVERRIDE, no FOWNER)" test "$(docker inspect -f '{{range .HostConfig.CapAdd}}{{.}} {{end}}' "$QC" | sed 's/CAP_//g' | tr ' ' '\n' | sort | xargs)" = "CHOWN KILL SETGID SETUID"
check "qbittorrent: capabilities dropped = ALL" test "$(docker inspect -f '{{range .HostConfig.CapDrop}}{{.}} {{end}}' "$QC" | sed 's/CAP_//g' | tr -d ' ')" = ALL
checkno "qbittorrent: /entrypoint.sh is not writable (even as root)" $DC exec -T -u 0 qbittorrent sh -c 'echo pwned >> /entrypoint.sh'
checkno "qbittorrent: /seed-config.sh is not writable (even as root)" $DC exec -T -u 0 qbittorrent sh -c 'echo pwned >> /seed-config.sh'
checkno "qbittorrent: /conf-edit.sh is not writable (even as root)" $DC exec -T -u 0 qbittorrent sh -c 'echo pwned >> /conf-edit.sh'
checkno "qbittorrent: nothing new can be created in / (even as root)" $DC exec -T -u 0 qbittorrent sh -c 'touch /pwned'
checkno "qbittorrent: uid 1000 cannot replace /entrypoint.sh" $DC exec -T -u 1000 qbittorrent sh -c 'echo pwned > /entrypoint.sh'
check "qbittorrent: /tmp (tmpfs) is writable for uid 1000" $DC exec -T -u 1000 qbittorrent sh -c 'touch /tmp/x && rm /tmp/x'
checkno "qbittorrent: root WITHOUT DAC_OVERRIDE cannot write into uid 1000's config" $DC exec -T -u 0 qbittorrent sh -c 'echo x >> /config/qBittorrent/config/qBittorrent.conf'
check "qbittorrent: the config is NOT readable by root without DAC_OVERRIDE (so root cannot be tricked into reading/writing through it)" bash -c "! $DC exec -T -u 0 qbittorrent cat /config/qBittorrent/config/qBittorrent.conf"
check "qbittorrent: the engine reports ssrf_mitigation=true" bash -c "$DC exec -T lan-client curl -fsS -m 5 http://vpn:8080/api/v2/app/preferences | jq -e .ssrf_mitigation"
check "qbittorrent: nothing in /config is owned by root (all written by uid 1000)" test -z "$($DC exec -T -u 1000 qbittorrent find /config ! -user qbtUser 2>&1)"
check "qbittorrent: SSRF mitigation re-asserted in the config" $DC exec -T -u 1000 qbittorrent grep -q 'Session.SSRFMitigation=true' /config/qBittorrent/config/qBittorrent.conf
EP_SUM() { $DC exec -T -u 0 qbittorrent sh -c 'sha256sum /entrypoint.sh /seed-config.sh /conf-edit.sh | cut -d" " -f1 | tr "\n" " "'; }
SUM_BEFORE=$(EP_SUM)
# The attack: as the qBittorrent user, plant symlinks in /config that an old, root-run entrypoint would write through.
$DC exec -T -u 1000 qbittorrent sh -c 'cd /config/qBittorrent/config && rm -f qBittorrent.conf.tmp && ln -s /entrypoint.sh qBittorrent.conf.tmp && ln -s /seed-config.sh qBittorrent.conf.new && ln -s /conf-edit.sh .qbt-edit.AAAAAA'
$DC restart -t 20 qbittorrent >/dev/null 2>&1
for i in $(seq 1 40); do $DC exec -T lan-client curl -fsS -m 3 http://vpn:8080/api/v2/app/version >/dev/null 2>&1 && break; sleep 1; done
check "symlink attack: qbittorrent restarted and the WebUI is healthy again" $DC exec -T lan-client curl -fsS -m 5 http://vpn:8080/api/v2/app/version
check "symlink attack: /entrypoint.sh, /seed-config.sh, /conf-edit.sh are byte-identical after the restart" test "$(EP_SUM)" = "$SUM_BEFORE"
check "symlink attack: the plant did not turn the entrypoint into a shell script of the attacker's" sh_ "! $DC exec -T qbittorrent grep -q 'pwned' /entrypoint.sh"
check "qbittorrent: no root-owned files appeared in /config" test -z "$($DC exec -T -u 1000 qbittorrent find /config ! -user qbtUser 2>&1)"

section "1a3. search companions (Jackett, FlareSolverr): reachability and hardening"
check "Jackett answers the trusted LAN client (the api) on :9117" retry 30 sh_ '[ "$(lan_code lan-client http://vpn:9117/jackett/UI/Login)" = 200 ]'
check "untrusted sibling -> Jackett :9117 times out (SEARCH_TRUSTED_IPS)" test "$(lan_code lan-intruder http://vpn:9117/jackett/UI/Login)" = 000
check "FlareSolverr answers on loopback inside the namespace" retry 30 probe curl -fsS -m 5 http://127.0.0.1:8191/health
check "trusted LAN client -> FlareSolverr :8191 times out (loopback only)" test "$(lan_code lan-client http://vpn:8191/health)" = 000
check "untrusted sibling -> FlareSolverr :8191 times out" test "$(lan_code lan-intruder http://vpn:8191/health)" = 000
check "control API /companions reports FlareSolverr reachable (fixed loopback probe)" sh_ "ctl GET /companions </dev/null | head -1 | jq -e '.flaresolverr == true'"
check "Jackett: the entrypoint applied the API key, base path and FlareSolverr URL" sh_ "$DC exec -T jackett jq -e '.APIKey == \"sbvpntestjackettkey0123456789ab\" and .BasePathOverride == \"/jackett\" and .UpdateDisabled and .FlareSolverrUrl == \"http://127.0.0.1:8191\"' /config/Jackett/ServerConfig.json"
check "Jackett: the API key is not in its environment or argv" sh_ "! $DC exec -T jackett sh -c 'cat /proc/[0-9]*/environ /proc/[0-9]*/cmdline 2>/dev/null' | tr '\\0' '\\n' | grep -q sbvpntestjackettkey"
JC=$($DC ps -q jackett); FC=$($DC ps -q flaresolverr)
check "Jackett runs as uid 1000 with a read-only root filesystem and no capabilities" sh_ "[ \"\$($DC exec -T jackett id -u)\" = 1000 ] && [ \"\$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{range .HostConfig.CapDrop}}{{.}}{{end}} {{len .HostConfig.CapAdd}}' $JC | sed 's/CAP_//')\" = 'true ALL 0' ]"
check "FlareSolverr runs as uid 1000, no capabilities, memory and pid limits" sh_ "[ \"\$($DC exec -T flaresolverr id -u)\" = 1000 ] && [ \"\$(docker inspect -f '{{range .HostConfig.CapDrop}}{{.}}{{end}} {{len .HostConfig.CapAdd}} {{.HostConfig.Memory}} {{.HostConfig.PidsLimit}}' $FC | sed 's/CAP_//')\" = 'ALL 0 1073741824 512' ]"
check "off: Jackett reaches the 'internet' directly (positive control)" retry 5 sh_ '[ "$(jk_rc http://198.51.100.20/)" = 0 ]'
check "off: FlareSolverr reaches the 'internet' directly (positive control)" retry 5 sh_ '[ "$(fs_rc http://198.51.100.20/)" = 0 ]'
check "off: Jackett -> private range (echo-priv) times out" test "$(jk_rc http://10.77.0.20/)" = 28
check "off: FlareSolverr -> private range (echo-priv) times out" test "$(fs_rc http://10.77.0.20/)" = 28
check "off: Jackett -> sibling container on the LAN times out" test "$(jk_rc http://172.31.250.51:9999/)" = 28

section "1b. /connect is refused (409) in off mode"
OUT=$(connect A A); echo "$OUT" | head -1
check "POST /connect while mode=off -> 409" has '^HTTP 409$'
checkno "no wg interface was created" $DC exec -T vpn ip link show wg0
check "still off and not connected" test "$(status | jqs '.mode+" "+(.connected|tostring)')" = "off false"

section "1c. qBittorrent: admin changes to whitelisted engine settings survive a restart; security keys are re-asserted"
qbt_api() { $DC exec -T lan-client curl -fsS -m 8 "$@"; }
qbt_prefs() { qbt_api http://vpn:8080/api/v2/app/preferences; }
check "set engine settings through the WebUI API (anonymous mode, max_connec, dl_limit, queueing)" qbt_api --data-urlencode 'json={"anonymous_mode":true,"max_connec":123,"dl_limit":2097152,"queueing_enabled":false,"autorun_enabled":true,"autorun_on_torrent_added_enabled":true}' http://vpn:8080/api/v2/app/setPreferences
$DC restart -t 20 qbittorrent >/dev/null 2>&1
for i in $(seq 1 40); do qbt_prefs >/dev/null 2>&1 && break; sleep 1; done
OUT=$(qbt_prefs)
check "after restart: anonymous_mode, max_connec, dl_limit and queueing kept (whitelisted keys are first-start-only)" jqok '.anonymous_mode and .max_connec==123 and .dl_limit==2097152 and (.queueing_enabled|not)'
check "after restart: autorun forced off again (security key)" jqok '(.autorun_enabled|not) and ((.autorun_on_torrent_added_enabled // false)|not)'
check "after restart: WebUI whitelist, no UPnP and no interface binding re-asserted" jqok '.bypass_auth_subnet_whitelist_enabled and .bypass_auth_subnet_whitelist=="172.31.250.50/32" and (.upnp|not) and .current_network_interface==""'
echo "$OUT" | jq -c 'with_entries(select(.key|test("autorun")))' | sed 's/^/  (autorun keys: /;s/$/)/'
# restore the defaults for the rest of the run
qbt_api --data-urlencode 'json={"anonymous_mode":false}' http://vpn:8080/api/v2/app/setPreferences >/dev/null 2>&1
OUT=""

section "1d. qBittorrent sees only incomplete/ of the downloads volume (never library/)"
docker run --rm -v sbvpn_downloads:/d sbvpn-tools sh -c 'echo secret > /d/library/marker; chmod 644 /d/library/marker'
check "qbittorrent: /downloads contains only incomplete" test "$($DC exec -T qbittorrent ls -A /downloads)" = incomplete
checkno "qbittorrent: the library marker is invisible" $DC exec -T qbittorrent test -e /downloads/library/marker
check "qbittorrent (uid 1000) can write into incomplete/" $DC exec -T -u 1000 qbittorrent sh -c 'echo x > /downloads/incomplete/probe && rm /downloads/incomplete/probe'
check "the library marker lives in the same volume, outside qbittorrent's subtree" sh_ "docker run --rm -v sbvpn_downloads:/d sbvpn-tools sh -c 'ls -A /d/incomplete >/dev/null && test -f /d/library/marker'"

# ---------------------------------------------------------------- 2
section "2. required mode, no tunnel"
check "POST /mode required" test "$(echo '{"mode":"required"}' | ctl POST /mode | head -1 | jqs .mode)" = required
# leak watcher: runs in the namespace (uid 1000) for the rest of the test, hammering the direct echo service
probe sh -c 'rm -f /tmp/leaks /tmp/stop'
$DC exec -T -d -u 1000 probe sh -c 'while [ ! -e /tmp/stop ]; do curl -s -m 1 http://198.51.100.20/ >> /tmp/leaks; sleep 0.1; done'
checkno "direct echo unreachable (curl as uid 1000)" probe curl -sS -m 4 http://198.51.100.20/
checkno "direct echo unreachable even bound to the LAN-side-less NIC" probe sh -c 'curl -sS -m 3 --interface $(ip -4 route show default | sed -n "s/.* dev \([^ ]*\).*/\1/p" | head -1) http://198.51.100.20/'
checkno "DNS lookup of an outside name fails (system resolver)" probe nslookup example.com
checkno "DNS straight at Docker resolver 127.0.0.11 fails" probe nslookup example.com 127.0.0.11
checkno "DNS straight at 8.8.8.8 fails" probe nslookup -timeout=2 -retry=1 example.com 8.8.8.8
checkno "IPv6 egress fails" probe curl -g -6 -sS -m 3 'http://[2606:4700:4700::1111]/'
check "resolv.conf has no nameserver (fail closed)" bash -c "! $DC exec -T probe grep -q '^nameserver' /etc/resolv.conf"
check "WebUI still reachable from LAN client" $DC exec -T lan-client curl -fsS -m 5 http://vpn:8080/api/v2/app/version
check "status: required, not connected" test "$(status | jqs '.mode+" "+(.connected|tostring)')" = "required false"
section "2a. LAN policy in required mode"
lan_policy required
checkno "required: uid 1000 cannot reach the internet-direct echo either" test "$(probe_rc http://198.51.100.20/)" = 0
checkno "required: root cannot reach the internet-direct echo either (no tunnel)" test "$(probe_rc0 http://198.51.100.20/)" = 0
section "2b. search companions in required mode, tunnel down: no egress at all"
check "required, no tunnel: Jackett -> internet-direct echo times out" test "$(jk_rc http://198.51.100.20/)" = 28
check "required, no tunnel: FlareSolverr -> internet-direct echo times out" test "$(fs_rc http://198.51.100.20/)" = 28
check "required, no tunnel: FlareSolverr's headless browser cannot fetch the internet-direct echo" test "$(fs_fetch http://198.51.100.20/)" = failed
checkno "required, no tunnel: Jackett cannot resolve names (no nameserver)" $DC exec -T jackett sh -c 'getent hosts example.com'
check "required, no tunnel: Jackett still answers the api (LAN input is independent of the tunnel)" test "$(lan_code lan-client http://vpn:9117/jackett/UI/Login)" = 200

# ---------------------------------------------------------------- 3
section "3. connect A (hostname endpoint, ::/0 in AllowedIPs)"
OUT=$(connect A A); echo "$OUT" | head -1
check "HTTP 200" has '^HTTP 200$'
check "connected=true, name=A" jqok '.connected and .name=="A"'
check "config A has a HOSTNAME endpoint: it was resolved through Docker's resolver on lo although root has no LAN access" sh_ "grep -q '^Endpoint = wg1:' '$WORK/A.conf'"
check "recent handshake (<=10s)" jqok '.lastHandshakeSec<=10'
wgmtu() { $DC exec -T vpn cat /sys/class/net/wg0/mtu; }
check "no MTU in config and no VPN_MTU: wg0 MTU = 1280 (default)" test "$(wgmtu)" = 1280
check "status.mtu = 1280" test "$(status | jqs .mtu)" = 1280
check "MSS clamp rule installed on wg*" sh_ "$DC exec -T -u 0 vpn nft list chain inet sbvpn mss | grep -q 'maxseg size set rt mtu'"
check "echo behind WG1 reachable, source = wg1" retry 10 sh_ "probe curl -sS -m 5 http://203.0.113.20/ | grep -q '^behind 203.0.113.11$'"
checkno "direct echo still blocked" probe curl -sS -m 3 http://198.51.100.20/
check "through the tunnel: the server's tunnel address answers DNS only: another port (10.99.1.1:80) times out for uid 1000" test "$(probe_rc http://10.99.1.1/)" = 28
check "through the tunnel: a private destination behind the provider (10.99.1.77:80) times out for uid 1000" test "$(probe_rc http://10.99.1.77/)" = 28
check "through the tunnel: root cannot reach private destinations either (10.99.1.1:80)" test "$(probe_rc0 http://10.99.1.1/)" = 28
check "IPv6 stripped from tunnel (no :: in allowed-ips)" bash -c "! $DC exec -T vpn wg show wg0 allowed-ips | grep -q ::"
check "resolv.conf points at the tunnel DNS (shared with qbittorrent)" $DC exec -T qbittorrent grep -q '^nameserver 10.99.1.1' /etc/resolv.conf
# DNS really goes through the tunnel: capture the query on the server side
$DC exec -T -d wg1 sh -c 'timeout 8 socat -u UDP4-RECV:53 - > /tmp/dnsq'
sleep 1; probe nslookup -timeout=2 -retry=1 example.com >/dev/null 2>&1
sleep 1; check "DNS query arrived at the WG server via the tunnel" $DC exec -T wg1 sh -c 'test -s /tmp/dnsq'
for i in $(seq 1 10); do [ "$(status | jqs '.publicIp')" = 203.0.113.11 ] && break; sleep 1; done
check "status.publicIp = 203.0.113.11 (PUBLIC_IP_URL via tunnel)" test "$(status | jqs .publicIp)" = 203.0.113.11
check "WebUI still reachable from LAN client with tunnel up" $DC exec -T lan-client curl -fsS -m 5 http://vpn:8080/api/v2/app/version
checkno "WebUI/control not reachable via the tunnel address (input drop)" $DC exec -T wg1 curl -sS -m 3 http://10.99.1.2:8000/status
check "tunnel up: Jackett's traffic leaves through WG1 (echo-behind sees 203.0.113.11)" retry 10 sh_ "$DC exec -T jackett curl -sS -m 5 http://203.0.113.20/ | grep -q '^behind 203.0.113.11$'"
check "tunnel up: FlareSolverr's headless browser fetches through the tunnel" retry 3 sh_ '[ "$(fs_fetch http://203.0.113.20/)" = ok ]'
check "tunnel up: Jackett still cannot reach the internet-direct echo" test "$(jk_rc http://198.51.100.20/)" = 28
checkno "Jackett/FlareSolverr ports not reachable via the tunnel address" $DC exec -T wg1 sh -c 'curl -sS -m 3 http://10.99.1.2:9117/ || curl -sS -m 3 http://10.99.1.2:8191/health'
checkno "no leak so far" probe test -s /tmp/leaks

# ---------------------------------------------------------------- 4
section "4. rotation A -> B"
OUT=$(connect B B); echo "$OUT" | head -1
check "connected=true, name=B" jqok '.connected and .name=="B"'
check "config MTU = 1380: wg interface MTU = 1380 (status.mtu too)" sh_ "test \"\$($DC exec -T vpn sh -c 'cat /sys/class/net/wg*/mtu')\" = 1380 && test \"\$(status | jqs .mtu)\" = 1380"
check "traffic now exits via wg2 (source 203.0.113.12)" retry 10 sh_ "probe curl -sS -m 5 http://203.0.113.20/ | grep -q '^behind 203.0.113.12$'"
check "exactly one wg interface remains" test "$($DC exec -T vpn sh -c 'ip -o link | grep -c "wg[0-9]"')" = 1
checkno "direct echo blocked after switch" probe curl -sS -m 3 http://198.51.100.20/
checkno "zero direct successes during the switch (leak loop)" probe test -s /tmp/leaks
OUT=$(connect A A); echo "$OUT" | head -1
check "and back: B -> A" retry 10 sh_ "probe curl -sS -m 5 http://203.0.113.20/ | grep -q '^behind 203.0.113.11$'"
checkno "zero direct successes during second switch" probe test -s /tmp/leaks
# The endpoint exception must only cover WireGuard's own (fwmarked, kernel-originated) packets.
check "endpoint rule is restricted to the wg fwmark" sh_ "$DC exec -T -u 0 vpn nft list chain inet sbvpn output | grep 'udp dport 51820' | grep -q 'meta mark 0x00005b76'"
# Packet capture on the WireGuard server fixture (wg1 = the active endpoint 198.51.100.11:51820): what arrives there?
# Positive control first (the capture sees a cleartext datagram from a container outside the namespace), then the same
# cleartext from uid 1000 and from root inside the qbittorrent namespace must never show up.
$DC exec -T wg1 sh -c 'rm -f /tmp/cap /tmp/cap.pid; (tcpdump -l -n -A -i any "udp dst port 51820" >/tmp/cap 2>/dev/null & echo $! >/tmp/cap.pid)'
sleep 1
LEAK1="LEAKMARK-CONTROL-$RANDOM$RANDOM"; LEAK2="LEAKMARK-UID1000-$RANDOM$RANDOM"; LEAK3="LEAKMARK-ROOT-$RANDOM$RANDOM"
$DC exec -T echo-direct sh -c "echo $LEAK1 | socat -T1 - UDP:198.51.100.11:51820" >/dev/null 2>&1
for i in 1 2 3; do
  echo "$LEAK2" | $DC exec -T -u 1000 probe socat -T1 - UDP:198.51.100.11:51820 >/dev/null 2>&1
  echo "$LEAK2" | $DC exec -T -u 1000 probe sh -c 'cat >/dev/udp/198.51.100.11/51820' >/dev/null 2>&1
  echo "$LEAK3" | $DC exec -T -u 0 probe socat -T1 - UDP:198.51.100.11:51820 >/dev/null 2>&1
  echo "$LEAK2" | $DC exec -T -u 1000 probe socat -T1 - UDP:198.51.100.11:51820,sourceport=51820 >/dev/null 2>&1
done
sleep 2
$DC exec -T wg1 sh -c 'kill $(cat /tmp/cap.pid) 2>/dev/null; sleep 0.5'
check "capture works: a cleartext datagram from outside the namespace is seen on the WG server" $DC exec -T wg1 grep -q "$LEAK1" /tmp/cap
check "capture shows real WireGuard traffic from the sidecar (198.51.100.2 -> :51820)" $DC exec -T wg1 grep -q '198.51.100.2.*51820' /tmp/cap
checkno "uid 1000 in the namespace: no cleartext UDP reached the endpoint IP:port (packet capture on the WG server)" $DC exec -T wg1 grep -q "$LEAK2" /tmp/cap
checkno "root in the namespace: no cleartext UDP reached the endpoint IP:port (packet capture on the WG server)" $DC exec -T wg1 grep -q "$LEAK3" /tmp/cap
check "tunnel still works after that attempt" retry 10 sh_ "probe curl -sS -m 5 http://203.0.113.20/ | grep -q '^behind 203.0.113.11$'"
OUT=$(echo "{\"name\":\"bad\",\"config\":$(sed 's|^PublicKey.*|PublicKey = '"$C_PUB"'|' "$WORK/B.conf" | jq -Rs .)}" | ctl POST /connect)
check "bad-key config (no handshake) -> 502" has '^HTTP 502$'
check "old tunnel (A) kept after the failed switch" sh_ "status | jq -e '.connected and .name==\"A\"'"
checkno "zero direct successes after failed switch" probe test -s /tmp/leaks

# ---------------------------------------------------------------- 5
section "5. disconnect / server death"
OUT=$(ctl POST /disconnect </dev/null); echo "$OUT" | head -1
check "disconnected, mode still required" jqok '(.connected|not) and .mode=="required"'
checkno "tunnel target blocked after /disconnect" probe curl -sS -m 3 http://203.0.113.20/
checkno "direct echo blocked after /disconnect" probe curl -sS -m 3 http://198.51.100.20/
check "WebUI reachable after /disconnect" $DC exec -T lan-client curl -fsS -m 5 http://vpn:8080/api/v2/app/version
connect A A >/dev/null
check "reconnected to A" retry 10 probe curl -sS -m 5 http://203.0.113.20/
docker stop -t 1 sbvpn-wg1-1 >/dev/null
sleep 2
checkno "WG server dead: tunnel target unreachable" probe curl -sS -m 3 http://203.0.113.20/
checkno "WG server dead: direct echo still blocked (no fallback)" probe curl -sS -m 3 http://198.51.100.20/
checkno "WG server dead: direct to the endpoint's own network blocked" probe curl -sS -m 3 http://198.51.100.11/
docker start sbvpn-wg1-1 >/dev/null
checkno "zero direct successes through all of the above" probe test -s /tmp/leaks

# ---------------------------------------------------------------- 6
section "6. auth, hostile config, logs"
check "control API :8000 unreachable from an untrusted sibling (CONTROL_TRUSTED_IPS)" test "$(intruder_code http://vpn:8000/status)" = 000
check "no token -> 401" bash -c "$DC exec -T lan-client curl -s -m 5 -o /dev/null -w '%{http_code}' http://vpn:8000/status | grep -q 401"
check "wrong token -> 401" bash -c "$DC exec -T lan-client /t/ctl.sh GET /status wrong | grep -q 'HTTP 401'"
check "wrong token on POST /mode -> 401 and mode unchanged" bash -c "echo '{\"mode\":\"off\"}' | $DC exec -T lan-client /t/ctl.sh POST /mode wrong | grep -q 'HTTP 401' && [ \"\$(status | jq -r .mode)\" = required ]"
OUT=$(connect evil evil); echo "$OUT" | head -1
check "config with PostUp -> 400" has '^HTTP 400$'
checkno "PostUp command was not executed (/tmp/pwned absent)" $DC exec -T vpn test -e /tmp/pwned
for h in PreUp PreDown PostDown SaveConfig; do
  { cat "$WORK/A.conf"; echo "$h = touch /tmp/pwned"; } > "$WORK/evil.conf"
  check "config with $h -> 400" sh_ "connect evil evil | grep -q '^HTTP 400'"
done
for fld in PrivateKey PublicKey; do
  sed "s|^$fld = \(.\{20\}\)|$fld = \1\r|" "$WORK/A.conf" > "$WORK/cr.conf"
  grep -q "$(printf '\r')" "$WORK/cr.conf" || echo "  (test bug: no CR written)"
  check "$fld with an embedded CR -> 400" sh_ "connect cr cr | grep -q '^HTTP 400'"
done
check "tunnel A untouched by rejected configs" test "$(status | jqs .name)" = null -o "$(status | jqs .name)" = A
check "invalid JSON -> 400" bash -c "echo 'nope' | $DC exec -T lan-client /t/ctl.sh POST /connect | grep -q 'HTTP 400'"
check "invalid mode -> 400" bash -c "echo '{\"mode\":\"weird\"}' | $DC exec -T lan-client /t/ctl.sh POST /mode | grep -q 'HTTP 400'"
LOGS=$($DC logs vpn qbittorrent 2>&1)
checkno "docker logs never contain the private key" bash -c "echo '$LOGS' | grep -q -F '$C_PRIV'"
checkno "docker logs never contain a PublicKey/PrivateKey line" bash -c "echo '$LOGS' | grep -q -E 'PrivateKey|PublicKey|$S1_PUB|$S2_PUB'"
checkno "private key is on no filesystem path inside vpn" $DC exec -T vpn sh -c "grep -rIl -F '$C_PRIV' /etc /tmp /run /var /root /usr /home 2>/dev/null | grep -q ."
checkno "zero direct successes (whole run so far)" probe test -s /tmp/leaks
probe touch /tmp/stop
leaks=$(probe sh -c 'cat /tmp/leaks 2>/dev/null | wc -c'); echo "  (leak watcher: $leaks bytes of direct-path replies in total)"

# ---------------------------------------------------------------- 7
section "7. restart with VPN_DEFAULT_MODE=required"
connect B B >/dev/null
VPN_DEFAULT_MODE=required $DC up -d --force-recreate --wait vpn qbittorrent probe >/dev/null 2>&1
check "after recreate: mode=required, not connected" test "$(status | jqs '.mode+" "+(.connected|tostring)')" = "required false"
checkno "direct echo blocked right after restart" probe curl -sS -m 3 http://198.51.100.20/
checkno "tunnel target blocked until /connect" probe curl -sS -m 3 http://203.0.113.20/
check "WebUI reachable after restart" $DC exec -T lan-client curl -fsS -m 5 http://vpn:8080/api/v2/app/version
OUT=$(connect A A); check "/connect works after restart" jqok .connected
check "POST /mode with the current mode leaves a live tunnel alone" mode_noop
check "tunnel works after restart" retry 10 probe curl -sS -m 5 http://203.0.113.20/
# plain `docker restart` (same container, stale resolv.conf from the previous run must be healed)
docker stop -t 20 sbvpn-qbittorrent-1 sbvpn-probe-1 >/dev/null
check "qbittorrent got SIGTERM and exited cleanly (tini could forward it: needs CAP_KILL; otherwise resume data is lost)" sh_ "! docker logs sbvpn-qbittorrent-1 2>&1 | grep -q 'FATAL tini' && test \"\$(docker inspect -f '{{.State.ExitCode}}' sbvpn-qbittorrent-1)\" = 0"
docker restart -t 1 sbvpn-vpn-1 >/dev/null
for i in $(seq 1 20); do [ "$(docker inspect -f '{{.State.Health.Status}}' sbvpn-vpn-1)" = healthy ] && break; sleep 1; done
check "docker restart (required default): fail closed, mode=required" test "$(status | jqs '.mode+" "+(.connected|tostring)')" = "required false"
P2="docker run --rm --network container:sbvpn-vpn-1 -u 1000 sbvpn-tools"
checkno "fresh namespace: direct echo blocked" $P2 curl -sS -m 3 http://198.51.100.20/
checkno "fresh namespace: DNS blocked" $P2 nslookup example.com
VPN_DEFAULT_MODE= $DC up -d --force-recreate --wait vpn >/dev/null 2>&1
check "VPN_DEFAULT_MODE unset/empty = required (fail closed)" test "$(status | jqs '.mode+" "+(.connected|tostring)')" = "required false"
VPN_MTU=1350 $DC up -d --force-recreate --wait vpn >/dev/null 2>&1
OUT=$(connect A A)   # A has no MTU line: VPN_MTU applies
check "VPN_MTU=1350 and no config MTU: wg interface MTU = 1350" sh_ "test \"\$($DC exec -T vpn sh -c 'cat /sys/class/net/wg*/mtu')\" = 1350 && test \"\$(status | jqs .mtu)\" = 1350"
OUT=$(connect B B)
check "config MTU = 1380 beats VPN_MTU=1350" sh_ "test \"\$($DC exec -T vpn sh -c 'cat /sys/class/net/wg*/mtu')\" = 1380"
VPN_MTU=99 $DC up -d --force-recreate vpn >/dev/null 2>&1; sleep 3
check "invalid VPN_MTU (99) is refused at start" sh_ "docker logs sbvpn-vpn-1 2>&1 | grep -q 'VPN_MTU must be'"
VPN_DEFAULT_MODE=off $DC up -d --force-recreate --wait vpn >/dev/null 2>&1
P2="docker run --rm --network container:sbvpn-vpn-1 -u 1000 sbvpn-tools"
check "default off after recreate: direct echo reachable" retry 10 $P2 curl -sS -m 4 http://198.51.100.20/
check "default off: resolv.conf is Docker's" bash -c "$P2 cat /etc/resolv.conf | grep -q 127.0.0.11"
check "status mode=off" test "$(status | jqs .mode)" = off

section "result"
[ -s "$WORK/retries" ] && { echo "  checks that needed retries (loaded host / slow handshake):"; sed 's/^/    /' "$WORK/retries"; }
echo "passed=$PASS failed=$FAILN"
[ "$FAILN" = 0 ]
