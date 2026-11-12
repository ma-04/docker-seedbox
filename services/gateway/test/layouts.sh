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

# /jackett/ (torrent search UI, admin-only in the API): routed to the api on the app host, behind the page login,
# with exactly ONE X-Gateway-Secret (a duplicate would arrive as "secret, secret" and fail the API's check).
jk() { awk '/location \^~ \/jackett\/ \{/{f=1} f{print} f&&/^  \}/{exit}' "$T/$1.conf"; }
has "$(jk single)" "include /tmp/gateway/auth-page-to-api.conf;" "/jackett/ goes through the page login"
# shellcheck disable=SC2016  # a literal nginx variable
has "$(jk single)" 'proxy_pass $api_upstream;' "/jackett/ is proxied to the api (never to Jackett directly)"
hasnt "$(jk single)" "to-api.conf;" "/jackett/ does not add a second gateway secret"
n=$(section single /tmp/gateway/auth-page-to-api.conf | grep -c 'X-Gateway-Secret')
if [ "$n" = 1 ]; then ok "authelia: the /jackett/ snippet sets X-Gateway-Secret exactly once"; else bad "authelia: X-Gateway-Secret set $n times"; fi
hasnt "$(cat "$T/single.conf")" "vpn:9117" "the gateway never addresses Jackett"

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
has "$(jk multi)" "include /tmp/gateway/auth-page-to-api.conf;" "three hosts: /jackett/ stays on the app host"
hasnt "$app" "/auth/" "no portal location on the app host"
has "$app" "location ^~ /dl/ { return 404; }" "/dl/ on the app host is a 404"
has "$auth" "include /etc/nginx/snippets/authelia-portal.conf;" "login host proxies to Authelia"
hasnt "$auth" "auth_request" "login host is not behind auth_request"
has "$files" "include /etc/nginx/snippets/files-locations.conf;" "download host serves /dl/"

echo "AUTH_MODE=external, single domain: no Authelia location"
if render ext external app.example.test "" ""; then ok "nginx -t passes"; else bad "nginx -t passes: $(cat "$T/ext.err")"; fi
n=$(section ext /tmp/gateway/auth-page-to-api.conf | grep -c 'X-Gateway-Secret')
if [ "$n" = 1 ]; then ok "external: the /jackett/ snippet sets X-Gateway-Secret exactly once"; else bad "external: X-Gateway-Secret set $n times"; fi
hasnt "$(section ext /tmp/gateway/auth-page-to-api.conf)" "auth_request" "external: no Authelia sub-request for /jackett/"
hasnt "$(app ext)" "location ^~ /auth/" "no /auth/ location"
has "$(app ext)" "files-locations.conf" "app host serves /dl/"

echo "AUTH_MODE=external with a leftover AUTH_HOST: ignored (no server block proxying to an Authelia that does not run)"
if render extauth external app.example.test auth.example.test ""; then ok "nginx -t passes"; else bad "nginx -t passes: $(cat "$T/extauth.err")"; fi
hasnt "$(section extauth /tmp/gateway/servers.conf)" "server_name auth.example.test;" "no login server block"
hasnt "$(app extauth)" "location ^~ /auth/" "no /auth/ location"

echo "separate login host, downloads on the app host"
if render authonly authelia app.example.test auth.example.test ""; then ok "nginx -t passes"; else bad "nginx -t passes: $(cat "$T/authonly.err")"; fi
app=$(app authonly); auth=$(server authonly auth.example.test)
hasnt "$app" "/auth/" "no portal location on the app host"
has "$app" "include /etc/nginx/snippets/files-locations.conf;" "app host serves /dl/"
has "$auth" "include /etc/nginx/snippets/authelia-portal.conf;" "login host proxies to Authelia"
hasnt "$(section authonly /tmp/gateway/servers.conf)" "server_name files." "no download server block"

echo "values are trimmed and lowercased (like the API and the Authelia template)"
if render norm authelia " App.Example.test " "APP.example.test " " Files.Example.test"; then ok "nginx -t passes"; else bad "nginx -t passes: $(cat "$T/norm.err")"; fi
has "$(app norm)" "location ^~ /auth/" "an AUTH_HOST equal to APP_HOST up to case and blanks means /auth/ on the app host"
has "$(server norm files.example.test)" "server_name files.example.test;" "FILES_HOST rendered lowercased and trimmed"

echo "invalid layouts refuse to start"
if render dup authelia app.example.test same.example.test same.example.test; then bad "AUTH_HOST = FILES_HOST refused"; else ok "AUTH_HOST = FILES_HOST refused"; fi
if render inj authelia app.example.test 'x.example.test; }' ""; then bad "a hostname with nginx syntax refused"; else ok "a hostname with nginx syntax refused"; fi
if render noapp authelia "" "" ""; then bad "missing APP_HOST refused"; else ok "missing APP_HOST refused"; fi
# the same rule as setup.sh's HOST_RE
for h in localhost a-.example.test -a.example.test a..example.test 'a.example.test
evil.test'; do
  if render badhost authelia app.example.test "" "$h"; then bad "FILES_HOST '$h' refused"; else ok "FILES_HOST '$h' refused"; fi
done

echo; echo "passed=$PASS failed=$FAILN"
[ "$FAILN" = 0 ]
