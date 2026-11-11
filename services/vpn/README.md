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
  healthcheck). In `required` mode the OUTPUT policy is `drop`; only the `lo` device, `wg*` interfaces and the UDP
  endpoint of the tunnel being brought up/currently up are accepted. In **both** modes (so `off` is no way around
  it) every uid, root included (there is no uid exemption), is dropped towards `LAN_CIDRS` (only replies to
  connections the api/worker opened are accepted) and towards every private / loopback-adjacent / link-local / CGNAT /
  multicast / reserved IPv4 range (`10/8`, `172.16/12` (so every other Docker bridge and the host at `172.17.0.1`),
  `192.168/16`, `100.64/10`, `169.254/16` (cloud metadata), `127/8` off the `lo` device, `224/4`, `240/4`, ...),
  on every interface except `lo`. Through `wg*` these destinations are dropped as well, **except the tunnel's DNS
  servers on port 53**: the VPN provider's DNS is usually a private address (`10.2.0.1`) and DNS must keep working,
  but nothing else of the provider's internal network can be probed (the safer of the two options; a provider that
  needs another private address, e.g. for port forwarding, is not supported). All IPv6 off `lo` is dropped in both
  modes; the sidecar also disables it via sysctl. Nothing is allowed because of connection state except those LAN
  replies, so a connection opened in `off` mode does not survive the switch to `required`. RFC 5737 documentation
  ranges are not blocked (the hermetic test stacks use them as their fake internet).
* **Docker's embedded resolver** (`127.0.0.11`, reached over the `lo` device, so it needs no LAN rule) is usable by
  uid 0 only in `required` mode, i.e. by this process, solely to resolve a WireGuard *endpoint hostname*
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
* **MTU** — config `MTU =` > `VPN_MTU` > 1280 (see the table below for why). The ruleset also clamps TCP MSS on `wg*` (`tcp option maxseg size set rt mtu`, postrouting chain, accept policy: it never opens anything the kill-switch output chain drops).
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
  `VPN_DEFAULT_MODE`, which is **`required`** (fail closed until `/connect`) unless explicitly set to `off`:
  after a host or container restart qBittorrent resumes its torrents immediately, long before the worker has
  re-applied the admin's setting, so an open default would leak the real IP. `POST /mode` with the mode the
  sidecar already has is a no-op (it never touches a live tunnel or the firewall); the worker applies `vpn.mode`
  at startup and only calls it when the reported mode differs.
* Input from the tunnel to `:8000`/`:8080` is dropped in every mode, so other customers of the VPN
  provider cannot reach the control API or WebUI via the tunnel address.
* Config contents live only in the process memory. Logs contain only `connect "<name>" ok|failed`.
  The control API on `:8000` is also reachable on loopback by qBittorrent, but it needs the bearer token,
  which qBittorrent never has.

## Environment

| Var | Default | Meaning |
|---|---|---|
| `VPN_CONTROL_TOKEN` | required | Bearer token for `:8000` |
| `LAN_CIDRS` | `172.31.250.0/24` | comma-separated; the compose subnet. Towards it only replies and the sidecar's own (uid 0) traffic may leave, in every mode; nothing qBittorrent starts. Input from it reaches only the WebUI/control ports |
| `CONTROL_TRUSTED_IPS` | empty | comma-separated IPv4 addresses that may reach the control port; empty = any address in `LAN_CIDRS` (the token is still required). Compose: `API_IP,WORKER_IP` |
| `VPN_LAN_ALLOW_OUT` | empty | **test fixtures only, never set it for real:** comma-separated `IPv4[:port]` LAN addresses that qBittorrent may open connections to (and that may connect in). Used by `deploy/compose.e2e.yaml` and `test/compose.yaml` |
| `VPN_MTU` | `1280` | wg interface MTU (576-1500); a config `MTU =` line overrides it. 1280 survives uplinks whose real MTU the Docker bridge hides (cloud 1460, PPPoE 1492); lower it if bulk transfers stall only with the VPN on. `GET /status` reports the effective `mtu` |
| `VPN_DEFAULT_MODE` | `required` | `required` (fail closed) or `off` right after (re)start |
| `PUBLIC_IP_URL` | `https://api.ipify.org` | plain-text IP service, fetched through the tunnel; empty disables |
| `VPN_FALLBACK_DNS` | `1.1.1.1` | resolver used when the config has no IPv4 `DNS =` |
| `HANDSHAKE_TIMEOUT_SEC` | `20` | how long `/connect` waits for a handshake |
| `WEBUI_PORT` | `8080` | qBittorrent WebUI port (dropped from tunnel side) |
| `CONTROL_ADDR` | `:8000` | listen address |

