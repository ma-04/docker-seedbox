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

Volumes: `data` (SQLite, api+worker), `downloads` (worker: whole volume rw; qbittorrent: only the `incomplete/` subpath rw; gateway: only the `library/` subpath, read-only; api: only the `library/` subpath, for the local-destination test probe),
`authelia`, `qbt-config`. The `downloads` subpaths are Compose `volume.subpath` mounts (Docker Engine 26+, Compose 2.26+), so qBittorrent, which parses untrusted
input in the VPN namespace, never sees the delivered files of other users; the worker sees both and `incomplete/<infohash>` -> `library/...` stays a rename on one filesystem.
The one-shot `init` service creates the subfolders (a subpath must exist before its container starts) and fixes ownership. Capabilities: every service drops `ALL`; `vpn` keeps `NET_ADMIN`, `qbittorrent` `CHOWN`, `SETUID`, `SETGID` and `KILL` with a read-only root filesystem (tmpfs `/tmp`), `authelia` and `nginx-proxy` only what their entrypoints need (see the compose files). No container mounts the Docker socket. Nothing but `gateway`
is reachable from outside the compose network.

TLS is terminated by an outer proxy (nginx-proxy + acme-companion in `deploy/proxy/`,
or any existing proxy). `gateway` exposes `VIRTUAL_HOST`/`LETSENCRYPT_HOST` env for that.

Hosts: by default ONE, `APP_HOST`: SPA + `/api`, the Authelia portal under `/auth/` and local-folder downloads under
`/dl/` (no login, signed URLs only). Optional, independently: `FILES_HOST` moves `/dl/` to a host of its own (then
`/dl/` on `APP_HOST` is a 404), `AUTH_HOST` moves the portal to a host of its own. Empty, or equal to `APP_HOST`,
means "on `APP_HOST`"; the gateway (`25-gateway-auth-mode.sh`), Authelia (`configuration.yml` template) and the API
(`lib/config.ts` `hostLayout`) apply that same rule. Details: [deployment.md](deployment.md#hosts-layout).

## Stack

TypeScript everywhere (ESM), Node 22, npm workspaces (`apps/*`, `e2e`). API: Fastify + better-sqlite3 (WAL,
SQL migrations in `apps/api/migrations/NNN_name.sql`) + zod. Web: React 18 + Vite +
Tailwind + TanStack Query + react-router. Tests: vitest (unit), Playwright (`e2e/`).
Uploads: the `rclone` binary inside the api image, configured only through
`RCLONE_CONFIG_*` environment variables (never a config file on disk).

## Auth

`AUTH_MODE=authelia` (default): gateway does `auth_request` to Authelia
(`http://authelia:9091/api/authz/auth-request`, the root path, which Authelia keeps serving when its
`server.address` has the `/auth` subpath) for everything on `APP_HOST` except `/api/health`, the portal (`/auth/`)
and `/dl/`, and forwards `Remote-User`, `Remote-Email`, `Remote-Name`, `Remote-Groups`. Unauthenticated page
requests are redirected to the `Location` Authelia computes (`<portal>/?rd=<full original URL>&rm=<method>`);
`/api/*` gets a bare 401.
`AUTH_MODE=external`: gateway skips Authelia and forwards the same four headers as
received from the operator's own SSO proxy.

The gateway always strips client-supplied `Remote-*` and `X-Gateway-Secret` headers
(in `authelia` mode) and adds `X-Gateway-Secret: $GATEWAY_SECRET`. The API rejects
any request without the correct secret (401) — this is what makes header auth safe.
Users are auto-provisioned on first request, keyed by `Remote-User`. Admin =
member of group `ADMIN_GROUP` (default `admins`).

Routes that need no login: `GET /api/health` and `GET /dl/*` (on `APP_HOST`, or on `FILES_HOST` when set; signed
URL only; the gateway still adds `X-Gateway-Secret` and never forwards `Cookie`, `Authorization` or `Remote-*`). Every other route requires the user headers.

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
`http(s)` only everywhere. The check above is a pre-flight only: it cannot bind the later connection, and rclone follows
HTTP redirects. So uploads to **user-owned** destinations are enforced at connect time by the **egress proxy**
(`apps/api/src/worker/egress-proxy.ts`): see "Egress proxy" below. Shared (admin) destinations keep direct egress.

### Egress proxy (worker, user-owned S3 destinations)

A tiny in-process forward proxy (Node `http` + `net`, no dependencies), started lazily on `127.0.0.1:<ephemeral port>` the
first time a user-owned upload (or purge) needs it. rclone for such a destination is started with
`HTTPS_PROXY`/`HTTP_PROXY` = `http://seedbox:<random per-process token>@127.0.0.1:<port>` and `NO_PROXY=` (that child only). For
every `CONNECT host:port` (and, if `EGRESS_ALLOW_PLAIN_HTTP=1`, absolute-URI `http://` request) the proxy requires the
`Proxy-Authorization` token (407 otherwise), resolves the name itself, answers 403 unless EVERY resolved address is public
(`lib/netguard.ts` rules) and the port is in `EGRESS_ALLOWED_PORTS` (default `443,80`), and then connects to the vetted IP
literal, never the name, so redirects (`https://evil` -> 307 -> `http://<internal>`) and DNS rebinding cannot reach internal
hosts. Connect timeout 10 s, idle timeout 5 min. Policy and resolver are injectable for tests
(`worker/egress-proxy.test.ts` runs the real rclone binary against a redirecting local "S3"). Known gap: Go's net/http never
proxies `localhost`/loopback hosts, so a redirect to loopback bypasses the proxy; in the worker container nothing but this
token-protected proxy listens there. The API's S3 SDK client (`lib/s3client.ts`, destination test; presigning does no
network) pins `followRegionRedirects: false` and, for user-owned destinations, resolves and vets the address inside the
socket `lookup`, so it also connects to the vetted address.

