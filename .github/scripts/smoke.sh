#!/usr/bin/env bash
# shellcheck disable=SC2015  # `check && ok "..." || fail "..."` below: ok() always succeeds, fail() exits
# Smoke test of ONE built image on the machine it was built on (no emulation: CI runs this on an amd64 runner for the
# amd64 image and on an arm64 runner for the arm64 image). Used by .github/workflows/images.yml.
#
#   .github/scripts/smoke.sh IMAGE REF ARCH [VERSION]
#     IMAGE    api | web | gateway | vpn | qbittorrent
#     REF      what to run: a local tag, or registry/name@sha256:... (pulled first)
#     ARCH     amd64 | arm64: the image must be linux/ARCH and so must this machine
#     VERSION  optional: the web bundle must contain this version string (VITE_APP_VERSION)
#
# It proves the image starts and does its basic job on that architecture; it is not a functional test (that is the
# e2e suite and the VPN sidecar test).
set -euo pipefail
IMAGE=${1:?image}; REF=${2:?ref}; ARCH=${3:?arch}; VERSION=${4:-}
NAME="smoke-$IMAGE-$$"
PASS=0
ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; docker logs "$NAME" 2>&1 | tail -n 50 | sed 's/^/       | /' || true; exit 1; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm -f "$NAME-vol" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# until SECONDS CMD... : retry once a second
until_ok() { local n=$1 i; shift; for ((i = 0; i < n; i++)); do if "$@" >/dev/null 2>&1; then return 0; fi; sleep 1; done; return 1; }
ex() { docker exec "$NAME" "$@"; }
# Output is captured first and then matched: `cmd | grep -q` under pipefail fails at random when grep exits early and
# cmd gets SIGPIPE.
has() { grep -q "$@"; }

echo "== smoke test: $IMAGE ($REF) on $(uname -m)"
case "$ARCH" in
  amd64) [ "$(uname -m)" = x86_64 ] || fail "this machine is $(uname -m), not amd64: run the smoke test on the native runner" ;;
  arm64) [ "$(uname -m)" = aarch64 ] || fail "this machine is $(uname -m), not arm64: run the smoke test on the native runner" ;;
  *) fail "unknown arch $ARCH" ;;
esac
case "$REF" in *@sha256:*) docker pull -q "$REF" >/dev/null || fail "pull $REF" ;; esac
plat=$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$REF")
[ "$plat" = "linux/$ARCH" ] && ok "image platform is $plat" || fail "image platform is $plat, expected linux/$ARCH"
# Containers run with the hardening flags deploy/compose.yaml gives them (read-only root, dropped capabilities).
HARDEN=(--read-only --cap-drop ALL --security-opt no-new-privileges:true)
SECRET=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')   # 48 hex chars (APP_SECRET needs >= 32)

