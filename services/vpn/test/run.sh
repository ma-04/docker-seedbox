#!/usr/bin/env bash
# Hermetic test of the vpn sidecar: kill switch, rotation, restart behaviour.
# Needs docker + compose v2.33+ and a kernel with WireGuard. Uses project name "sbvpn";
# all keys are generated at run time into a temp dir that is removed on exit.
# Usage: ./run.sh [--keep]   (--keep leaves the stack up for debugging)
set -u
cd "$(dirname "$0")"
export COMPOSE_PROJECT_NAME=sbvpn
DC="docker compose -f compose.yaml"
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
status() { ctl GET /status | head -1; }
connect() { # name file : POST /connect with the generated config
  $DC cp "$WORK/$2.conf" lan-client:/tmp/cfg.conf >/dev/null 2>&1
  $DC exec -T lan-client sh -c "jq -Rs --arg name '$1' '{name:\$name, config:.}' /tmp/cfg.conf | /t/ctl.sh POST /connect"
}
cleanup() {
  if [ "$KEEP" = 0 ]; then
    $DC down -v --remove-orphans >/dev/null 2>&1
    docker rmi sbvpn-vpn sbvpn-qbittorrent sbvpn-tools >/dev/null 2>&1
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
export -f ctl probe probe_ip jqs status connect sh_ has jqok
export DC WORK

section "build + keys"
$DC build tools-build vpn qbittorrent >/dev/null || { echo "build failed"; exit 2; }
gen() { docker run --rm sbvpn-tools sh -c 'k=$(wg genkey); echo $k; echo $k | wg pubkey' | paste -sd' ' -; }
read -r C_PRIV C_PUB < <(gen)
read -r S1_PRIV S1_PUB < <(gen)
read -r S2_PRIV S2_PUB < <(gen)
export CLIENT_PUB=$C_PUB WG1_PRIV=$S1_PRIV WG2_PRIV=$S2_PRIV
# Config A: hostname endpoint + IPv6 default route; config B: IP endpoint. DNS = the server's tunnel address.
mkconf() { # name tunnel-net server-pub endpoint
cat > "$WORK/$1.conf" <<CONF
[Interface]
PrivateKey = $C_PRIV
Address = $2.2/32, fd99::2/128
DNS = $2.1
[Peer]
PublicKey = $3
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = $4
CONF
}
mkconf A 10.99.1 "$S1_PUB" wg1:51820
mkconf B 10.99.2 "$S2_PUB" 172.31.251.12:51820
{ cat "$WORK/A.conf"; echo "PostUp = touch /tmp/pwned"; } > "$WORK/evil.conf"

$DC up -d echo-direct echo-behind wg1 wg2 lan-client >/dev/null
VPN_DEFAULT_MODE=off $DC up -d --wait vpn qbittorrent probe >/dev/null || { $DC ps; $DC logs vpn qbittorrent | tail -30; exit 2; }
sleep 1

# ---------------------------------------------------------------- 1
section "1. off mode"
check "status mode=off, not connected" test "$(status | jqs '.mode+" "+(.connected|tostring)')" = "off false"
check "namespace reaches the direct echo service" sh_ "probe_ip 172.31.251.20 | grep -q '^direct 172.31.251.2\$'"
check "WebUI :8080 reachable from LAN client" $DC exec -T lan-client curl -fsS -m 5 http://vpn:8080/api/v2/app/version
check "resolv.conf = Docker resolver" $DC exec -T probe grep -q 127.0.0.11 /etc/resolv.conf
check "qBittorrent healthy" $DC exec -T lan-client curl -fsS -m 5 http://vpn:8080/api/v2/app/version
OUT=$($DC exec -T lan-client curl -fsS -m 5 http://vpn:8080/api/v2/app/preferences)
check "qBittorrent seeded: port 8080, LAN whitelist, no host-header/CSRF checks" jqok '.web_ui_port==8080 and .bypass_auth_subnet_whitelist_enabled and .bypass_auth_subnet_whitelist=="172.31.250.0/24" and (.web_ui_host_header_validation_enabled|not) and (.web_ui_csrf_protection_enabled|not)'
check "qBittorrent seeded: no UPnP, DHT/PeX on, save path, no prealloc, anonymous off" jqok '(.upnp|not) and .dht and .pex and .save_path=="/downloads/incomplete" and (.preallocate_all|not) and (.anonymous_mode|not) and .current_network_interface==""'
OUT=""
check "qBittorrent runs as uid 1000" bash -c "$DC exec -T qbittorrent sh -c 'ps -o user,args | grep \"[q]bittorrent-nox\"' | grep -q qbtUser"

# ---------------------------------------------------------------- 2
section "2. required mode, no tunnel"
check "POST /mode required" test "$(echo '{"mode":"required"}' | ctl POST /mode | head -1 | jqs .mode)" = required
# leak watcher: runs in the namespace (uid 1000) for the rest of the test, hammering the direct echo service
probe sh -c 'rm -f /tmp/leaks /tmp/stop'
$DC exec -T -d -u 1000 probe sh -c 'while [ ! -e /tmp/stop ]; do curl -s -m 1 http://172.31.251.20/ >> /tmp/leaks; sleep 0.1; done'
checkno "direct echo unreachable (curl as uid 1000)" probe curl -sS -m 4 http://172.31.251.20/
checkno "direct echo unreachable even bound to the LAN-side-less NIC" probe sh -c 'curl -sS -m 3 --interface $(ip -4 route show default | sed -n "s/.* dev \([^ ]*\).*/\1/p" | head -1) http://172.31.251.20/'
checkno "DNS lookup of an outside name fails (system resolver)" probe nslookup example.com
checkno "DNS straight at Docker resolver 127.0.0.11 fails" probe nslookup example.com 127.0.0.11
checkno "DNS straight at 8.8.8.8 fails" probe nslookup -timeout=2 -retry=1 example.com 8.8.8.8
checkno "IPv6 egress fails" probe curl -g -6 -sS -m 3 'http://[2606:4700:4700::1111]/'
check "resolv.conf has no nameserver (fail closed)" bash -c "! $DC exec -T probe grep -q '^nameserver' /etc/resolv.conf"
check "WebUI still reachable from LAN client" $DC exec -T lan-client curl -fsS -m 5 http://vpn:8080/api/v2/app/version
check "status: required, not connected" test "$(status | jqs '.mode+" "+(.connected|tostring)')" = "required false"

# ---------------------------------------------------------------- 3
section "3. connect A (hostname endpoint, ::/0 in AllowedIPs)"
OUT=$(connect A A); echo "$OUT" | head -1
check "HTTP 200" has '^HTTP 200$'
check "connected=true, name=A" jqok '.connected and .name=="A"'
check "recent handshake (<=10s)" jqok '.lastHandshakeSec<=10'
check "echo behind WG1 reachable, source = wg1" sh_ "probe curl -sS -m 5 http://172.31.252.20/ | grep -q '^behind 172.31.252.11$'"
checkno "direct echo still blocked" probe curl -sS -m 3 http://172.31.251.20/
check "IPv6 stripped from tunnel (no :: in allowed-ips)" bash -c "! $DC exec -T vpn wg show wg0 allowed-ips | grep -q ::"
check "resolv.conf points at the tunnel DNS (shared with qbittorrent)" $DC exec -T qbittorrent grep -q '^nameserver 10.99.1.1' /etc/resolv.conf
# DNS really goes through the tunnel: capture the query on the server side
$DC exec -T -d wg1 sh -c 'timeout 8 socat -u UDP4-RECV:53 - > /tmp/dnsq'
sleep 1; probe nslookup -timeout=2 -retry=1 example.com >/dev/null 2>&1
sleep 1; check "DNS query arrived at the WG server via the tunnel" $DC exec -T wg1 sh -c 'test -s /tmp/dnsq'
for i in $(seq 1 10); do [ "$(status | jqs '.publicIp')" = 172.31.252.11 ] && break; sleep 1; done
check "status.publicIp = 172.31.252.11 (PUBLIC_IP_URL via tunnel)" test "$(status | jqs .publicIp)" = 172.31.252.11
check "WebUI still reachable from LAN client with tunnel up" $DC exec -T lan-client curl -fsS -m 5 http://vpn:8080/api/v2/app/version
checkno "WebUI/control not reachable via the tunnel address (input drop)" $DC exec -T wg1 curl -sS -m 3 http://10.99.1.2:8000/status
checkno "no leak so far" probe test -s /tmp/leaks

# ---------------------------------------------------------------- 4
section "4. rotation A -> B"
OUT=$(connect B B); echo "$OUT" | head -1
check "connected=true, name=B" jqok '.connected and .name=="B"'
check "traffic now exits via wg2 (source 172.31.252.12)" sh_ "probe curl -sS -m 5 http://172.31.252.20/ | grep -q '^behind 172.31.252.12$'"
check "exactly one wg interface remains" test "$($DC exec -T vpn sh -c 'ip -o link | grep -c "wg[0-9]"')" = 1
checkno "direct echo blocked after switch" probe curl -sS -m 3 http://172.31.251.20/
checkno "zero direct successes during the switch (leak loop)" probe test -s /tmp/leaks
OUT=$(connect A A); echo "$OUT" | head -1
check "and back: B -> A" sh_ "probe curl -sS -m 5 http://172.31.252.20/ | grep -q '^behind 172.31.252.11$'"
checkno "zero direct successes during second switch" probe test -s /tmp/leaks
OUT=$(echo "{\"name\":\"bad\",\"config\":$(sed 's/^PublicKey.*/PublicKey = '"$C_PUB"'/' "$WORK/B.conf" | jq -Rs .)}" | ctl POST /connect)
check "bad-key config (no handshake) -> 502" has '^HTTP 502$'
check "old tunnel (A) kept after the failed switch" sh_ "status | jq -e '.connected and .name==\"A\"'"
checkno "zero direct successes after failed switch" probe test -s /tmp/leaks

# ---------------------------------------------------------------- 5
section "5. disconnect / server death"
OUT=$(ctl POST /disconnect); echo "$OUT" | head -1
check "disconnected, mode still required" jqok '(.connected|not) and .mode=="required"'
checkno "tunnel target blocked after /disconnect" probe curl -sS -m 3 http://172.31.252.20/
checkno "direct echo blocked after /disconnect" probe curl -sS -m 3 http://172.31.251.20/
check "WebUI reachable after /disconnect" $DC exec -T lan-client curl -fsS -m 5 http://vpn:8080/api/v2/app/version
connect A A >/dev/null
check "reconnected to A" probe curl -sS -m 5 http://172.31.252.20/
docker stop -t 1 sbvpn-wg1-1 >/dev/null
sleep 2
checkno "WG server dead: tunnel target unreachable" probe curl -sS -m 3 http://172.31.252.20/
checkno "WG server dead: direct echo still blocked (no fallback)" probe curl -sS -m 3 http://172.31.251.20/
checkno "WG server dead: direct to the endpoint's own network blocked" probe curl -sS -m 3 http://172.31.251.11/
docker start sbvpn-wg1-1 >/dev/null
checkno "zero direct successes through all of the above" probe test -s /tmp/leaks

# ---------------------------------------------------------------- 6
section "6. auth, hostile config, logs"
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
checkno "direct echo blocked right after restart" probe curl -sS -m 3 http://172.31.251.20/
checkno "tunnel target blocked until /connect" probe curl -sS -m 3 http://172.31.252.20/
check "WebUI reachable after restart" $DC exec -T lan-client curl -fsS -m 5 http://vpn:8080/api/v2/app/version
OUT=$(connect A A); check "/connect works after restart" jqok .connected
check "tunnel works after restart" probe curl -sS -m 5 http://172.31.252.20/
# plain `docker restart` (same container, stale resolv.conf from the previous run must be healed)
docker stop -t 1 sbvpn-qbittorrent-1 sbvpn-probe-1 >/dev/null
docker restart -t 1 sbvpn-vpn-1 >/dev/null
for i in $(seq 1 20); do [ "$(docker inspect -f '{{.State.Health.Status}}' sbvpn-vpn-1)" = healthy ] && break; sleep 1; done
check "docker restart (required default): fail closed, mode=required" test "$(status | jqs '.mode+" "+(.connected|tostring)')" = "required false"
P2="docker run --rm --network container:sbvpn-vpn-1 -u 1000 sbvpn-tools"
checkno "fresh namespace: direct echo blocked" $P2 curl -sS -m 3 http://172.31.251.20/
checkno "fresh namespace: DNS blocked" $P2 nslookup example.com
VPN_DEFAULT_MODE=off $DC up -d --force-recreate --wait vpn >/dev/null 2>&1
P2="docker run --rm --network container:sbvpn-vpn-1 -u 1000 sbvpn-tools"
check "default off after recreate: direct echo reachable" $P2 curl -sS -m 4 http://172.31.251.20/
check "default off: resolv.conf is Docker's" bash -c "$P2 cat /etc/resolv.conf | grep -q 127.0.0.11"
check "status mode=off" test "$(status | jqs .mode)" = off

section "result"
echo "passed=$PASS failed=$FAILN"
[ "$FAILN" = 0 ]