### Torrent sources

`lib/source.ts` is the only way a source enters the system. A magnet is never stored or forwarded as typed: whitespace or
control characters anywhere, or more than 8 KiB, are rejected (400); a canonical magnet is rebuilt from `xt=urn:btih:<40 hex>`
(v1 only), `dn` (control characters stripped, <= 255 bytes) and up to 50 trackers (`http`, `https`, `udp`, `ws`, `wss`; parseable;
no credentials; host not an IP literal in a non-public range, not a single-label/internal name; no DNS). Every other
parameter (`ws`, `xs`, `as`, `x.pe`, `so`, `kt`, unknown) is dropped; exactly ONE `xt` is allowed and it must be a v1 btih (40 hex / 32 base32),
so hybrid/multi-`xt` magnets are rejected and the recorded infohash is that single value. Uploaded `.torrent` files are parsed by
`lib/bencode-strict.ts`, a canonical-only decoder (any duplicate or unsorted dict key, leading-zero/`-0` integer, bad string length,
trailing byte, nesting > 16, > 2,000,000 elements or > 5 MB anywhere in the file is a 400), because a lenient decode + re-encode
(parse-torrent) keeps the LAST duplicate key and re-sorts keys while libtorrent hashes the RAW bytes of the FIRST `info` value. The
infohash is SHA-1 of the raw `info` bytes (`lib/torrent-file.ts`); the info dict must be v1 (v2/hybrid: `meta version`, `file tree`,
`piece layers` are rejected), `name`/`piece length`/`pieces` well-formed, exactly one of `length`/`files`, safe file paths (no
`.`/`..`/separators/NUL, no BEP 47 symlinks), total size <= MAX_SAFE_INTEGER and `ceil(total/pieceLength) == pieces/20`, so the declared
size that `limits.maxTorrentBytes` checks is trustworthy. The stored file is BUILT FROM SCRATCH: a root dict with only the verbatim
`info` bytes plus sanitised `announce`/`announce-list` (`url-list`, `httpseeds`, `nodes`, `comment`, everything else dropped);
parse-torrent must agree on the infohash of both the upload and the rebuilt file. The worker passes every stored source through the
same strict rebuild on each add and fails the torrent (and its jobs) if it does not validate or its hash differs from the row's;
afterwards the engine must know exactly the expected infohash (an untracked torrent appearing instead is removed with its data and the
torrent fails with "engine reported a different torrent"), and every 30 s the `seedbox` category is swept of torrents matching no
non-removed row. The worker re-canonicalises stored magnets when it adds them (rows from before this policy),
and the qBittorrent client refuses a `urls` value containing CR/LF/whitespace and sends exactly one URL, because
qBittorrent splits `urls` on newlines. Torrents are deduplicated by infohash across users: the first source is kept and
later submissions only add (sanitised) trackers to it; there is no per-user isolation of a torrent's data or trackers.

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
- `pending_deletions(id, destination_id, remote_path, kind, full_path, config_enc, user_owned, attempts, retry_at, last_error, created_at)` (migration 004) —
  files of deleted jobs/destinations the worker still has to remove (see "Deleting jobs").
