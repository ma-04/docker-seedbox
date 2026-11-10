# Architecture

docker-seedbox downloads torrents (through an optional rotating WireGuard VPN) and
delivers the result to a **Destination**: Google Drive, S3-compatible storage, or a
local folder. Users get download links; admins configure everything from the web UI.

This file is the contract between components. Change it before changing an interface.

## Containers (`deploy/compose.yaml`)

| Service | Image / source | Role | Published ports |
|---|---|---|---|
| `gateway` | `services/gateway` (nginx) | Only entrypoint. Routes hosts/paths, enforces auth via `auth_request`, serves local-folder downloads through `X-Accel-Redirect`. | none (joined to outer proxy network) or `80` standalone |
| `authelia` | `authelia/authelia` | Login, sessions, 2FA, groups. | none |
| `web` | `apps/web` (static nginx) | React SPA. | none |
| `api` | `apps/api` (`node dist/api.js`) | REST API, OAuth, link signing. | none |
| `worker` | `apps/api` (`node dist/worker.js`) | Job state machine: drives qBittorrent, runs rclone uploads, VPN rotation. | none |
| `vpn` | `services/vpn` | WireGuard client + kill switch + control API. Owns the network namespace used by `qbittorrent`. | none |
| `qbittorrent` | `qbittorrentofficial/qbittorrent-nox` | Torrent engine, `network_mode: service:vpn`. | none |
| `apps/drive-proxy` | Cloudflare Worker (not in compose) | Signed-URL download proxy for the shared Google Drive. | — |

Volumes: `data` (SQLite, api+worker), `downloads` (qbittorrent+worker+api rw, gateway ro; the api only writes a probe file for the local-destination test),
`authelia`, `qbt-config`. No container mounts the Docker socket. Nothing but `gateway`
is reachable from outside the compose network.

TLS is terminated by an outer proxy (nginx-proxy + acme-companion in `deploy/proxy/`,
or any existing proxy). `gateway` exposes `VIRTUAL_HOST`/`LETSENCRYPT_HOST` env for that.

Hosts: `APP_HOST` (SPA + `/api`), `AUTH_HOST` (Authelia portal), `FILES_HOST`
(local-folder downloads, no login, signed URLs only).

## Stack

TypeScript everywhere (ESM), Node 22, npm workspaces (`apps/*`, `e2e`). API: Fastify + better-sqlite3 (WAL,
SQL migrations in `apps/api/migrations/NNN_name.sql`) + zod. Web: React 18 + Vite +
Tailwind + TanStack Query + react-router. Tests: vitest (unit), Playwright (`e2e/`).
Uploads: the `rclone` binary inside the api image, configured only through
`RCLONE_CONFIG_*` environment variables (never a config file on disk).

## Auth

`AUTH_MODE=authelia` (default): gateway does `auth_request` to Authelia
(`/api/authz/auth-request`) for everything on `APP_HOST` and forwards
`Remote-User`, `Remote-Email`, `Remote-Name`, `Remote-Groups`.
`AUTH_MODE=external`: gateway skips Authelia and forwards the same four headers as
received from the operator's own SSO proxy.

The gateway always strips client-supplied `Remote-*` and `X-Gateway-Secret` headers
(in `authelia` mode) and adds `X-Gateway-Secret: $GATEWAY_SECRET`. The API rejects
any request without the correct secret (401) — this is what makes header auth safe.
Users are auto-provisioned on first request, keyed by `Remote-User`. Admin =
member of group `ADMIN_GROUP` (default `admins`).

Routes that need no login: `GET /api/health` and `GET /dl/*` (on `FILES_HOST`, signed
URL only; the gateway still adds `X-Gateway-Secret`). Every other route, including
`GET /api/oauth/google/callback`, requires the user headers.

**Authorisation follows the matched route, never the URL string.** `apps/api/src/api/app.ts`
registers authenticated routes in an encapsulated plugin whose `onRequest` hook is `requireUser`,
and admin routes in a child plugin that adds `requireAdmin`; only `/api/health` and `/dl/*` live
outside. Unmatched URLs 404 without touching user state. Every route carries `config.guard`
(`public|user|admin`) and `app.routeTable` lists them; `security.test.ts` fails if a route exists
outside a guarded plugin or an `admin` URL is not in the admin plugin. New admin routes must be
registered from `registerAdmin*` inside that plugin. Root hooks additionally reject (400) raw paths
containing `%2f`, `%5c`, `%2e`, `%00`, empty or `.`/`..` segments, or an `/api` prefix that
differs in case.

