# services/vpn

WireGuard client, kill switch and control API for the torrent engine's network namespace.
`qbittorrent` runs with `network_mode: service:vpn`, so **only that namespace** is affected;
the host and every other container keep their normal network.

## Why not Gluetun

Gluetun (`qmcgaw/gluetun`) was evaluated first, in the real topology on a build host:

* Hot-swapping a custom WireGuard config works (`PUT /v1/vpn/settings` restarts the tunnel
  in ~0.15 s without restarting the process), the control server port is overridable
  (`HTTP_CONTROL_SERVER_ADDRESS`) and auth roles exist.
* But the custom provider accepts **IP-only endpoints**: a hostname returned
  `400` from `PUT /v1/vpn/settings` (upstream issue 2680), while admins upload ordinary configs that
  usually have hostnames. The shim would have to resolve them itself.
* After `PUT /v1/vpn/status {"status":"stopped"}` Gluetun leaves its `DROP` policies, its
  endpoint accept rule and its policy-routing rules in place, so a real `off` mode
  (open firewall, normal route) means tearing Gluetun's state down by hand; and it auto-allows
  every attached subnet, so the strict "only `LAN_CIDRS`" rule cannot be left to it.
* DNS is Gluetun's own unbound (DoT to Cloudflare by default; the `DNS =` line of the config is
  ignored), it downloads block lists, probes `1.1.1.1`/`8.8.8.8` for MTU, and queries
  third-party "what is my IP" APIs; none of that is configurable to `PUBLIC_IP_URL`.
  The image has no `wg` binary, tracks a rolling `latest`.

To meet the contract the shim would therefore still need its own independent kill switch, endpoint
resolution, `off`-mode teardown, DNS handling and handshake-based status, with Gluetun left only
bringing up one WireGuard interface, which is a handful of `ip`/`wg` calls. So this is a purpose-built
sidecar: Alpine + `wireguard-tools` + `iproute2` + `nftables` + a ~500-line static Go control server
(`src/`), no other dependencies.

## How it works

* **Kill switch** — one nftables table `inet sbvpn`, replaced atomically (single `nft -f`
  transaction), installed *before* the control API listens (and qBittorrent waits for the
  healthcheck). In `required` mode the OUTPUT policy is `drop`; only loopback, `LAN_CIDRS`,
  `wg*` interfaces and the UDP endpoint of the tunnel being brought up/currently up are accepted.
  IPv6 (except loopback) is dropped; the sidecar also disables it via sysctl. Nothing is
  allowed because of connection state, so a connection opened in `off` mode does not survive the
  switch to `required`.
* **Docker's embedded resolver** (`127.0.0.11`, which forwards from the host side) is usable by
  uid 0 only, i.e. by this process, solely to resolve a WireGuard *endpoint hostname*
  (that one lookup is the only thing that leaves the namespace outside the tunnel; use an IP
  endpoint to avoid it). qBittorrent (uid 1000) cannot use it.
* **Connecting** — the config is parsed and whitelisted (`PrivateKey`, `Address`, `DNS`, `MTU`,
  `PublicKey`, `PresharedKey`, `AllowedIPs`, `Endpoint`, `PersistentKeepalive`); hook keys
  (`PreUp/PostUp/PreDown/PostDown/SaveConfig`) are rejected with 400 and nothing from the
  file is ever executed (`wg`/`ip` are called with argv built from validated values, no shell). The key is
  passed to `wg setconf` over stdin: never on disk, never in argv, never logged. IPv6 `Address`,
  `DNS` and `AllowedIPs` entries (e.g. `::/0`) are stripped.
* **Rotation is make-before-break**: the new interface (`wg0`/`wg1` alternate) is created and
  its handshake awaited (`HANDSHAKE_TIMEOUT_SEC`, default 20) while the old tunnel keeps carrying
  traffic; then the routes are swung with `ip route replace` and the old interface removed. The
  kill switch is never open during the switch. On handshake failure the new interface is removed,
  the old tunnel stays, and `/connect` answers `502`.
* **Routing** — like `wg-quick`: `0.0.0.0/0` becomes `0.0.0.0/1` + `128.0.0.0/1` on the wg
  interface; the endpoint and `LAN_CIDRS` keep the original gateway. qBittorrent is not bound to
  an interface name; it uses whichever route is default.
* **DNS** — while a tunnel is up `/etc/resolv.conf` (shared with `qbittorrent`, rewritten
  in place) holds the config's `DNS =` servers (else `VPN_FALLBACK_DNS`, default `1.1.1.1`, still
  through the tunnel). In `required` mode with no tunnel it has no nameserver at all. In `off` mode, Docker's
  resolver is restored. A stale file from an earlier run is healed at start.
* **`connected`** means: the interface exists and the last handshake is at most 180 s old.
  `lastHandshakeSec` is the handshake age. `publicIp` is fetched from `PUBLIC_IP_URL` through the
  tunnel in the background (first IPv4 found in the body) and is `null` when it fails.
* **Modes** — `required` (above) or `off` (OUTPUT policy accept, tunnel torn down, normal route).
  Neither mode nor the last config survives a container restart; the default after start is
  `VPN_DEFAULT_MODE` (`off` unless set to `required`, which fails closed until `/connect`).
* Input from the tunnel to `:8000`/`:8080` is dropped in every mode, so other customers of the VPN
  provider cannot reach the control API or WebUI via the tunnel address.
