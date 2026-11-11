#!/bin/sh
# Docker test: the gateway's /_protected/ location must never serve through a symlink (`disable_symlinks on`).
# Serves a throwaway tree with the same alias + directive as snippets/files-locations.conf and checks that a regular
# file is served while a symlink to a file, a symlink to a directory and a file below a symlinked directory are refused.
# Usage: GATEWAY_IMAGE=<any nginx image with wget> services/gateway/test/symlinks.sh
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
IMG=${GATEWAY_IMAGE:-nginx:alpine}
NAME=gate-gw-symlinks-$$
W=$(mktemp -d)
PASS=0; FAILN=0
ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAILN=$((FAILN+1)); printf '  FAIL %s\n' "$1"; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1; rm -rf "$W"; }
trap cleanup EXIT

# the real snippet (included for whichever host serves downloads) carries the directive inside the /_protected/ location
if awk '/location \/_protected\//{f=1} f&&/disable_symlinks on;/{found=1} f&&/^}/{f=0} END{exit !found}' "$HERE/snippets/files-locations.conf"; then
  ok "snippets/files-locations.conf: /_protected/ has 'disable_symlinks on;'"
else bad "snippets/files-locations.conf: /_protected/ lacks 'disable_symlinks on;'"; fi

mkdir -p "$W/library/alice-1/Pack" "$W/outside/dir"
echo "plain file" > "$W/library/alice-1/Pack/ok.txt"
echo "SECRET-OUTSIDE" > "$W/outside/secret.txt"
echo "SECRET-DIR" > "$W/outside/dir/inner.txt"
ln -s /downloads/outside/secret.txt "$W/library/alice-1/Pack/linkfile"
ln -s /downloads/outside/dir "$W/library/alice-1/Pack/linkdir"
ln -s /downloads/outside "$W/library/linked-user"
chmod -R a+rX "$W"
cat > "$W/nginx.conf" <<'CONF'
pid /tmp/nginx.pid;
events {}
http {
  access_log off;
  client_body_temp_path /tmp/c; proxy_temp_path /tmp/p; fastcgi_temp_path /tmp/f; uwsgi_temp_path /tmp/u; scgi_temp_path /tmp/s;
  server {
    listen 8080;
    location /_protected/ {
      alias /downloads/library/;
      disable_symlinks on;
      autoindex off;
    }
  }
}
CONF
chmod a+r "$W/nginx.conf"
docker run -d --name "$NAME" -v "$W:/downloads:ro" -v "$W/nginx.conf:/etc/nginx/nginx.conf:ro" --entrypoint nginx "$IMG" -g 'daemon off;' >/dev/null || { echo "cannot start nginx"; exit 2; }
sleep 2
get() { docker exec "$NAME" wget -q -O - "http://127.0.0.1:8080/_protected/$1" 2>/dev/null; }
code() { docker exec "$NAME" wget -S -q -O /dev/null "http://127.0.0.1:8080/_protected/$1" 2>&1 | sed -n 's/.*HTTP\/[0-9.]* \([0-9][0-9]*\).*/\1/p' | tail -1; }

[ "$(get alice-1/Pack/ok.txt)" = "plain file" ] && ok "a regular file is served" || bad "a regular file is served"
[ "$(code alice-1/Pack/linkfile)" = 403 ] && ok "symlink to a file outside: 403" || bad "symlink to a file outside: 403 (got $(code alice-1/Pack/linkfile))"
# a link in a directory position is answered 404 (the open of the path fails), a link as the last component 403: both are refusals
refused() { case "$(code "$1")" in 403|404) return 0 ;; *) return 1 ;; esac; }
refused alice-1/Pack/linkdir/inner.txt && ok "file below a symlinked directory: refused (403/404)" || bad "file below a symlinked directory: refused (got $(code alice-1/Pack/linkdir/inner.txt))"
refused linked-user/secret.txt && ok "symlinked top-level directory: refused (403/404)" || bad "symlinked top-level directory: refused (got $(code linked-user/secret.txt))"
case "$(get alice-1/Pack/linkfile)$(get linked-user/secret.txt)" in *SECRET*) bad "secret content leaked" ;; *) ok "no secret content in any response" ;; esac

echo; echo "passed=$PASS failed=$FAILN"
[ "$FAILN" = 0 ]