CSRF: every non-GET/HEAD `/api/*` request (JSON and multipart) must carry
`X-Requested-With: seedbox` or the API answers 403 `csrf`. The SPA's fetch wrapper adds it.

Outbound destinations (SSRF): `apps/api/src/lib/netguard.ts` exports
`assertPublicEndpoint(url, { allowPrivate })`. For user-owned destinations the S3 `endpoint` and
`publicBaseUrl` must be `https:`, carry no credentials, not be a bare single-label host, and every
address the name resolves to must be public (not loopback, RFC 1918, CGNAT, link-local, ULA,
unspecified, multicast, or IPv4-mapped forms). It is enforced on create, update, `test` and when
building file links. Admin-created (shared) destinations may use `http:` and private addresses
(e.g. a MinIO container) but still no credentials in the URL. `publicBaseUrl`/`proxyBaseUrl` are
`http(s)` only everywhere. The worker must call `assertPublicEndpoint` again right before uploading
for user-owned destinations (DNS rebinding: a check here cannot bind the later connection).
`POST .../test` returns only a short category (`unreachable`, `auth failed`, `bucket not found`,
`tls error`, `timeout`) to non-admins; admins see the detailed message.

Limits: `GET /api/events` allows `SSE_MAX_PER_USER` (default 5; the oldest is closed) streams per
user and `SSE_MAX_TOTAL` (default 200, then 503); one shared poller feeds all streams and closes
the streams of users who become disabled. Per-user token buckets (429 + `Retry-After`): destination
test 10/min, job create 30/min, destination create 20/min.

## Domain model (SQLite)

Authoritative schema: `apps/api/migrations/001_init.sql`. Timestamps are unix seconds.

- `users(id, username UNIQUE, email, display_name, is_admin, disabled, max_active_jobs NULL, created_at, last_seen_at)`
- `destinations(id, owner_user_id NULL, name, type, config_enc, enabled, is_default, created_at)` —
  `owner_user_id NULL` = shared (admin-managed, visible to all); otherwise private to that user.
- `torrents(id, infohash UNIQUE, name, source_enc, total_size, state, progress, dl_speed, save_path, error, added_at, completed_at, library_path, cleanup_pending, started_at)` —
  one row per infohash; many jobs may reference it (two users adding the same torrent share one download).
  `library_path` (migration 003): where a completed local job moved the data (later jobs copy from there);
  `cleanup_pending`: the worker still has to remove a failed torrent and its data; `started_at`: when it was first
  handed to the downloader (metadata timeout).
- `jobs(id, user_id, torrent_id, destination_id, state, upload_progress, upload_speed, remote_path, folder_url, error, created_at, updated_at, completed_at)`
- `job_files(id, job_id, path, size)` — relative paths, recorded when the upload finishes.
- `vpn_configs(id, name UNIQUE, config_enc, endpoint_host, enabled, last_used_at, last_error, created_at)`
- `settings(key PRIMARY KEY, value_json)`
- `oauth_states(state PRIMARY KEY, user_id, payload_json, expires_at)`

Job states: `queued → downloading → uploading → completed`, plus `failed`, `cancelled`.
Torrent states: `pending → downloading → downloaded`, plus `error`, `removed`.

`*_enc` columns are AES-256-GCM (`v1:<iv b64>:<tag b64>:<ciphertext b64>`), key =
HKDF-SHA256(`APP_SECRET`). The API never returns secret fields; it returns
`"********"` and treats that value on update as "unchanged".

### Destination config (decrypted JSON)

```ts
type GDriveConfig = { type: 'gdrive'; clientId: string; clientSecret: string;
  refreshToken: string; rootFolderId: string;
  sharing: 'none' | 'anyone' | 'user';      // how the per-user folder is shared (shared mode only)
  proxyBaseUrl?: string;                    // e.g. https://drive.example.com (Cloudflare Worker)
  proxySigningKey?: string; linkTtlSeconds?: number /* 0 = never expires */ };
type S3Config = { type: 's3'; endpoint: string; region: string; accessKeyId: string;
  secretAccessKey: string; bucket: string; prefix?: string; forcePathStyle?: boolean;
  publicBaseUrl?: string;                   // if set links are `${publicBaseUrl}/${key}`, else presigned
  linkTtlSeconds?: number };
type LocalConfig = { type: 'local'; subdir?: string;
  publicBaseUrl?: string;                   // default `https://${FILES_HOST}`; admin-editable
  linkTtlSeconds?: number };
