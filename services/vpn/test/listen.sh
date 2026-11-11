#!/bin/sh
# Test listeners: one tiny TCP service per port in $LISTEN_PORTS (answers "<name>-<port>"), then sleeps.
# They are the positive controls of the LAN-policy checks: a connection that times out is only meaningful
# if the same service answers when the firewall allows it.
if [ "${1:-}" = reply ]; then
  printf 'HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\n\r\n%s-%s\n' "$LISTEN_NAME" "$2"
  exit 0
fi
for p in $LISTEN_PORTS; do
  socat TCP4-LISTEN:"$p",fork,reuseaddr EXEC:"/t/listen.sh reply $p" &
done
exec sleep infinity
