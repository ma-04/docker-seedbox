#!/bin/sh
# usage: ctl.sh METHOD PATH [token]   (JSON body on stdin for POST). Prints body, then "HTTP <code>".
T="${3-$VPN_CONTROL_TOKEN}"
if [ -t 0 ]; then D=""; else D="--data-binary @-"; fi
exec curl -sS -m 60 -w '\nHTTP %{http_code}\n' -X "$1" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' $D "http://vpn:8000$2"