```

Remote layout for every destination: `<prefix>/<userDir>/<jobDir>/...` for shared destinations,
`<prefix>/<jobDir>/...` for user-owned ones (`jobs.remote_path` stores `<userDir>/<jobDir>` or `<jobDir>`;
`job_files.path` is relative to it).

- `jobDir` = `<torrentName> [<first 8 hex of the infohash>]`, so two different torrents with the same name never
  merge or overwrite each other. `torrentName` is sanitised by `safeSegment`: separators and control characters →
  `_`, leading dots → `_`, trailing dots/spaces removed, truncated by UTF-8 bytes on a code-point boundary so that
  the whole `jobDir` is at most 180 bytes (filesystems cap names at 255 bytes; CJK/emoji names used to overflow).
- `userDir` = `<userSlug>-<userId>` where `userSlug` = `username` lowercased, `[^a-z0-9._-]` → `_`, at most 64
  chars. The slug alone collides (`Bob`/`bob`, `a b`/`a_b`), the id makes the directory unique.
- Example: user `Alice B` (id 12), torrent `Big Buck Bunny`, infohash `abcdef01…` on a shared destination →
  `alice_b-12/Big Buck Bunny [abcdef01]/video.mp4`.
- Local destination root is `/downloads/library` inside the containers.
- `jobRemoteDir(dest, user, infohash, torrentName)` in `apps/api/src/lib/destinations.ts` is the only place that
  builds it; the API never recomputes it (it reads `jobs.remote_path`).
- Google Drive: the worker creates/resolves `<userDir>` and `<jobDir>` itself (in-process mutex per
  destination+user, deterministic oldest-first match when duplicates exist) and points rclone at the job folder
  (`root_folder_id=<job folder id>`, target `DST:`), so rclone never creates parent folders.

### Links

- gdrive, shared, with proxy: `${proxyBaseUrl}/<urlencoded path>?exp=<unix>&sig=<hex>` (path = `<userDir>/<jobDir>/<file>`).
  The API also returns the per-user Drive folder URL when `sharing != 'none'`.
- gdrive, user-owned: Drive `webViewLink` of the uploaded folder.
- s3: `publicBaseUrl` join, else a presigned GET.
- local: `${publicBaseUrl}/dl/<urlencoded path>?exp=&sig=` → api verifies → requires a completed
  job (owner not disabled) whose `remote_path` + `job_files.path` covers the path, else 404 →
  `X-Accel-Redirect: /_protected/<path>` → gateway serves from the `downloads` volume. Responses
  always carry `Content-Disposition: attachment`, `nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`.

**Signature (shared by api, worker and drive-proxy):**
`sig = hex(HMAC-SHA256(key, path + "\n" + exp))` where `path` is the *decoded* path
with a leading `/` and no `..` segments, `exp` is unix seconds as a decimal string,
`"0"` = never. Verification is constant-time; expired → 410, bad sig → 403.
Local links use key `HKDF(APP_SECRET, "local-links")`. URL paths are built with
`encodeURIComponent` per segment.

Test vectors (key `test-signing-key`) — every implementation must have a unit test for these:

| path | exp | sig |
|---|---|---|
| `/alice/Big Buck Bunny/video.mp4` | `1900000000` | `88fb761b1385669729ba3b8e81cf0a56d34c86b2612afb56a329cc2879293fe6` |
| `/bob/ünï cødé #1 100%/it's a file.txt` | `0` | `8836dcec3058dac1cca8afa96bb92c34eebab3390eeeb9fb11587d6d5cf3dd3c` |
| `/a/b.bin` | `1` (expired) | `d8e48a68228acd72c96b9a950ccf895a27a2c27117ae0c61629c99b29a915a0e` |

## API (all under `/api`, JSON, errors `{ error: { code, message } }`)

Wire types: `apps/api/src/lib/dto.ts` (authoritative; the web app imports it type-only).


