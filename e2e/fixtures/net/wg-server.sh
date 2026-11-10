#!/bin/sh
# Test WireGuard server. env: NAME (wg1), TUN_NET (10.99.1), ENDPOINT_IP, KEYS_DIR (shared fixtures volume).
# Generates fresh keys at start and publishes a ready-made *client* config at $KEYS_DIR/wg/$NAME.conf.
set -eu
umask 022
ip link add wg0 type wireguard
S_PRIV=$(wg genkey); S_PUB=$(printf '%s' "$S_PRIV" | wg pubkey)
C_PRIV=$(wg genkey); C_PUB=$(printf '%s' "$C_PRIV" | wg pubkey)
printf '%s' "$S_PRIV" > /tmp/key
wg set wg0 private-key /tmp/key listen-port 51820 peer "$C_PUB" allowed-ips "$TUN_NET.2/32"
rm -f /tmp/key
ip addr add "$TUN_NET.1/24" dev wg0
ip link set wg0 up
iptables -t nat -A POSTROUTING -s "$TUN_NET.0/24" ! -o wg0 -j MASQUERADE
mkdir -p "$KEYS_DIR/wg"
cat > "$KEYS_DIR/wg/$NAME.conf.tmp" <<CONF
[Interface]
PrivateKey = $C_PRIV
Address = $TUN_NET.2/32
DNS = $TUN_NET.1

[Peer]
PublicKey = $S_PUB
AllowedIPs = 0.0.0.0/0
Endpoint = $ENDPOINT_IP:51820
CONF
mv "$KEYS_DIR/wg/$NAME.conf.tmp" "$KEYS_DIR/wg/$NAME.conf"
echo "wg server $NAME up on $TUN_NET.1 (endpoint $ENDPOINT_IP:51820)"
exec sleep infinity