* Config contents live only in the process memory. Logs contain only `connect "<name>" ok|failed`.
  The control API on `:8000` is also reachable on loopback by qBittorrent, but it needs the bearer token,
  which qBittorrent never has.

## Environment

| Var | Default | Meaning |
|---|---|---|
| `VPN_CONTROL_TOKEN` | required | Bearer token for `:8000` |
| `LAN_CIDRS` | `172.31.250.0/24` | comma-separated; reachable in every mode and state (must contain the compose subnet) |
| `VPN_DEFAULT_MODE` | `off` | `off` or `required` right after (re)start |
| `PUBLIC_IP_URL` | `https://api.ipify.org` | plain-text IP service, fetched through the tunnel; empty disables |
| `VPN_FALLBACK_DNS` | `1.1.1.1` | resolver used when the config has no IPv4 `DNS =` |
| `HANDSHAKE_TIMEOUT_SEC` | `20` | how long `/connect` waits for a handshake |
| `WEBUI_PORT` | `8080` | qBittorrent WebUI port (dropped from tunnel side) |
| `CONTROL_ADDR` | `:8000` | listen address |

## Compose blocks

The kernel must have WireGuard (Linux 5.6+ or the module); no `/dev/net/tun`, no host sysctls, no
host configuration beyond this. **The compose network must have the fixed subnet `LAN_CIDRS`
and `vpn` should keep a static address in it** (here `.2`), since the kill switch allows exactly
that subnet, and `api`/`worker` reach the control API and WebUI at `vpn:8000` / `vpn:8080`.

```yaml
networks:
  default:
    ipam:
      config:
        - subnet: ${LAN_CIDRS:-172.31.250.0/24}     # must equal LAN_CIDRS

volumes:
  qbt-config:
  downloads:

services:
  vpn:
    build: ../services/vpn            # or image: ghcr.io/<owner>/docker-seedbox-vpn
    restart: unless-stopped
    cap_add: [NET_ADMIN]              # the only privilege needed
    sysctls:
      net.ipv6.conf.all.disable_ipv6: "1"
    environment:
      VPN_CONTROL_TOKEN: ${VPN_CONTROL_TOKEN:?set VPN_CONTROL_TOKEN}
      LAN_CIDRS: ${LAN_CIDRS:-172.31.250.0/24}
      VPN_DEFAULT_MODE: ${VPN_DEFAULT_MODE:-off}   # "required" = fail closed after restarts
      # PUBLIC_IP_URL: https://api.ipify.org
    tmpfs: [/tmp]                     # (not read_only: /etc/resolv.conf must stay writable)
    networks:
      default:
        ipv4_address: 172.31.250.2    # keep inside LAN_CIDRS (change together with it)
    healthcheck:                      # built into the image; shown for completeness
      test: ["CMD", "/usr/local/bin/vpn-control", "healthcheck"]
      interval: 5s
      timeout: 5s
      retries: 3

  qbittorrent:
    build: ../services/qbittorrent    # or image: ghcr.io/<owner>/docker-seedbox-qbittorrent
    restart: unless-stopped
    network_mode: service:vpn         # shares the vpn namespace (and its kill switch)
    environment:
      LAN_CIDRS: ${LAN_CIDRS:-172.31.250.0/24}
    volumes:
      - qbt-config:/config
      - downloads:/downloads
    depends_on:
      vpn:
        condition: service_healthy
        restart: true                 # re-attach to the new namespace when vpn is recreated
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS -o /dev/null http://127.0.0.1:8080/api/v2/app/version"]
      interval: 10s
      timeout: 5s
      retries: 5
```

Notes for the compose file as a whole:

* `qbittorrent` has no `networks:` and no `ports:`; `api`/`worker` use `QBT_URL=http://vpn:8080`
  and `VPN_URL=http://vpn:8000`.
* `restart: true` matters: a container using `network_mode: service:vpn` keeps pointing at the
  *old* namespace when `vpn` is recreated. The old namespace stays fail-closed, but `qbittorrent` is
  cut off from the LAN until it is restarted. `docker compose up -d` / `restart` handle this;
  a bare Docker restart-policy crash restart of `vpn` does not, so the worker should treat an
  unreachable `qbittorrent` as "restart me".
* Do not add `cap_add`/`privileged` to `qbittorrent`; it needs none.

## Control API

`Authorization: Bearer $VPN_CONTROL_TOKEN` on every request (401 otherwise).

```
GET  /status      -> { mode, connected, name, publicIp, lastHandshakeSec, since }
POST /connect     { name, config }     raw wg-quick text; 400 invalid/forbidden, 502 no handshake
POST /disconnect
POST /mode        { mode: "off" | "required" }
```

`/connect`, `/disconnect` and `/mode` return the new status. `/mode off` also tears the tunnel down.

## Tests

`test/run.sh` builds both images and a hermetic stack (two WireGuard servers on a stand-in
"internet" network, echo services, a LAN client; keys generated per run) and asserts the
kill switch, rotation without a single direct packet, auth and hostile configs, log hygiene and
restart behaviour. Requires Docker with Compose 2.33+ (for `gw_priority`) and NET_ADMIN.
It removes everything it created on exit (`--keep` to inspect).

```
services/vpn/test/run.sh
```