```
GET    /health
GET    /me                                   -> { user, isAdmin, limits }
GET    /destinations                         -> shared (enabled) + own; secrets masked
POST   /destinations                         -> create own (s3 only; gdrive comes from OAuth)
PATCH  /destinations/:id   DELETE /destinations/:id      (own only)
POST   /destinations/:id/test                -> { ok, message }
GET    /oauth/google/start?name=             -> 302 to Google (scope drive.file, offline, consent)
GET    /oauth/google/callback                -> creates user-owned gdrive destination, 302 /storage
GET    /jobs?state=                          -> own jobs (with torrent progress)
POST   /jobs       JSON { magnet, destinationId } | multipart { torrent, destinationId }
GET    /jobs/:id   DELETE /jobs/:id (cancel+remove)   POST /jobs/:id/retry
GET    /jobs/:id/files                       -> [{ path, size, url }] + { folderUrl? }
GET    /events                               -> SSE: `job` events with the job JSON

GET|POST        /admin/destinations          PATCH|DELETE /admin/destinations/:id   POST .../:id/test
GET|POST        /admin/vpn/configs           (POST: { name, config } raw wg-quick text)
PATCH|DELETE    /admin/vpn/configs/:id
GET             /admin/vpn/status            -> vpn control `/status` + active config name
POST            /admin/vpn/rotate            { configId? }  (next enabled if omitted)
GET|PUT         /admin/settings
GET             /admin/users                 PATCH /admin/users/:id { disabled?, maxActiveJobs? }
GET             /admin/jobs                  DELETE /admin/jobs/:id
```

Settings keys (defaults): `vpn.mode` (`"off"` | `"required"`, default `"off"` until a
config exists), `vpn.rotation` (`"manual"` | `"interval"` | `"on-failure"`),
`vpn.rotationMinutes` (360), `limits.maxActiveJobsPerUser` (5),
`limits.maxTorrentBytes` (0 = unlimited), `limits.minFreeDiskBytes` (2 GiB),
`limits.metadataTimeoutMinutes` (30; 0 = never), `cleanup.failedGraceMinutes` (60),
`seeding.ratio` (0 = stop when complete), `seeding.maxMinutes` (0 = no cap; with `seeding.ratio` > 0, stop seeding after this long), `google.oauthClientId`,
`google.oauthClientSecret` (encrypted; used for user "Connect Google Drive").

Infohashes are stored lowercase hex (v1, 40 chars); base32 magnets are converted before
the UNIQUE check. A user re-adding a torrent they already have for the same
destination gets the existing job back (200), not a duplicate.

User-owned Google Drive: scope `drive.file` cannot see pre-existing folders, so the
OAuth callback creates a folder named `Seedbox` in the user's Drive and stores its id
as `rootFolderId`. Google endpoints are overridable for tests:
`GOOGLE_OAUTH_AUTH_URL`, `GOOGLE_OAUTH_TOKEN_URL`, `GOOGLE_API_BASE_URL`.

Engine settings: `GET|PUT /admin/engine/settings` (admin only; `EngineSettingsDto` /
partial `EngineSettingsUpdateDto`) let admins tune a fixed whitelist of qBittorrent
preferences from the web UI's collapsed "Advanced: torrent engine" section. The API calls
qBittorrent's Web API (`GET /api/v2/app/preferences`, `POST /api/v2/app/setPreferences`
with `json=`) and maps friendly camelCase names to a hard-coded set of keys (speed limits
in KB/s, connection and upload-slot limits, queueing, DHT/PeX/LSD, encryption, anonymous
mode, listen port, extra trackers). Input is validated strictly server-side and unknown
keys are rejected with 400; nothing outside the whitelist is ever read back or written.
Save paths, WebUI/auth, proxy, "run external program", RSS, scan dirs, mail, DNS, UPnP and
the bound interface are never exposed. The qBittorrent WebUI itself is deliberately not
exposed or proxied: it can run arbitrary commands and rewrite paths and credentials, so
a whitelist is the only safe surface. If the engine is unreachable the API answers 502
`engine_unavailable` without relaying the upstream response.

## Environment

