# Configuration

Two places: **environment** (`deploy/.env`, written by `./setup.sh`, applied by `docker compose up -d`) and the **Admin UI** (stored in the database).

## Environment

Edit `deploy/.env` and run `cd deploy && docker compose up -d` to apply. Secrets are generated once by `setup.sh` and never overwritten.

### Application variables (see [architecture.md](architecture.md#environment))

| Var | Used by | Default / meaning |
|---|---|---|
| `APP_SECRET` | api, worker | Required, >= 32 chars. Encrypts stored credentials and derives the local link key. **Back it up; changing it makes stored secrets unreadable.** |
| `GATEWAY_SECRET` | gateway, api | Required. Header secret that proves a request came through the gateway. |
| `VPN_CONTROL_TOKEN` | vpn, api, worker | Required. Bearer token for the VPN control API. |
| `APP_HOST` | gateway, api, authelia | Required. Hostname without scheme of the web UI and `/api`; by default also of the login portal (`https://APP_HOST/auth/`) and local downloads (`https://APP_HOST/dl/`). See [Hosts layout](deployment.md#hosts-layout). |
| `FILES_HOST` | gateway, api | Empty (default) = downloads under `APP_HOST/dl/`. A different hostname = local downloads on their own origin (recommended hardening, see [SECURITY.md](../SECURITY.md)); `/dl/` on `APP_HOST` then answers 404. Best outside `COOKIE_DOMAIN`. |
| `AUTH_HOST` | gateway, api, authelia | Empty (default) = Authelia portal under `APP_HOST/auth/`. A different hostname = the portal on its own host (the layout before single-domain support); `COOKIE_DOMAIN` must then be a parent of both. |
| `COOKIE_DOMAIN` | authelia | Domain of Authelia's session cookie. Empty = `APP_HOST` (`setup.sh` writes `APP_HOST`). With a separate `AUTH_HOST`: a parent domain of `APP_HOST` and `AUTH_HOST`. |
| `PUBLIC_SCHEME` | api | `https`. Only change for local experiments over plain http. |
| `AUTH_MODE` | gateway | `authelia` (default) or `external` ([external SSO](deployment.md#external-sso-mode)). |
| `ADMIN_GROUP` | api | `admins`. Users in this group are admins. |
| `DATA_DIR` | api, worker | `/data` (fixed in compose; SQLite at `$DATA_DIR/seedbox.db`). |
| `DOWNLOADS_DIR` | api, worker | `/downloads` (fixed in compose; `incomplete/`, `library/`). |
| `QBT_URL` | worker | `http://vpn:8080` (fixed in compose). |
| `VPN_URL` | api, worker | `http://vpn:8000` (fixed in compose). |
| `PORT` | api | `3000` (fixed in compose). |
| `LAN_CIDRS` | vpn, qbittorrent | Subnet of the internal network, default `172.31.250.0/24`. Change it only if it collides with another Docker network or your LAN, and then change the four address variables below with it: `./setup.sh` derives them all from `LAN_CIDRS` (edit `LAN_CIDRS` in `deploy/.env`, re-run `./setup.sh`). |
| `LAN_IP_RANGE`, `VPN_IPV4`, `API_IP`, `WORKER_IP` | compose | Fixed addresses for `vpn`/`api`/`worker` (defaults `.2`/`.3`/`.4` of the default subnet); other containers get addresses from `LAN_IP_RANGE` (default `172.31.250.128/25`). All must be inside `LAN_CIDRS`. `API_IP` and `WORKER_IP` are the only addresses allowed to use qBittorrent's WebUI without a password (`QBT_TRUSTED_IPS`). |
| `VPN_MTU` | vpn | MTU of the WireGuard interface, 576-1500. Unset = `1280`. An `MTU =` line in an uploaded WireGuard config takes precedence over this. See [VPN](#vpn). |
| `VPN_DEFAULT_MODE` | vpn | `required` (default, fail closed) or `off`. Mode of the VPN sidecar after every (re)start, until the worker applies the admin's `vpn.mode` (within seconds). |
| `EGRESS_ALLOWED_PORTS` | worker | `443,80`. Ports the worker's egress proxy lets rclone reach for **user-owned** S3 destinations (shared/admin destinations connect directly). Add a port (e.g. `443,80,9000`) only if your users' S3 services need it. |
| `EGRESS_ALLOW_PLAIN_HTTP` | worker | Unset. `1` lets the egress proxy forward plain `http://` requests (user-owned destinations must use https, so only redirects ever need this). |
| `LOG_LEVEL` | all | `info`. |
| `CONTROL_TRUSTED_IPS` | vpn | Comma-separated IPv4 addresses allowed to reach the sidecar's control API (`:8000`). Compose sets `API_IP,WORKER_IP`; empty = any address in `LAN_CIDRS` (the bearer token is still required). |
| `VPN_LAN_ALLOW_OUT` | vpn | **Test fixtures only. Never set on a real deployment.** Comma-separated `IPv4[:port]` LAN addresses that qBittorrent may connect to (and the addresses may connect in). Used by `deploy/compose.e2e.yaml` and `services/vpn/test`, whose tracker/seeder live on the LAN by IP. Empty (default) = the kill switch lets nothing started by qBittorrent reach the LAN at all. |

### Deployment variables (compose / setup.sh)

| Var | Default | Meaning |
|---|---|---|
| `COMPOSE_FILE` | `compose.yaml:compose.proxy-<mode>.yaml` | Selects the proxy mode. |
| `COMPOSE_PROFILES` | `authelia` | Starts Authelia; empty for `AUTH_MODE=external`. |
| `COMPOSE_PROJECT_NAME` | `seedbox` | Prefix of containers, network and volumes. |
| `SEEDBOX_REGISTRY` | `ghcr.io/ma-04` | Registry/owner of the prebuilt images. |
| `SEEDBOX_VERSION` | newest release (pinned by `setup.sh`) | Image tag: `X.Y.Z`, `X.Y`, `latest`, `edge`, `sha-<commit>`, or `local` (built from the clone). Multi-arch (amd64, arm64). See [deployment.md](deployment.md#versions-upgrades-and-verification). |
| `AUTH_POLICY` | `one_factor` | Authelia policy for the app host; `two_factor` requires TOTP. |
| `AUTHELIA_SESSION_SECRET`, `AUTHELIA_STORAGE_ENCRYPTION_KEY`, `AUTHELIA_JWT_SECRET` | generated | Authelia secrets (session, SQLite encryption, password-reset tokens). |
| `ACME_EMAIL` | empty | Let's Encrypt contact (bundled/external nginx-proxy). |
| `PROXY_NETWORK` | empty | External mode: Docker network of your proxy. |
| `HTTP_BIND`, `HTTP_PORT` | `127.0.0.1`, `8080` | None mode: where the gateway is published. |

`setup.sh` also reads `SEEDBOX_DOMAIN`, `SEEDBOX_FILES_HOST`, `SEEDBOX_AUTH_HOST`, `SEEDBOX_COOKIE_DOMAIN`, `SEEDBOX_SINGLE_DOMAIN` (`1`), `SEEDBOX_ADMIN_USER`, `SEEDBOX_ADMIN_PASSWORD`, `SEEDBOX_ADMIN_EMAIL`, `SEEDBOX_PROXY`, `SEEDBOX_PROXY_NETWORK`, `SEEDBOX_ACME_EMAIL`, `SEEDBOX_AUTH_MODE`, `SEEDBOX_VERSION_OVERRIDE`, `SEEDBOX_BUILD`, `SEEDBOX_YES` as alternatives to its flags (`./setup.sh --help`). Values containing newlines or control characters are rejected.

## Admin UI settings

Open **Admin** after logging in as a member of `admins`.

| Setting | Default | Meaning |
|---|---|---|
| `vpn.mode` | `off` until a config exists | `required` blocks all torrent traffic unless the tunnel is up (kill switch). |
| `vpn.rotation` | `manual` | `manual`, `interval` or `on-failure`. |
| `vpn.rotationMinutes` | 360 | Interval for `interval` rotation. |
| `limits.maxActiveJobsPerUser` | 5 | Per-user concurrency (overridable per user). |
| `limits.maxTorrentBytes` | 0 | Reject larger torrents; 0 = unlimited. |
| `limits.minFreeDiskBytes` | 2 GiB | Refuse new downloads below this free space. |
| `seeding.ratio` | 0 | Stop seeding at this ratio; 0 = remove as soon as the upload finishes. |
| `seeding.maxMinutes` | 0 | With `seeding.ratio` > 0: stop seeding after this many minutes even if the ratio is not reached; 0 = no cap. |
| `limits.metadataTimeoutMinutes` | 30 | A magnet that gets no metadata (no peers) within this time fails and frees the user's job slot; 0 = never. |
| `cleanup.failedGraceMinutes` | 60 | After an upload failed, keep the downloaded data this long so "Retry" re-uploads without downloading again. |
| `cleanup.deleteRemoteOnJobDelete` | off | Removing a completed job already deletes its files from a **local** destination. With this on it also deletes the job folder in an **S3** destination (`rclone purge` of that one folder). Google Drive files are never deleted automatically. |
| Tracker lists | none | Own card in Admin > Settings; see [Tracker lists](#tracker-lists). |
| `google.oauthClientId` / `google.oauthClientSecret` | unset | Reserved for the planned per-user Google Drive connect (not a supported feature yet). |

### Tracker lists

Admin > Settings > **Tracker lists** loads extra trackers from plain-text lists (one tracker per line, `#` comments allowed, comma/space separated also
works), for example `https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt` (use the quick-fill button). They are added
to every torrent you start afterwards.

| Field | Default | Meaning |
|---|---|---|
| List URLs | none | Up to 5 `https` URLs on public hosts, no credentials. |
| Refresh every | 24 h (1-720) | Lists are re-downloaded this often; **Refresh now** asks the worker to do it immediately. A failing list is retried hourly and the last good copy stays in use. |
| Max trackers from lists | 200 (1-1000) | Kept in list order (lists are usually sorted by quality). Your manual trackers do not count. |

Your **manual** extra trackers are still the "Extra trackers" box under *Advanced: torrent engine* (now max 100 lines / 16 KB, and it shows only your
manual entries, never the downloaded ones). The torrent engine receives the manual trackers first, then the downloaded ones, deduplicated. Turning off
"Add extra trackers to new torrents" there switches the whole feature off: nothing is fetched and nothing is added.

- **New downloads only.** qBittorrent applies the setting when a torrent is added; running downloads keep their trackers (there is no "add to active downloads" button).
- **Private torrents.** qBittorrent does not add these trackers to a torrent that is already known to be private (a `.torrent` file with the private flag).
  For a magnet link the engine cannot know before it has the metadata, so it adds them anyway; the worker removes the extra trackers again (all except those
  in the magnet itself) shortly after the engine flags the torrent as private. Verified against the qBittorrent 5.3.0 source (`SessionImpl::addTorrent_impl`:
  `isAddTrackersEnabled() && !(hasMetadata && p.ti->priv())`). Torrent info reports `private` only once the metadata is known. Until the metadata arrives, and up to the next sweep (~30 s) after that, the extra trackers are announced to (they learn the infohash and the VPN exit IP). The sweep only removes trackers that are in the current list and only runs while extra trackers are enabled.
  Do not add private-tracker torrents on a shared instance anyway (see SECURITY.md).
- **Why not qBittorrent's own "download trackers from URL"?** It fetches from inside the VPN network namespace with no scheme/host validation and no size cap, and gives
  the UI nothing to show. The app fetches and filters instead; the engine's own option is kept off.
- **Privacy.** Trackers see the VPN exit IP and the infohash of every download; a third-party list widens who learns that.
- **Limits.** Only `http`, `https`, `udp`, `ws`, `wss` trackers on public hosts are kept; entries pointing at private,
  loopback or single-label hosts are dropped like in user-submitted magnets. A list that looks like an HTML page or has more than 20 % invalid entries is ignored entirely.
- **Test-only override.** `TRACKER_LIST_ALLOW_PRIVATE=1` (with `E2E_HERMETIC=1`) allows plain-http, private list URLs for the hermetic e2e stack. The app refuses to start with only the first one. Never set either on a real deployment.

### VPN

Admin -> VPN: paste or upload one or more WireGuard configs (`wg-quick` format, e.g. from your provider). IPv6 (`::/0`) is stripped from `AllowedIPs`. Set `vpn.mode` to `required` before adding torrents you want protected. The server needs a WireGuard-capable kernel (check with `./setup.sh doctor`); no `/dev/net/tun` is required. Rotation switches to the next enabled config.

**MTU.** The tunnel interface MTU is, in order: the config's own `MTU =` line (576-1500), else `VPN_MTU`, else `1280`. The default is deliberately conservative: Docker's bridge reports 1500 even when the host's real uplink is smaller (cloud VMs often 1460, PPPoE 1492, overlays less), and WireGuard's usual 1420 then black-holes full-size packets, so small requests work while bulk TCP stalls or crawls. 1280 is the IPv6 minimum MTU and a common VPN-client default; it costs roughly 10% of peak throughput versus 1420. Raise `VPN_MTU` (e.g. 1420) only if you know your path allows it. TCP MSS on the tunnel is also clamped to the interface MTU. The effective value is shown on the VPN page (`mtu` in the sidecar's `GET /status`).

**qBittorrent shows "firewalled"** (`connection_status: firewalled` in `transfer/info`): expected behind a VPN without provider port forwarding. Downloads and uploads over outbound connections work normally; only incoming peer connections are missing.

### Destinations

Admin -> Destinations creates shared destinations visible to every user. Files land in `<prefix>/<user>-<id>/<torrent name> [<8 hex of the infohash>]/...`.

**Google Drive (shared account).** The seedbox uploads to one Drive account/folder you control.

1. In Google Cloud Console create an OAuth client (type "Desktop app") and enable the Google Drive API. Use your own client; rclone's shared default client is heavily rate limited. Publish the consent screen to "In production" so the refresh token does not expire after 7 days.
2. On any machine with [rclone](https://rclone.org): `rclone config` -> new remote -> storage `drive` -> your client id and secret -> scope `drive` -> authorize in the browser. (A token with the narrower `drive.file` scope can only see folders that **this same OAuth client created**: use a folder made with that remote, e.g. `rclone mkdir remote:seedbox-root`, and take its id from `rclone lsjson`; any other folder id fails with "File not found".)
3. `rclone config show <remote>` prints a section like:

   ```
   [mydrive]
   type = drive
   client_id = ...apps.googleusercontent.com
   client_secret = ...
   scope = drive
   token = {"access_token":"...","refresh_token":"1//0g...","expiry":"..."}
   root_folder_id = 0AB...
   ```

4. In Admin -> Destinations -> New, choose type Google Drive, then paste that whole `[mydrive]` block into **Paste rclone config section**. It fills in client id, client secret, refresh token and root folder. Fields you fill in explicitly take priority. If `root_folder_id` is not in the section, enter the Drive folder id (the last part of the folder's URL) in **Root folder ID**. The same box accepts an `[remote]` block of `type = s3` for S3/B2.
5. Links: sharing the per-user folder (`sharing`) hands out Drive links and needs the recipients to have Google accounts. For account-free links deploy the **drive-proxy Cloudflare Worker** (signed URLs that stream from Drive) and enter its base URL (`proxyBaseUrl`) and signing key: see [apps/drive-proxy/README.md](../apps/drive-proxy/README.md).

**S3-compatible (AWS S3, Backblaze B2, MinIO, Cloudflare R2, ...).** Provide endpoint, region, access key id, secret, bucket and optional prefix (or paste an rclone `type = s3` section). Links are presigned (set `linkTtlSeconds`) unless you set a `publicBaseUrl` for a public bucket or CDN.

*Backblaze B2 via its S3 API:* create a bucket, then an Application Key limited to that bucket (read/write). Use endpoint `https://s3.<region>.backblazeb2.com` (the region, e.g. `us-west-004`, is shown with the bucket's endpoint), the key's `keyID` as access key id and `applicationKey` as secret. B2 presigned links are valid for at most 7 days. Tip: use a dedicated bucket or prefix for the seedbox so lifecycle rules cannot touch your other data.

**Local folder.** Stored in the `downloads` volume under `library/` and served by the gateway at `https://APP_HOST/dl/<path>?exp=&sig=` (or `https://FILES_HOST/dl/...` when a separate download host is set) with Range support. `publicBaseUrl` defaults to that host and, when set, wins over both; `linkTtlSeconds` of 0 never expires. This uses the server's disk, so mind `limits.minFreeDiskBytes`. To keep files outside Docker volumes, replace the `downloads` named volume with a bind mount in a `compose.override.yaml` (the gateway reads it as uid 101, so it must be world-readable).

## Browser integration

The Downloads page can register the app as your browser's handler for `magnet:` links, so clicking a magnet link on any site opens the seedbox with the form pre-filled.

- **Enable.** Open Downloads and press "Open magnet links with this app" (a banner the first time, a small "Browser integration" link afterwards; use it to re-register). The browser asks you to confirm. This needs HTTPS (a secure context) and the same origin as the app, which the standard deployment provides.
- **Chrome / Edge / Firefox (desktop).** A prompt appears at the address bar; choose Allow/Add. Remove or change it in the browser settings: Chrome and Edge `Settings -> Privacy and security -> Site settings -> Additional permissions -> Protocol handlers`; Firefox `Settings -> General -> Applications` (the `magnet` row).
- **Installed PWA.** The app ships a web manifest with a `magnet` protocol handler, so a Chromium browser that has the app installed ("Install docker-seedbox") also offers it for magnet links.
- **Safari and some mobile browsers** do not support this API; the page hides the button and shows a hint. Paste the link into the form instead.
- **Safety.** A magnet link only pre-fills the form (after validating it) and never starts a download by itself: you review it and press "Add download". If you are logged out, you are sent to the login page first and returned to the same link afterwards. Browsers cannot report whether the handler is registered, so the page only remembers (in `localStorage`) that you registered or dismissed the banner.