## Compose blocks

The kernel must have WireGuard (Linux 5.6+ or the module); no `/dev/net/tun`, no host sysctls, no
host configuration beyond this. **The compose network must have the fixed subnet `LAN_CIDRS`
and `vpn` should keep a static address in it** (here `.2`), since the kill switch's LAN rules are written for exactly
that subnet, and `api`/`worker` (static addresses, passed as `CONTROL_TRUSTED_IPS`) reach the control API and WebUI at `vpn:8000` / `vpn:8080`.

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
    cap_drop: [ALL]
    cap_add: [NET_ADMIN]              # the only capability the sidecar keeps (kernel WireGuard + nftables)
    sysctls:
      net.ipv6.conf.all.disable_ipv6: "1"
    environment:
      VPN_CONTROL_TOKEN: ${VPN_CONTROL_TOKEN:?set VPN_CONTROL_TOKEN}
      LAN_CIDRS: ${LAN_CIDRS:-172.31.250.0/24}
      CONTROL_TRUSTED_IPS: ${API_IP:-172.31.250.3},${WORKER_IP:-172.31.250.4}   # only api and worker may reach :8000
      VPN_MTU: ${VPN_MTU:-}
      VPN_DEFAULT_MODE: ${VPN_DEFAULT_MODE:-required}   # fail closed after restarts until the worker applies vpn.mode
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
    read_only: true                   # the entrypoint cannot be replaced; qBittorrent writes /config, incomplete/ and /tmp
    tmpfs: [/tmp]
    cap_drop: [ALL]
    cap_add: [CHOWN, SETUID, SETGID, KILL]   # root only chowns /config (top dir) and drops to uid 1000; KILL: tini -> SIGTERM
    volumes:
      - qbt-config:/config
      - type: volume                  # only incomplete/ of the downloads volume (never library/)
        source: downloads
        target: /downloads/incomplete
        volume: { subpath: incomplete }   # Docker Engine 26+ / Compose 2.26+; the subfolder must exist (init service)
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
* `qbittorrent` keeps only `CHOWN` (the `/config` top directory), `SETUID`/`SETGID` (drop to uid 1000) and `KILL` (tini forwards SIGTERM); no `DAC_OVERRIDE`/`FOWNER`, never `privileged`. Its root filesystem is read-only, and everything under `/config` is written as uid 1000 (`services/qbittorrent/conf-edit.sh`), never by root.

## Control API

`Authorization: Bearer $VPN_CONTROL_TOKEN` on every request (401 otherwise).

```
GET  /status      -> { mode, connected, name, publicIp, lastHandshakeSec, since, mtu }
POST /connect     { name, config }     raw wg-quick text; 400 invalid/forbidden, 409 mode is off, 502 no handshake
POST /disconnect
POST /mode        { mode: "off" | "required" }
```

`/connect`, `/disconnect` and `/mode` return the new status. `/connect` is refused with 409 while the mode is `off` (no tunnel is wanted then, and a connect racing
an admin's switch to off must not win). Error bodies carry fixed messages only: command output never reaches an HTTP body, and `wg`'s output, which can echo configuration, stays out of the logs too (`ip`/`nft` failures are logged in full).
`/mode off` also tears the tunnel down;
`/mode` with the current mode changes nothing. If swapping the routes to a new tunnel fails midway, the
routes already moved are restored so the old tunnel keeps working.

## Tests

`test/run.sh` builds both images and a hermetic stack (two WireGuard servers on a stand-in
"internet" network, echo services, a LAN client and an untrusted "intruder" sibling, both with listeners; keys generated per run) and asserts the
kill switch, the LAN policy in `off` and `required` mode (uid 1000 cannot reach the bridge gateway or a sibling, root can, the
allow-listed `ip:port` works and its neighbour port does not, the intruder cannot reach the control API or a listener in the namespace),
409 on `/connect` in off mode, CR-in-key rejection, that a whitelisted qBittorrent setting changed over the WebUI survives a restart
while autorun is forced off again, that qBittorrent sees only `incomplete/`, rotation without a single direct packet, auth and hostile configs, log hygiene and
restart behaviour. `go test ./...` in `src/` covers the generated ruleset, the 409, key validation and error hygiene. Requires Docker with Compose 2.33+ (for `gw_priority`) and NET_ADMIN.
It removes everything it created on exit (`--keep` to inspect).

```
services/vpn/test/run.sh
```