| Var | Used by | Default / meaning |
|---|---|---|
| `APP_SECRET` | api, worker | required, ≥32 chars; encryption + local link key |
| `GATEWAY_SECRET` | gateway, api | required; shared header secret |
| `VPN_CONTROL_TOKEN` | vpn, api, worker | required |
| `APP_HOST`, `AUTH_HOST`, `FILES_HOST` | gateway, api, authelia | hostnames, no scheme |
| `COOKIE_DOMAIN` | authelia | parent domain covering `APP_HOST` and `AUTH_HOST` |
| `PUBLIC_SCHEME` | api | `https` |
| `AUTH_MODE` | gateway | `authelia` \| `external` |
| `ADMIN_GROUP` | api | `admins` |
| `DATA_DIR` | api, worker | `/data` (SQLite at `$DATA_DIR/seedbox.db`) |
| `DOWNLOADS_DIR` | api, worker | `/downloads` (`incomplete/`, `library/`) |
| `QBT_URL` | worker | `http://vpn:8080` |
| `VPN_URL` | api, worker | `http://vpn:8000` |
| `PORT` | api | `3000` |
| `LAN_CIDRS` | vpn, qbittorrent | compose subnet, default `172.31.250.0/24` |
| `LAN_IP_RANGE`, `VPN_IPV4`, `API_IP`, `WORKER_IP` | compose | fixed addresses of `vpn`/`api`/`worker` (`172.31.250.2`/`.3`/`.4`) and the range for everything else (`172.31.250.128/25`); all derived from `LAN_CIDRS` by `setup.sh`; compose passes `API_IP`,`WORKER_IP` to qbittorrent as `QBT_TRUSTED_IPS` |
| `QBT_TRUSTED_IPS` | qbittorrent | comma-separated addresses allowed to use the WebUI without a password (`/32` implied); empty = nobody |
| `VPN_MTU` | vpn | WireGuard interface MTU 576-1500; unset = 1280; a config `MTU =` wins |
| `VPN_DEFAULT_MODE` | vpn | `required` (default) \| `off`; mode right after a container start |
| `LOG_LEVEL` | all | `info` |

Ports inside the compose network: `gateway:8080`, `web:8080`, `api:3000`,
`authelia:9091`, `vpn:8000` (control) and `vpn:8080` (qBittorrent WebUI).
The compose network uses the fixed subnet `LAN_CIDRS` so the kill switch can allow it.

## Downloader interface

`apps/api/src/downloaders/types.ts` — `Downloader { kind; add(input); status(ref);
remove(ref, deleteData) }`. Only `torrent` (qBittorrent Web API at
`QBT_URL=http://vpn:8080`) is implemented. Direct-link / Drive-source downloaders are
future work and must plug in here without touching the job state machine.

## Worker loop (every 2 s)

On start the worker applies `vpn.mode` immediately (retrying every ~3 s until the sidecar answers), then ticks.
Every transition that can race with the API (which inserts/retries jobs at any time) is a single conditional
statement or one immediate transaction evaluated *after* slow work; a final self-heal step catches the rest.

0. Self-heal: a torrent in `removed`/`error` that has an active job (`queued`/`downloading`/`uploading`) is
   reset to `pending` (re-download) instead of stranding the job.
1. New `pending` torrents → add to qBittorrent (category `seedbox`, save path
   `/downloads/incomplete/<infohash>`). Enforce limits; refuse if `vpn.mode=required`
   and VPN is not connected. A pending torrent whose only jobs are dead is retired
   (`UPDATE ... WHERE NOT EXISTS (active job)`). A pending torrent whose data was already moved into the library
   by a completed local job (`library_path` still exists) becomes `downloaded` without downloading again.
2. Sync progress for active torrents; on completion mark `downloaded`.
   - *Missing is transient*: qBittorrent restarting can briefly return an empty list. A torrent the downloader
     does not know is re-added from `source_enc` (idempotent); it is failed only after being missing > 120 s
     continuously AND a re-add was definitively rejected. An unreachable downloader
     (`DownloaderUnavailableError`) never fails anything.
   - Metadata timeout: no metadata after `limits.metadataTimeoutMinutes` → fail ("no peers / metadata timeout").
   - Disk: once metadata is known the torrent (plus extra library copies when seeding or other jobs force copy
     instead of move) must fit above `limits.minFreeDiskBytes`, else fail with a clear message; while
     downloading, free space is re-checked every 60 s and the torrent fails when it falls below the floor.
   - Failing a torrent marks it `error` + `cleanup_pending`, fails its active jobs; a sweep (every tick) removes
     it and its data from qBittorrent and retries until that works. A torrent that a retry has given an active
     job again is never swept.
