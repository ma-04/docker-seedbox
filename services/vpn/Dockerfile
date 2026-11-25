# syntax=docker/dockerfile:1
FROM golang:1.27-alpine@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280 AS build
WORKDIR /src
COPY src/ ./
RUN go vet ./... && go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /vpn-control .

FROM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
# wireguard-tools: `wg`; iproute2: `ip`; nftables: the kill switch. Needs kernel WireGuard (Linux >= 5.6).
RUN apk add --no-cache wireguard-tools iproute2 nftables ca-certificates
COPY --from=build /vpn-control /usr/local/bin/vpn-control
EXPOSE 8000
HEALTHCHECK --interval=5s --timeout=5s --start-period=5s --retries=3 CMD ["/usr/local/bin/vpn-control", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/vpn-control"]