case "$IMAGE" in
  api)
    run() { docker run --rm --entrypoint "$1" "$REF" "${@:2}"; }
    [ "$(run uname -m)" = "$(uname -m)" ] && ok "container userland runs natively ($(uname -m))" || fail "uname -m inside the image"
    out=$(run /usr/local/bin/rclone version) && v=${out%%$'\n'*} && [[ $v == "rclone v"* ]] && ok "rclone version: $v" || fail "rclone version"
    # Boot the API against an empty database: it opens SQLite (better-sqlite3, a native module) and applies every
    # migration before it listens.
    docker run -d --name "$NAME" "${HARDEN[@]}" --tmpfs /tmp:uid=1000,gid=1000 -v "$NAME-vol:/data" \
      -e APP_SECRET="$SECRET" -e GATEWAY_SECRET=smoke -e VPN_CONTROL_TOKEN=smoke "$REF" >/dev/null
    health='fetch("http://127.0.0.1:3000/api/health",{headers:{"x-gateway-secret":"smoke"}}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))'
    until_ok 60 ex node -e "$health" && ok "api boots and answers /api/health (uid $(ex id -u), read-only root)" || fail "api /api/health"
    want=$(ex sh -c 'ls migrations/*.sql | wc -l' | tr -d ' ')
    got=$(ex node -e 'const D=require("better-sqlite3");const db=new D("/data/seedbox.db",{readonly:true});console.log(db.prepare("SELECT count(*) n FROM schema_migrations").get().n)')
    [ "$want" -gt 0 ] && [ "$got" = "$want" ] && ok "all $got migrations applied to a fresh database" || fail "migrations: $got applied, $want shipped"
    ;;
  web)
    docker run -d --name "$NAME" "${HARDEN[@]}" --tmpfs /tmp:uid=101,gid=101 "$REF" >/dev/null
    until_ok 30 ex wget -q -O /dev/null http://127.0.0.1:8080/healthz && ok "web serves /healthz" || fail "web /healthz"
    out=$(ex wget -q -O - http://127.0.0.1:8080/) && has -i '<html' <<<"$out" && ok "web serves index.html" || fail "web /"
    if [ -n "$VERSION" ]; then
      ex grep -rqF -- "$VERSION" /usr/share/nginx/html/assets && ok "bundle carries version $VERSION" || fail "VITE_APP_VERSION $VERSION not in the bundle"
    fi
    ;;
  gateway)
    docker run -d --name "$NAME" "${HARDEN[@]}" --tmpfs /tmp:uid=101,gid=101 --tmpfs /etc/nginx/conf.d:uid=101,gid=101 \
      -e APP_HOST=app.smoke.test -e AUTH_HOST=auth.smoke.test -e FILES_HOST=files.smoke.test -e GATEWAY_SECRET=smoke "$REF" >/dev/null
    until_ok 30 ex wget -q -O /dev/null http://127.0.0.1:8080/healthz && ok "gateway serves /healthz" || fail "gateway /healthz"
    out=$(ex nginx -t 2>&1) && has 'test is successful' <<<"$out" && ok "nginx -t on the rendered configuration" || fail "nginx -t: $out"
    ;;
  vpn)
    run() { docker run --rm --entrypoint "$1" "$REF" "${@:2}"; }
    v=$(run wg --version) && ok "wg: $v" || fail "wg --version"
    v=$(run nft --version) && ok "nft: $v" || fail "nft --version"
    v=$(run ip -V) && ok "ip: $v" || fail "ip -V"
    # The control binary installs the kill-switch ruleset (nftables, needs NET_ADMIN) before it serves the API; its
    # own healthcheck then calls /status.
    docker run -d --name "$NAME" --cap-drop ALL --cap-add NET_ADMIN --sysctl net.ipv6.conf.all.disable_ipv6=1 \
      -e VPN_CONTROL_TOKEN=smoke "$REF" >/dev/null
    until_ok 30 ex /usr/local/bin/vpn-control healthcheck && ok "vpn-control started, kill switch installed, healthcheck passes" || fail "vpn-control healthcheck"
    out=$(ex nft list ruleset) && has 'policy drop' <<<"$out" && ok "nftables ruleset is fail-closed (policy drop)" || fail "nft list ruleset"
    if ex ip link add smokewg0 type wireguard 2>/dev/null; then ex ip link del smokewg0; ok "kernel WireGuard available on this runner ($(uname -r))"
    else echo "::warning::kernel WireGuard is not available on this $ARCH runner ($(uname -r)); the image cannot be tested end to end here"; fi
    ;;
  qbittorrent)
    v=$(docker run --rm --entrypoint qbittorrent-nox "$REF" --version) && ok "qbittorrent-nox --version: $v" || fail "qbittorrent-nox --version"
    docker run -d --name "$NAME" "${HARDEN[@]}" --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add KILL \
      --tmpfs /tmp -v "$NAME-vol:/config" -e QBT_TRUSTED_IPS=172.31.250.3,172.31.250.4 "$REF" >/dev/null
    until_ok 60 ex curl -fsS -o /dev/null http://127.0.0.1:8080/api/v2/app/version && ok "WebUI answers through the entrypoint (seed-config.sh)" || fail "qBittorrent WebUI"
    ;;
  *) fail "unknown image $IMAGE" ;;
esac
echo "== $IMAGE/$ARCH: $PASS checks passed"
