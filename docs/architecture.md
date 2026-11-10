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

Volumes: `data` (SQLite, api+worker), `downloads` (qbittorrent+worker rw, gateway ro),
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

## Domain model (SQLite)

Authoritative schema: `apps/api/migrations/001_init.sql`. Timestamps are unix seconds.

- `users(id, username UNIQUE, email, display_name, is_admin, disabled, max_active_jobs NULL, created_at, last_seen_at)`
- `destinations(id, owner_user_id NULL, name, type, config_enc, enabled, is_default, created_at)` —
  `owner_user_id NULL` = shared (admin-managed, visible to all); otherwise private to that user.
- `torrents(id, infohash UNIQUE, name, source_enc, total_size, state, progress, dl_speed, save_path, error, added_at, completed_at)` —
  one row per infohash; many jobs may reference it (two users adding the same torrent share one download).
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

Remote layout for every destination: `<prefix>/<userSlug>/<torrentName>/...` for shared
destinations, `<prefix>/<torrentName>/...` for user-owned ones. `userSlug` =
`username` lowercased, `[^a-z0-9._-]` → `_`. Local destination root is
`/downloads/library` inside the containers.

### Links

- gdrive, shared, with proxy: `${proxyBaseUrl}/<urlencoded path>?exp=<unix>&sig=<hex>`.
  The API also returns the per-user Drive folder URL when `sharing != 'none'`.
- gdrive, user-owned: Drive `webViewLink` of the uploaded folder.
- s3: `publicBaseUrl` join, else a presigned GET.
- local: `${publicBaseUrl}/dl/<urlencoded path>?exp=&sig=` → api verifies →
  `X-Accel-Redirect: /_protected/<path>` → gateway serves from the `downloads` volume.

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
`seeding.ratio` (0 = stop when complete), `google.oauthClientId`,
`google.oauthClientSecret` (encrypted; used for user "Connect Google Drive").

Infohashes are stored lowercase hex (v1, 40 chars); base32 magnets are converted before
the UNIQUE check. A user re-adding a torrent they already have for the same
destination gets the existing job back (200), not a duplicate.

User-owned Google Drive: scope `drive.file` cannot see pre-existing folders, so the
OAuth callback creates a folder named `Seedbox` in the user's Drive and stores its id
as `rootFolderId`. Google endpoints are overridable for tests:
`GOOGLE_OAUTH_AUTH_URL`, `GOOGLE_OAUTH_TOKEN_URL`, `GOOGLE_API_BASE_URL`.

## Environment

| Var | Used by | Default / meaning |
|---|---|---|
| `APP_SECRET` | api, worker | required, ≥32 chars; encryption + local link key |
| `GATEWAY_SECRET` | gateway, api | required; shared header secret |
| `VPN_CONTROL_TOKEN` | vpn, api, worker | required |
| `APP_HOST`, `AUTH_HOST`, `FILES_HOST` | gateway, api, authelia | hostnames, no scheme |
| `PUBLIC_SCHEME` | api | `https` |
| `AUTH_MODE` | gateway | `authelia` \| `external` |
| `ADMIN_GROUP` | api | `admins` |
| `DATA_DIR` | api, worker | `/data` (SQLite at `$DATA_DIR/seedbox.db`) |
| `DOWNLOADS_DIR` | api, worker | `/downloads` (`incomplete/`, `library/`) |
| `QBT_URL` | worker | `http://vpn:8080` |
| `VPN_URL` | api, worker | `http://vpn:8000` |
| `PORT` | api | `3000` |
| `LAN_CIDRS` | vpn, qbittorrent | compose subnet, default `172.31.250.0/24` |
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

1. New `pending` torrents → add to qBittorrent (category `seedbox`, save path
   `/downloads/incomplete/<infohash>`). Enforce limits; refuse if `vpn.mode=required`
   and VPN is not connected.
