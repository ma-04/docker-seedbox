#!/bin/sh
# Docker test: the gateway image renders a valid nginx configuration (nginx -t) for every host layout, the rendered
# configuration routes /auth/ and /dl/ to exactly the hosts in use, and invalid layouts refuse to start.
# Usage: GATEWAY_IMAGE=<built gateway image> services/gateway/test/layouts.sh
set -u
IMG=${GATEWAY_IMAGE:-gateway-under-test}
PASS=0; FAILN=0
ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAILN=$((FAILN+1)); printf '  FAIL %s\n' "$1"; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

# render NAME AUTH_MODE APP AUTH FILES : runs the image's entrypoint (envsubst + 25-gateway-auth-mode.sh) and nginx -T
render() {
  docker run --rm -e GATEWAY_SECRET=test -e AUTH_MODE="$2" -e APP_HOST="$3" -e AUTH_HOST="$4" -e FILES_HOST="$5" \
    "$IMG" nginx -T > "$T/$1.conf" 2> "$T/$1.err"
}
# section NAME FILE : one file of the `nginx -T` dump (it prints every loaded file under "# configuration file X:")
section() { awk -v h="# configuration file $2:" '$0==h{f=1;next} /^# configuration file /{f=0} f' "$T/$1.conf"; }
# app NAME : what the generator added to the APP_HOST server;  server NAME HOST : a generated separate-host server
app() { section "$1" /tmp/gateway/app-locations.conf; }
server() { section "$1" /tmp/gateway/servers.conf | awk -v h="server_name $2;" 'index($0,h){f=1} f{print} f&&/^}/{exit}'; }
has() { if printf '%s\n' "$1" | grep -qF -- "$2"; then ok "$3"; else bad "$3"; fi; }
hasnt() { if printf '%s\n' "$1" | grep -qF -- "$2"; then bad "$3"; else ok "$3"; fi; }

echo "single domain (AUTH_HOST and FILES_HOST empty)"
if render single authelia app.example.test "" ""; then ok "nginx -t passes"; else bad "nginx -t passes: $(cat "$T/single.err")"; fi
app=$(app single)
has "$app" "location ^~ /auth/" "app host serves the portal under /auth/"
has "$app" "include /etc/nginx/snippets/files-locations.conf;" "app host includes the download locations"
has "$(section single /etc/nginx/snippets/files-locations.conf)" "location /_protected/" "the internal /_protected/ location is loaded"
has "$(cat "$T/single.conf")" 'proxy_set_header Cookie "";' "the login cookie is blanked towards the API on /dl/"
hasnt "$(section single /tmp/gateway/servers.conf)" "server_name" "no separate login or download server"

echo "equal to APP_HOST counts as empty (any case)"
if render equal authelia app.example.test APP.example.test app.example.test; then ok "nginx -t passes"; else bad "nginx -t passes: $(cat "$T/equal.err")"; fi
has "$(app equal)" "location ^~ /auth/" "portal under /auth/"
hasnt "$(section equal /tmp/gateway/servers.conf)" "server_name" "no extra server block"

echo "app + login on one host, separate download host"
if render split authelia app.example.test "" files.example.test; then ok "nginx -t passes"; else bad "nginx -t passes: $(cat "$T/split.err")"; fi
app=$(app split); files=$(server split files.example.test)
has "$app" "location ^~ /auth/" "app host serves the portal under /auth/"
has "$app" "location ^~ /dl/ { return 404; }" "/dl/ on the app host is a 404"
hasnt "$app" "files-locations.conf" "no download locations on the app host"
has "$files" "include /etc/nginx/snippets/files-locations.conf;" "download host serves /dl/"
hasnt "$files" "/auth/" "download host has no portal"

echo "three hosts (the layout before single-domain support)"
if render multi authelia app.example.test auth.example.test files.example.test; then ok "nginx -t passes"; else bad "nginx -t passes: $(cat "$T/multi.err")"; fi
app=$(app multi); auth=$(server multi auth.example.test); files=$(server multi files.example.test)
hasnt "$app" "/auth/" "no portal location on the app host"
has "$app" "location ^~ /dl/ { return 404; }" "/dl/ on the app host is a 404"
has "$auth" "include /etc/nginx/snippets/authelia-portal.conf;" "login host proxies to Authelia"
hasnt "$auth" "auth_request" "login host is not behind auth_request"
has "$files" "include /etc/nginx/snippets/files-locations.conf;" "download host serves /dl/"

echo "AUTH_MODE=external, single domain: no Authelia location"
if render ext external app.example.test "" ""; then ok "nginx -t passes"; else bad "nginx -t passes: $(cat "$T/ext.err")"; fi
hasnt "$(app ext)" "location ^~ /auth/" "no /auth/ location"
has "$(app ext)" "files-locations.conf" "app host serves /dl/"

echo "invalid layouts refuse to start"
if render dup authelia app.example.test same.example.test same.example.test; then bad "AUTH_HOST = FILES_HOST refused"; else ok "AUTH_HOST = FILES_HOST refused"; fi
if render inj authelia app.example.test 'x.example.test; }' ""; then bad "a hostname with nginx syntax refused"; else ok "a hostname with nginx syntax refused"; fi
if render noapp authelia "" "" ""; then bad "missing APP_HOST refused"; else ok "missing APP_HOST refused"; fi

echo; echo "passed=$PASS failed=$FAILN"
[ "$FAILN" = 0 ]