- `vpn_configs(id, name UNIQUE, config_enc, endpoint_host, enabled, last_used_at, last_error, created_at)`
- `settings(key PRIMARY KEY, value_json)`
- `oauth_states(state PRIMARY KEY, user_id, payload_json, expires_at)` — reserved for per-user
  Google Drive connect (not implemented yet; the table is unused)

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
  publicBaseUrl?: string;                   // default `https://${FILES_HOST || APP_HOST}`; admin-editable
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
  `X-Accel-Redirect: /_protected/<path>` → gateway serves from the `downloads` volume (`disable_symlinks on`: a link anywhere in the path is refused). Responses
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
GET    /me                                   -> { user, isAdmin, limits, cleanup }
GET    /destinations                         -> shared (enabled) + own; secrets masked
POST   /destinations                         -> create own (s3 only; gdrive comes from OAuth)
PATCH  /destinations/:id   DELETE /destinations/:id      (own only)
POST   /destinations/:id/test                -> { ok, message }
GET    /jobs?state=                          -> own jobs (with torrent progress)
POST   /jobs       JSON { magnet, destinationId } | multipart { torrent, destinationId }
GET    /jobs/:id   DELETE /jobs/:id (cancel; or remove a finished job and, see below, its files)   POST /jobs/:id/retry
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
`limits.metadataTimeoutMinutes` (30; 0 = never), `cleanup.failedGraceMinutes` (60), `cleanup.deleteRemoteOnJobDelete` (false; S3 only),
`seeding.ratio` (0 = stop when complete), `seeding.maxMinutes` (0 = no cap; with `seeding.ratio` > 0, stop seeding after this long).
Tracker-list keys (not part of `/admin/settings`; see "Tracker lists" below): `trackers.enabled` (true), `trackers.manual` (the admin's own extra trackers, newline
separated), `trackers.listUrls` (0-5 https URLs), `trackers.refreshHours` (24, 1-720), `trackers.maxTrackers` (200, 1-1000),
`trackers.refreshRequestedAt` / `trackers.refreshDoneAt` (unix s; the API requests, the worker acknowledges).
`google.oauthClientId` / `google.oauthClientSecret` exist as reserved keys only: per-user
"Connect Google Drive" is not implemented, and the admin API neither returns nor accepts them.

