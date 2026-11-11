#!/bin/sh
# usage: ctl.sh METHOD PATH [token]   (JSON body on stdin for POST). Prints body, then "HTTP <code>".
T="${3-$VPN_CONTROL_TOKEN}"
# Only POST reads a body: `--data-binary @-` makes curl read stdin to EOF before the request, outside its -m limit,
# so a GET under `docker compose exec -T` with a stdin that never closes would hang the whole run.
if [ "$1" = POST ] && [ ! -t 0 ]; then D="--data-binary @-"; else D=""; fi
exec curl -sS -m 60 -w '\nHTTP %{http_code}\n' -X "$1" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' $D "http://vpn:8000$2"