2. Sync progress for active torrents; on completion mark `downloaded`.
3. For each job of a downloaded torrent in `downloading` → `uploading`: run
   `rclone copy` (local: `rclone copy` to `/downloads/library/...`), parse
   `--use-json-log --stats 1s` for progress, record `job_files`, then `completed`.
4. When no job still needs a torrent's data and the seeding rule is met → remove from
   qBittorrent with data.
5. VPN: apply `vpn.mode`, health-check, rotate per `vpn.rotation`.
Crash-safe: all state lives in SQLite; on boot, `uploading` jobs restart their upload.

## VPN sidecar (`services/vpn`)

Alpine + `wireguard-tools` + `iptables` + a small control server on `:8000`
(Bearer `VPN_CONTROL_TOKEN`, reachable only on the compose network).
Needs `cap_add: [NET_ADMIN]`, `/dev/net/tun`, sysctl `net.ipv4.conf.all.src_valid_mark=1`.

```
GET  /status      -> { mode, connected, name, publicIp, lastHandshakeSec, since }
POST /connect     { name, config }   -> brings the tunnel up (replacing any current one)
POST /disconnect
POST /mode        { mode: "off" | "required" }
```

Kill switch (always on in `required` mode, including before the first `/connect`):
OUTPUT allowed only to `lo`, the wg interface, the current WireGuard endpoint
(UDP), and `LAN_CIDRS` (the compose subnet, so `api`/`worker` can reach
qBittorrent's WebUI on `:8080` and the e2e tracker/seeder). IPv6 is dropped entirely
and `::/0` is stripped from `AllowedIPs`. In `off` mode traffic leaves via the
container's normal route. Config is held in memory/tmpfs only.

DNS: while a tunnel is up the sidecar overwrites `/etc/resolv.conf` *in place* (it is
shared with `qbittorrent`) with the config's `DNS =` servers, so lookups go through
the tunnel; Docker's embedded resolver (`127.0.0.11`) is restored on disconnect / `off`.
Consequently nothing in the shared namespace may rely on compose service names: the
e2e tracker/seeder use fixed IPs inside `LAN_CIDRS`.

qBittorrent WebUI auth: `services/qbittorrent` wraps the official image with an
entrypoint that seeds `qBittorrent.conf` (WebUI port 8080, auth bypass for
`LAN_CIDRS` via `AuthSubnetWhitelist`, host-header validation off, no UPnP, DHT/PeX on,
default save path `/downloads/incomplete`). The WebUI is never routed by the gateway.

## drive-proxy (Cloudflare Worker)

Secrets: `GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET`, `GDRIVE_REFRESH_TOKEN`,
`SIGNING_KEY`; var `ROOT_FOLDER_ID`. `GET|HEAD /<path>?exp=&sig=`: verify signature,
resolve path segment-by-segment under the root (Drive `files.list`, cached with the
Cache API), stream `files/<id>?alt=media` passing `Range` through, set
`Content-Disposition`, `Accept-Ranges`. No directory listing. 404 for anything else.

## Tests

- Unit (vitest) per package.
- `deploy/compose.e2e.yaml`: hermetic stack — the real services plus `opentracker`,
  a seeder that creates a multi-file torrent (a subfolder and file names with spaces,
  unicode, `#`, `%` and `'`), MinIO, and a fake Google (OAuth + Drive subset).
  Also asserts the kill switch: in `required` mode with no tunnel, a host outside
  `LAN_CIDRS` is unreachable from the qBittorrent namespace. Playwright logs in through
  Authelia and drives the UI: add torrent → completed → download link returns bytes
  with the right sha256, for local and S3 destinations; admin VPN/destination CRUD.
- `e2e/live/`: opt-in, real credentials from `credentials/` (Drive folder, B2 prefix
  `seedbox-test/`, real WireGuard configs, deployed Worker). Never run in public CI.
  Only legal, public-domain/CC test torrents, and `vpn.mode=required` is set before
  any torrent is added. B2 cleanup deletes only `seedbox-test/<run-id>/` (asserted in
  code, never `sync`) — that bucket holds unrelated backups.
