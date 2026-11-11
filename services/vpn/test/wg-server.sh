#!/bin/sh
# Test WireGuard server. env: WG_PRIVATE, PEER_PUBLIC, TUN_NET (e.g. 10.99.1)
set -eu
ip link add wg0 type wireguard
echo "$WG_PRIVATE" > /tmp/key
wg set wg0 private-key /tmp/key listen-port 51820 peer "$PEER_PUBLIC" allowed-ips "$TUN_NET.2/32"
rm -f /tmp/key
ip addr add "$TUN_NET.1/24" dev wg0
ip link set wg0 up
iptables -t nat -A POSTROUTING -s "$TUN_NET.0/24" ! -o wg0 -j MASQUERADE
echo "wg server up on $TUN_NET.1"
exec sleep infinity