3. For each job of a downloaded torrent in `downloading` → `uploading`: run
   `rclone copy` (local: copy/move to `/downloads/library/...`), parse
   `--use-json-log --stats 1s` for progress, record `job_files`, then `completed`. S3 endpoints go through an
   SSRF guard first (the shared `lib/netguard.ts` `assertPublicEndpoint`; user-owned destinations: private ranges
   refused; shared/admin ones: allowed). When an S3 copy fails the worker probes the bucket root with the same
   credentials, and if the server rejects them the job error says so (rclone's own copy message can be misleading). rclone gets
   SIGTERM then SIGKILL after 10 s on abort, and is failed after 30 min without byte progress. Local copies abort
   on cancel and remove their partial target. Local *move* is claimed with one conditional UPDATE that also records
   `torrents.library_path`; jobs for the same torrent that arrive later copy from there.
4. When no job still needs a torrent's data and the seeding rule is met → remove from
   qBittorrent with data, then mark `removed` in one transaction that re-checks for active jobs (if one appeared,
   the torrent goes back to `pending`). After a failed upload the data is kept for
   `cleanup.failedGraceMinutes` so "Retry" does not re-download. Seeding stops at `seeding.ratio` or, if set,
   after `seeding.maxMinutes`.
5. VPN: apply `vpn.mode` (only when the sidecar's reported mode differs), health-check, rotate per `vpn.rotation`.
Crash-safe: all state lives in SQLite; on boot, `uploading` jobs restart their upload.

## VPN sidecar (`services/vpn`)

Purpose-built (Gluetun was evaluated and rejected, see `services/vpn/README.md`): Alpine +
`wireguard-tools` + `iproute2` + `nftables` + a small static Go control server on `:8000`
(Bearer `VPN_CONTROL_TOKEN`, reachable only on the compose network).
Needs `cap_add: [NET_ADMIN]` and a kernel with WireGuard (5.6+); no `/dev/net/tun`, no host
sysctls. Sysctl `net.ipv6.conf.all.disable_ipv6=1` (namespaced) is set as belt and braces.
The exact compose blocks for `vpn` and `qbittorrent` are in `services/vpn/README.md`.

```
GET  /status      -> { mode, connected, name, publicIp, lastHandshakeSec, since, mtu }
POST /connect     { name, config }   -> brings the tunnel up (replacing any current one)
POST /disconnect
POST /mode        { mode: "off" | "required" }
```

`/connect` takes raw wg-quick text, rejects `PreUp/PostUp/PreDown/PostDown/SaveConfig` (400),
executes nothing from it, strips IPv6 `Address`/`DNS`/`AllowedIPs` (`::/0`), waits for a handshake
(`502` if none; the previous tunnel is kept) and is make-before-break: the old tunnel carries
traffic until the new one has a handshake, routes are then swapped atomically.
`connected` = interface up and last handshake <= 180 s ago. `publicIp` comes from `PUBLIC_IP_URL`
(default a plain-text IP service) fetched through the tunnel, `null` on failure.
`VPN_DEFAULT_MODE` (`off` | `required`, default **`required`**: fail closed) is the mode after a container
start. After a host or container restart qBittorrent resumes torrents immediately, so the sidecar must not boot
open; the worker then applies the admin's `vpn.mode` right at its start. `POST /mode` with the mode the sidecar
already has changes nothing (the worker re-checks regularly and `off` would tear a live tunnel down); the mode
and the last config are otherwise in memory only and are re-applied by the worker. A failed route swap during
`/connect` restores the previous tunnel's routes.

MTU: the wg interface gets the config's `MTU =` if present, else `VPN_MTU`, else **1280**. Docker's bridge
reports 1500 and hides the real uplink MTU (cloud VMs 1460, PPPoE 1492, overlays lower); with WireGuard's
customary 1420 full-size packets are then black-holed and bulk TCP stalls while small requests work (found on a
live 1460-MTU VM). 1280 is the IPv6 minimum and a common VPN-client default. `/status.mtu` reports the effective
value. As defence in depth the ruleset clamps the MSS of SYNs leaving through `wg*` to the route MTU (a separate
postrouting chain with policy accept; it cannot admit anything the output chain drops). Active path-MTU probing is
not done: probes from the namespace are blocked by the kill switch except to the endpoint, so a static
conservative default is used instead.

Kill switch (always on in `required` mode, including before the first `/connect` and during
rotation): one nftables table, replaced atomically and installed before the API listens. OUTPUT
policy `drop`; allowed only to loopback, `LAN_CIDRS` (the compose subnet, so `api`/`worker` can
reach qBittorrent's WebUI on `:8080` and the e2e tracker/seeder), `wg*` interfaces and the UDP
endpoint of the tunnel being brought up / currently up. Established-connection state grants
nothing. IPv6 is dropped entirely. In `off` mode traffic leaves via the container's normal
route (and a tunnel, if any, is torn down). Input from the tunnel to `:8000`/`:8080` is dropped in
both modes. Config is held in process memory only (never on disk, argv or logs).

DNS: while a tunnel is up the sidecar overwrites `/etc/resolv.conf` *in place* (it is
shared with `qbittorrent`) with the config's `DNS =` servers (else `VPN_FALLBACK_DNS`, default
`1.1.1.1`, via the tunnel), so lookups go through the tunnel. In `required` mode without a tunnel
it holds no nameserver; Docker's embedded resolver (`127.0.0.11`) is restored in `off` mode and
is blocked for everything but root in `required` mode. Root (the sidecar itself) uses it only to
resolve a WireGuard endpoint *hostname*, the one lookup that leaves the namespace outside the
tunnel (IP endpoints avoid it). Consequently nothing in the shared namespace may rely on compose
service names: the e2e tracker/seeder use fixed IPs inside `LAN_CIDRS`.

qBittorrent WebUI auth: `services/qbittorrent` wraps the official image with an
entrypoint that (re)asserts, in `qBittorrent.conf` (`[WebUI]` section in qBittorrent 5), WebUI
port 8080, password-less access only for `QBT_TRUSTED_IPS` (compose: the static `api` and `worker` /32 addresses)
via `AuthSubnetWhitelist`, `LocalHostAuth=false` (loopback is shared only with the vpn sidecar), host-header
validation and CSRF protection off, no UPnP, anonymous mode off, no interface binding, and on first
start only: DHT/PeX on, LSD off, no pre-allocation, default save path `/downloads/incomplete`;
it runs as uid/gid 1000 and refuses to start with `PUID`/`PGID` 0. Every other address in the compose network must
authenticate, and nobody knows the password (none is stored, so qBittorrent generates a random temporary one per
start and only logs it): a compromised sibling container can no longer call `setPreferences`/autorun (= code
execution in the qBittorrent container). The container runs with `cap_drop: [ALL]` plus the five capabilities the
root-to-1000 entrypoint needs. The WebUI is never routed by the gateway.

## drive-proxy (Cloudflare Worker)

Secrets: `GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET`, `GDRIVE_REFRESH_TOKEN`,
`SIGNING_KEY`; var `ROOT_FOLDER_ID`. `GET|HEAD /<path>?exp=&sig=`: verify signature,
resolve path segment-by-segment under the root (Drive `files.list`, cached with the
Cache API), stream `files/<id>?alt=media` passing `Range` through, set
`Content-Disposition: attachment` (always; no inline mode), `Content-Security-Policy: default-src 'none'; sandbox`,
`nosniff`, `Accept-Ranges`; html/xhtml/svg/xml/javascript types are sent as `application/octet-stream`. No directory listing. 404 for anything else.

## Tests

- Unit (vitest) per package.
- `deploy/compose.e2e.yaml`: hermetic stack — the real services plus `opentracker`,
  a seeder that creates a multi-file torrent (a subfolder and file names with spaces,
  unicode, `#`, `%` and `'`) and MinIO. Google Drive is not part of the hermetic stack
  (rclone cannot target a fake Drive API); it is covered by API unit tests with a fake
  Google and by the live suite.
  Also asserts the kill switch: in `required` mode with no tunnel, a host outside
  `LAN_CIDRS` is unreachable from the qBittorrent namespace. Playwright logs in through
  Authelia and drives the UI: add torrent → completed → download link returns bytes
  with the right sha256, for local and S3 destinations; admin VPN/destination CRUD.
- `e2e/live/`: opt-in, real credentials from `credentials/` (Drive folder, B2 prefix
  `seedbox-test/`, real WireGuard configs, deployed Worker). Never run in public CI.
  Only legal, public-domain/CC test torrents, and `vpn.mode=required` is set before
  any torrent is added. B2 cleanup deletes only `seedbox-test/<run-id>/` (asserted in
  code, never `sync`) — that bucket holds unrelated backups.