**Deleting jobs.** Cancelling an active job never touches files. Deleting a finished job (user `DELETE /jobs/:id` or admin
`DELETE /admin/jobs/:id`) or a destination removes the rows and, in the same transaction, queues the delivered files in
`pending_deletions` (finished jobs that chose a `remote_path`; the worker's reference check makes a failed/cancelled sibling harmless). Local destinations: always; the worker removes
`library/<fullRemotePath(remote_path)>` (must stay under the library root; any `..`, empty segment, symlinked parent or the
`.staging` dir is refused) only if no other job row references the same destination + remote_path (nor another local
destination mapping to the same library path), no active job still needs it as its library copy and no active job exists for the deleted job's torrent and destination (delete + immediate re-add): those cases are deferred, not dropped. It marks the torrents that point into it `removed` with `library_path` cleared in the same immediate transaction as the check (before the files are removed), then prunes empty parent directories (never the library root); failures retry
with backoff (12 attempts). S3: remote data is kept unless `cleanup.deleteRemoteOnJobDelete` is on, then the worker runs
`rclone purge DST:<bucket>/<prefix>/<exact job dir>` unless any job of any S3 destination resolves to the same (endpoint, bucket, full key) (asserted: one segment for user-owned, two for shared, ending in
` [<8 hex>]`, strictly below the prefix; user-owned goes through the egress proxy). Deleting a *destination* only ever removes
local files, never remote data. Google Drive data is never deleted automatically. The deletion pass runs off the tick (an S3
purge can be slow) and is aborted on shutdown. The web UI's Remove confirmation for completed jobs states which of these applies (`GET /me` -> `cleanup`).

**VPN changes are serialised.** The worker's reconcile and `POST /admin/vpn/rotate` hold the `vpn.lock` row of `settings`
(`{token, until}`, 60 s expiry, compare-and-set in an immediate transaction) while they call `/connect`; whoever finds it
held skips (worker) or waits up to 15 s and then answers 409 (admin). The worker re-reads `vpn.mode` right before connecting and treats a sidecar 409
from `/connect` ("mode is off") as nothing to do.

**Logging.** The API logger never records query strings (signed `/dl` links carry `exp`/`sig` there), magnet links, or
`Authorization`/`Cookie`/`X-Gateway-Secret` headers (`api/logging.ts`: `req` serializer plus `redact`).

Infohashes are stored lowercase hex (v1, 40 chars); base32 magnets are converted before
the UNIQUE check. A user re-adding a torrent they already have for the same
destination gets the existing job back (200), not a duplicate.

Google Drive destinations are admin-configured (shared) only; per-user "Connect Google
Drive" is on the roadmap. A token with scope `drive.file` can only see folders the same
OAuth client created, so `rootFolderId` must be such a folder. The token and API endpoints
are overridable for tests: `GOOGLE_OAUTH_TOKEN_URL`, `GOOGLE_API_BASE_URL`.

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
a whitelist is the only safe surface. `addTrackersEnabled` and `addTrackers` are the exception to "written to qBittorrent":
they are stored in our settings (`trackers.enabled`, `trackers.manual`; the manual list only, at most 100 lines / 16 KB) and the
worker writes manual + fetched trackers to the engine (see "Tracker lists"). If the engine is unreachable the API answers 502
`engine_unavailable` without relaying the upstream response.

### Tracker lists

Admins can load extra trackers from up to five public `https` plain-text lists and have them added to new downloads.
The **app** fetches and validates the lists; qBittorrent's own "add trackers from URL" preference
(`add_trackers_from_url_enabled`, `add_trackers_url`; present in the pinned qBittorrent 5.3.0) is deliberately left off (the worker re-asserts it on every
check): its fetch runs inside the VPN namespace, validates nothing (no scheme/host check, no size cap) and gives the UI no status.

- `GET /admin/trackers` -> `TrackersDto`: `enabled`, `urls`, `refreshHours`, `maxTrackers`, per-list status (`url`, `lastFetchedAt`,
  `lastAttemptAt`, `ok`, `error`, `trackerCount`), `manualCount`, `effectiveCount`, `refreshRequestedAt` (non-null while a refresh is pending).
  `PUT /admin/trackers` (`urls`, `refreshHours`, `maxTrackers`, all optional, strict) validates each URL (https, <= 2048 chars,
  no credentials, `assertPublicEndpoint` incl. DNS at save time) and requests a refresh when the URLs or the cap changed.
  `POST /admin/trackers/refresh` -> 202, sets `trackers.refreshRequestedAt` (rate limit 6/min per admin; 409 when switched off or no URLs).
  The API itself never fetches a list.
- Worker (`worker/trackers.ts`, one step per tick, `lib/trackerlist.ts` + `lib/trackers.ts`):
  1. first run: copies the engine's current `add_trackers` / `add_trackers_enabled` into `trackers.manual` / `trackers.enabled`
     (each only if our setting does not exist yet), so existing deployments and the e2e fixture tracker keep theirs;
  2. when due (never fetched, older than `refreshHours`, failed lists retried hourly, or an admin request is pending) and enabled, fetches
     each URL: `assertPublicEndpoint(url, { allowPrivate: false })` right before every request, TCP connection pinned to a vetted
     address (`vettedLookup`, no rebinding window), redirects followed by hand (max 3, each hop re-vetted), 10 s deadline,
     1 MiB cap, `User-Agent: docker-seedbox`, no cookies/auth, `Accept-Encoding: identity`;
  3. parses (one tracker per line or comma/space separated, `#` comments, <= 512 chars, the SAME `sanitiseTracker` policy as user-submitted
     trackers, IDN punycoded, deduped on scheme+host (case-insensitive) + exact rest, capped at `trackers.maxTrackers`); a body that looks
     like HTML/binary (NUL, invalid UTF-8, `<html`), is empty, or has > 20 % invalid entries is rejected and the previous list kept;
  4. stores one row per URL in `tracker_lists` (migration `005_tracker_lists.sql`: last successful trackers, `fetched_at`, last
     attempt, `ok`, short `error`, `tracker_count`, `body_sha256`); a failed refresh keeps the last good list (stale-while-error);
  5. effective list = manual trackers first, then the fetched ones in list order, deduplicated, fetched part capped at
     `trackers.maxTrackers`. It is written to `add_trackers` (+ `add_trackers_enabled`, `add_trackers_from_url_enabled=false`) only when it
     differs from what was last applied, and re-verified against the engine every 60 s (qBittorrent restart, edit in the WebUI);
  6. `trackers.enabled = false` disables everything: nothing is fetched and the engine is told `add_trackers_enabled=false`;
  7. private torrents: qBittorrent skips `add_trackers` for torrents added with metadata that are private (`.torrent` files) but, for a magnet,
     the privacy flag is unknown at add time, so the extra trackers are added and never removed. Every 30 s the worker asks the engine for
     torrents it flags `private` and removes the manual/fetched trackers (those not present in the magnet's own `tr`) with `torrents/removeTrackers`.
- Applies to torrents added after the list was applied (the engine's "add to new downloads" semantics); running downloads are not changed.
- Test-only: `TRACKER_LIST_ALLOW_PRIVATE=1` (api + worker) lets list URLs be plain `http` on private addresses. The config loader refuses it
  unless `E2E_HERMETIC=1` is set too; only `deploy/compose.e2e.yaml` sets either.

## Environment

| Var | Used by | Default / meaning |
|---|---|---|
| `APP_SECRET` | api, worker | required, ≥32 chars; encryption + local link key |
| `GATEWAY_SECRET` | gateway, api | required; shared header secret |
| `VPN_CONTROL_TOKEN` | vpn, api, worker | required |
| `APP_HOST` | gateway, api, authelia | required; hostname, no scheme |
| `AUTH_HOST`, `FILES_HOST` | gateway, api, authelia | optional separate hosts; empty or `= APP_HOST` = `/auth/`, `/dl/` on `APP_HOST` |
| `COOKIE_DOMAIN` | authelia | session cookie domain; empty = `APP_HOST`; with a separate `AUTH_HOST` a parent of both |
| `PUBLIC_SCHEME` | api | `https` |
| `AUTH_MODE` | gateway | `authelia` \| `external` |
| `ADMIN_GROUP` | api | `admins` |
| `DATA_DIR` | api, worker | `/data` (SQLite at `$DATA_DIR/seedbox.db`) |
| `DOWNLOADS_DIR` | api, worker | `/downloads` (`incomplete/`, `library/`) |
| `QBT_URL` | worker | `http://vpn:8080` |
| `VPN_URL` | api, worker | `http://vpn:8000` |
| `PORT` | api | `3000` |
| `LAN_CIDRS` | vpn, qbittorrent | compose subnet, default `172.31.250.0/24` |
| `CONTROL_TRUSTED_IPS` | vpn | addresses allowed to reach the control API (compose: `API_IP,WORKER_IP`); empty = whole `LAN_CIDRS` |
| `VPN_LAN_ALLOW_OUT` | vpn | **test-only** LAN `ip[:port]` list qBittorrent may reach (e2e/test fixtures); empty by default |
| `LAN_IP_RANGE`, `VPN_IPV4`, `API_IP`, `WORKER_IP` | compose | fixed addresses of `vpn`/`api`/`worker` (`172.31.250.2`/`.3`/`.4`) and the range for everything else (`172.31.250.128/25`); all derived from `LAN_CIDRS` by `setup.sh`; compose passes `API_IP`,`WORKER_IP` to qbittorrent as `QBT_TRUSTED_IPS` |
| `QBT_TRUSTED_IPS` | qbittorrent | comma-separated addresses allowed to use the WebUI without a password (`/32` implied); empty = nobody |
| `VPN_MTU` | vpn | WireGuard interface MTU 576-1500; unset = 1280; a config `MTU =` wins |
| `VPN_DEFAULT_MODE` | vpn | `required` (default) \| `off`; mode right after a container start |
| `EGRESS_ALLOWED_PORTS` | worker | `443,80`: destination ports the egress proxy allows for user-owned S3 destinations |
| `EGRESS_ALLOW_PLAIN_HTTP` | worker | `1` lets the egress proxy forward plain `http://` requests (default off: user destinations must be https) |
| `TRACKER_LIST_ALLOW_PRIVATE` | api, worker | **test-only** `1` lets tracker-list URLs be http / private (needs `E2E_HERMETIC=1`, otherwise startup fails); unset by default |
| `E2E_HERMETIC` | api, worker | **test-only** marker of the hermetic e2e stack; only enables the flag above |
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
   reset to `pending` instead of stranding the job; its `library_path` is kept while the library copy exists, so it is
   served from there without a re-download.
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
3. For each job of a downloaded torrent in `downloading` → `uploading` (the content root is first resolved with `realpath` and must lie inside the real
   `incomplete/<infohash>`; only regular files and directories are delivered: symlinks, FIFOs, sockets, devices and hardlinked files planted by a
   compromised qBittorrent are skipped, files are opened with `O_NOFOLLOW` and verified on the descriptor, a local move goes through the worker-only
   `library/.staging` and is re-vetted there, rclone receives the vetted list via `--files-from-raw`; if a `downloaded` torrent's recorded library copy is gone the torrent goes back to `pending` and the job to `queued`): run
   `rclone copy` (local: copy/move to `/downloads/library/...`), parse
   `--use-json-log --stats 1s` for progress, record `job_files`, then `completed`. S3 endpoints go through an
   SSRF pre-flight first (the shared `lib/netguard.ts` `assertPublicEndpoint`; user-owned destinations: private ranges
   refused; shared/admin ones: allowed), and for user-owned destinations rclone then runs through the egress proxy, which
   enforces the same rules on every connection it makes (redirects, DNS rebinding). When an S3 copy fails the worker probes the bucket root with the same
   credentials, and if the server rejects them the job error says so (rclone's own copy message can be misleading). rclone gets
   SIGTERM then SIGKILL after 10 s on abort, and is failed after 30 min without byte progress. Local copies abort
   on cancel and remove their partial target. Local *move* is claimed with one conditional UPDATE that also records
   `torrents.library_path`; jobs for the same torrent that arrive later copy from there.
4. When no job still needs a torrent's data and the seeding rule is met → remove from
   qBittorrent with data, then mark `removed` in one transaction that re-checks for active jobs (if one appeared,
   the torrent goes back to `pending`). After a failed upload the data is kept for
   `cleanup.failedGraceMinutes` so "Retry" does not re-download. Seeding stops at `seeding.ratio` or, if set,
   after `seeding.maxMinutes`.
5b. Deleted jobs/destinations: consume `pending_deletions` (see "Deleting jobs").
5a. Tracker lists: migrate, refresh when due, apply to the engine on change, strip extra trackers from private magnets (see "Tracker lists").
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
POST /connect     { name, config }   -> brings the tunnel up (replacing any current one); 409 while the mode is off
POST /disconnect
POST /mode        { mode: "off" | "required" }
```

`/connect` is refused with **409** while the mode is `off` (checked under the same lock as `/mode`, before anything is touched), so a worker that raced an admin's
switch to off cannot bring a tunnel up; the worker only connects in `required` mode, the admin "connect" action has to be handled as a 409. Keys must match
`^[A-Za-z0-9+/]{43}=$`; command output is never put into HTTP bodies (400/409/502 carry fixed messages, other failures "internal error"); `wg`'s output, which can echo configuration, is also kept out of the logs (generic category only), while `ip`/`nft` failures are logged in full for the operator.
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
policy `drop`; allowed only to the `lo` device, `wg*` interfaces, the UDP endpoint of the tunnel being brought up /
currently up (fwmarked packets only) and, towards `LAN_CIDRS`, **only** replies (`ct state established,related`:
api/worker talking to the WebUI `:8080` and control `:8000`). **There is no uid exemption**: root (the sidecar, or root in the
qbittorrent container, which shares the namespace) gets no LAN access; Docker's embedded resolver `127.0.0.11` is on `lo`, so
the sidecar's endpoint-hostname lookups need nothing else. In **both** modes (`off` is not a way around it) every uid is dropped
towards `LAN_CIDRS` and towards every private/reserved IPv4 range (`blockedV4` in `killswitch.go`: `10/8`, `172.16/12`, `192.168/16`,
`100.64/10`, `169.254/16`, `127/8` off `lo`, `224/4`, `240/4`, `0/8`, `192.0.0.0/24`, `198.18/15`), on every interface; through `wg*` the
only private destinations accepted are the tunnel's DNS servers on port 53 (the rule list is rebuilt with old and new servers
during a rotation). IPv6 off `lo` is dropped in both modes. The fwmarked endpoint accept and the LAN established accept come
before those drops, so a private endpoint address still works. In `off` mode the output policy is accept (internet-direct; a tunnel,
if any, is torn down) with the same drops. RFC 5737 documentation ranges are not in the list: the test stacks use `198.51.100.0/24`
("the internet") and `203.0.113.0/24` (behind the WireGuard servers). INPUT from the LAN reaches only the WebUI port (any LAN address;
qBittorrent's own auth whitelist decides) and the control port, which only `CONTROL_TRUSTED_IPS` (compose: `API_IP`, `WORKER_IP`) may reach; input from the tunnel to
`:8000`/`:8080` is dropped in both modes. `VPN_LAN_ALLOW_OUT` (`ip[:port],...`, empty by default) is a **test-only**
exception list for the hermetic fixtures that sit on the LAN by IP (the e2e tracker `172.31.250.30:6969` and seeder
`172.31.250.31:51413`, set in `deploy/compose.e2e.yaml`; `services/vpn/test`): qBittorrent may connect to exactly
those and they may connect in. Config is held in process memory only (never on disk, argv or logs).

DNS: while a tunnel is up the sidecar overwrites `/etc/resolv.conf` *in place* (it is
shared with `qbittorrent`) with the config's `DNS =` servers (else `VPN_FALLBACK_DNS`, default
`1.1.1.1`, via the tunnel), so lookups go through the tunnel. In `required` mode without a tunnel
it holds no nameserver; Docker's embedded resolver (`127.0.0.11`) is restored in `off` mode and
is blocked for everything but root in `required` mode. Root (the sidecar itself) uses it only to
resolve a WireGuard endpoint *hostname*, the one lookup that leaves the namespace outside the
tunnel (IP endpoints avoid it). Consequently nothing in the shared namespace may rely on compose
service names: the e2e tracker/seeder use fixed IPs inside `LAN_CIDRS`.

qBittorrent WebUI auth: `services/qbittorrent` wraps the official image with an entrypoint (`seed-config.sh`, run by tini)
that does as root only: validate `PUID`/`PGID` (refuses 0), a non-recursive `chown -h` of the `/config` volume directory and the drop to
uid/gid 1000 (`doas -u qbtUser`; another `PUID`/`PGID` needs a writable `/etc/passwd`, i.e. it fails with the read-only rootfs). The
official `/entrypoint.sh` is not used (it runs `chown -R` and writes config as root, both of which follow symlinks that a
compromised qBittorrent can plant in `/config`). `conf-edit.sh` then runs as uid 1000 and (re)asserts, in `qBittorrent.conf` (`[WebUI]` section
in qBittorrent 5): WebUI port 8080, password-less access only for `QBT_TRUSTED_IPS` (compose: the static `api` and `worker` /32
addresses) via `AuthSubnetWhitelist`, `LocalHostAuth=false` (loopback is shared only with the vpn sidecar), host-header
validation and CSRF protection off, no UPnP, anonymous mode off, no interface binding, libtorrent's SSRF mitigation
(`Session\SSRFMitigation=true`) and, on first
start only: DHT/PeX on, LSD off, anonymous mode off, no pre-allocation, default save path `/downloads/incomplete`
(everything in the app's engine-settings whitelist, `apps/api/src/api/engine.ts`, is seeded once and then belongs to the admin; only the
security-critical keys are re-asserted on every start: WebUI whitelist/port/host-header/CSRF design, no UPnP, no autorun, no interface binding, SSRF mitigation).
`conf-edit.sh` never follows a link: it checks the directory chain with `[ -L ]`, edits via `mktemp` in the same directory and `mv` (rename replaces a
planted link) and has no fixed temp name (`services/qbittorrent/test/symlink.sh` plants links and checks nothing is written through them).
Every other address in the compose network must
authenticate, and nobody knows the password (none is stored, so qBittorrent generates a random temporary one per
start and only logs it): a compromised sibling container can no longer call `setPreferences`/autorun (= code
execution in the qBittorrent container). The container runs with `cap_drop: [ALL]` plus `CHOWN`, `SETUID`, `SETGID`, `KILL`, a
read-only root filesystem (the entrypoint cannot be replaced) and a `/tmp` tmpfs. The WebUI is never routed by the gateway.

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
