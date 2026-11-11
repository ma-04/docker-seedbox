#!/bin/sh
# Tiny "whatismyip" service: replies "<ECHO_NAME> <client address>" to any request.
if [ "${1:-}" = handle ]; then
  printf 'HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\n\r\n%s %s\n' "$ECHO_NAME" "$SOCAT_PEERADDR"
  exit 0
fi
exec socat TCP4-LISTEN:80,fork,reuseaddr EXEC:"/echo.sh handle"
