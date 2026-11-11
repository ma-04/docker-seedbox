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

**Revoking links.** Local `/dl` links stop working as soon as the owning job is deleted or not completed, or its owner is disabled (the API checks this on every request after the signature). Cloudflare Worker (Drive proxy) links and S3 presigned links are stateless and cannot be revoked individually: rotate the signing key (`proxySigningKey`) or the S3 credentials, or wait for expiry, so keep `linkTtlSeconds` short. The Worker and `/dl` always answer with `Content-Disposition: attachment`, `nosniff` and a sandboxing CSP, and serve html/svg/xml/javascript as `application/octet-stream`, so uploaded files cannot run script on those origins.

**Request forgery.** Authorisation is decided per matched route (admin routes sit in a guarded plugin), not from the URL text, and raw paths with encoded separators/dots or a differently cased `/api` are rejected. All non-GET `/api` requests must carry `X-Requested-With: seedbox` (CSRF defence in depth on top of same-site cookies).

**Outbound requests (SSRF).** User-owned S3 destinations must use `https` and a public address: loopback, private, CGNAT, link-local, ULA, multicast, documentation/benchmark ranges, IPv4-translated/NAT64/6to4/Teredo forms embedding a non-public address, and bare service names are refused at create, update, test and link generation, and test errors shown to non-admins are reduced to a short category. That API-side check is a pre-flight only (it cannot bind the later connection, and rclone follows redirects), so the worker runs rclone for **user-owned** destinations through an in-process egress proxy that resolves every target itself, refuses it unless every address is public and the port is allowed (`EGRESS_ALLOWED_PORTS`, default 443/80), and connects to the vetted IP. This also covers redirects to internal addresses and DNS rebinding; the API's own S3 SDK calls vet the connect address the same way and never follow redirects. Residual gap: Go never proxies requests to `localhost`/loopback, so an S3 endpoint that redirects to loopback reaches only the worker container's own loopback (nothing but the token-protected proxy listens there). Admin-created shared destinations are trusted and connect directly: they may use private addresses and plain `http` (self-hosted MinIO), so only give admin to people you trust. Event streams, destination tests, job creation and destination creation are capped per user to limit abuse.

**Torrent sources.** Magnet links and `.torrent` files are never stored or handed to qBittorrent as submitted. A magnet containing whitespace/control characters or over 8 KiB is rejected and the rest is rebuilt from the infohash, a sanitised name and up to 50 filtered trackers (public-looking `http(s)/udp/ws(s)` hosts only; web seeds, `xs`, `as`, `x.pe` and everything else dropped); uploaded `.torrent` files are re-encoded the same way with the infohash unchanged. This closes a newline injection that made qBittorrent (which splits its `urls` field on newlines) add untracked torrents and fetch arbitrary URLs from inside its network namespace. Tracker hosts are checked without DNS, so a public name that resolves to an internal address is only stopped by the VPN sidecar firewall. **Torrents are deduplicated by infohash across all users**: a second user adding a torrent someone else already has may complete instantly, and trackers (including any passkey in a tracker URL) are merged into one shared source. Do not add private-tracker torrents on a shared instance; there is no per-user isolation setting.

**Logs.** The API logs method and path only: query strings (which carry `exp`/`sig` of signed download links), magnet links and `Authorization`/`Cookie`/`X-Gateway-Secret` headers are never written.

**Deleted data.** Removing a completed job deletes its files from a local destination (confined to the library folder, never while another job references the same folder). Removed S3 data is only deleted when the admin turns on `cleanup.deleteRemoteOnJobDelete`; Google Drive data is never deleted automatically.

**VPN kill switch.** With `vpn.mode=required`, the VPN sidecar firewalls all egress except loopback, the WireGuard interface, the WireGuard endpoint and the internal subnet; IPv6 is dropped. qBittorrent has no network of its own (it shares the sidecar's namespace), so when the tunnel is down its traffic is blocked rather than leaking. Run `./setup.sh doctor` and verify your public IP from inside the namespace after configuring a VPN.

**Docker socket.** The app stack never mounts it. The optional bundled proxy mode (`compose.proxy-bundled.yaml`) mounts it into nginx-proxy and acme-companion (with `:ro`, which only prevents replacing the socket file; it does not restrict what the Docker API allows). Access to the socket is effectively root on the host, so use `external` or `none` mode if you do not accept that.

**Out of scope / your responsibility:** host hardening, TLS/DNS at your edge proxy, who you give accounts to (any logged-in user can add torrents and consume disk and bandwidth within the configured limits), and the legality of downloaded content.
