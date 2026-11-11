# Test-only helper image: WireGuard "server" fixtures and "what is my address" echo services.
FROM alpine:3.20
RUN apk add --no-cache wireguard-tools iptables curl jq socat iproute2
COPY wg-server.sh echo.sh /
RUN chmod 755 /wg-server.sh /echo.sh
