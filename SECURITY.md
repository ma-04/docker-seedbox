# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: **Security -> Report a vulnerability** on this repository (private vulnerability reporting). Do not open a public issue. Include the version or commit, a description, and reproduction steps. We aim to acknowledge reports within a few days and will credit you in the fix unless you prefer otherwise.

Supported: the latest release and `main`.

## Threat model (summary)

**Trust boundary: header authentication.** The API trusts `Remote-User`, `Remote-Groups`, `Remote-Email` and `Remote-Name`, but only on requests that carry the correct `X-Gateway-Secret`. The gateway:

- strips client-supplied `Remote-*` and `X-Gateway-Secret` and sets its own, so a client cannot impersonate a user;
- with `AUTH_MODE=authelia`, sends every request except `/api/health` through Authelia (`auth_request`);
- with `AUTH_MODE=external`, passes `Remote-*` through unchanged. **Then the gateway must be reachable only from your SSO proxy.** Anything that can reach the gateway directly can claim any identity, including admin.

Nothing but the gateway is exposed. `api`, `worker`, `web`, `authelia`, `vpn` and `qbittorrent` have no published ports and live on one internal Docker network. The qBittorrent WebUI is never routed by the gateway.

**Secrets at rest.** Destination credentials, torrent sources and VPN configs are stored AES-256-GCM encrypted in SQLite with a key derived from `APP_SECRET`; the API never returns them (it returns `********`). Losing `APP_SECRET` means losing those values; leaking it together with a copy of the database exposes them. `deploy/.env` is created with mode 600 and must be backed up and kept private. VPN configs are held in memory/tmpfs by the VPN sidecar.

**Signed links.** Local and Cloudflare Worker links are `HMAC-SHA256(key, path + "\n" + exp)` with constant-time verification and optional expiry. The files host serves only `GET/HEAD /dl/...`, never lists directories, serves files with a sandboxing `Content-Security-Policy`, and gateway access logs for it omit query strings (where signatures travel). Anyone holding a link can download until it expires.

**VPN kill switch.** With `vpn.mode=required`, the VPN sidecar firewalls all egress except loopback, the WireGuard interface, the WireGuard endpoint and the internal subnet; IPv6 is dropped. qBittorrent has no network of its own (it shares the sidecar's namespace), so when the tunnel is down its traffic is blocked rather than leaking. Run `./setup.sh doctor` and verify your public IP from inside the namespace after configuring a VPN.

**Docker socket.** The app stack never mounts it. The optional bundled proxy mode (`compose.proxy-bundled.yaml`) mounts it into nginx-proxy and acme-companion (with `:ro`, which only prevents replacing the socket file; it does not restrict what the Docker API allows). Access to the socket is effectively root on the host, so use `external` or `none` mode if you do not accept that.

**Out of scope / your responsibility:** host hardening, TLS/DNS at your edge proxy, who you give accounts to (any logged-in user can add torrents and consume disk and bandwidth within the configured limits), and the legality of downloaded content.
