# syntax=docker/dockerfile:1
FROM golang:1.25-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59 AS build
WORKDIR /src
COPY src/ ./
RUN go vet ./... && go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /vpn-control .

FROM alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f
# wireguard-tools: `wg`; iproute2: `ip`; nftables: the kill switch. Needs kernel WireGuard (Linux >= 5.6).
RUN apk add --no-cache wireguard-tools iproute2 nftables ca-certificates
COPY --from=build /vpn-control /usr/local/bin/vpn-control
EXPOSE 8000
HEALTHCHECK --interval=5s --timeout=5s --start-period=5s --retries=3 CMD ["/usr/local/bin/vpn-control", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/vpn-control"]
