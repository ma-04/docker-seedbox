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
| `APP_HOST`, `AUTH_HOST`, `FILES_HOST` | gateway, api, authelia | Hostnames without scheme: web UI, login portal, local downloads. |
| `COOKIE_DOMAIN` | authelia | Parent domain of `APP_HOST` and `AUTH_HOST`. |
| `PUBLIC_SCHEME` | api | `https`. Only change for local experiments over plain http. |
| `AUTH_MODE` | gateway | `authelia` (default) or `external` ([external SSO](deployment.md#external-sso-mode)). |
| `ADMIN_GROUP` | api | `admins`. Users in this group are admins. |
| `DATA_DIR` | api, worker | `/data` (fixed in compose; SQLite at `$DATA_DIR/seedbox.db`). |
| `DOWNLOADS_DIR` | api, worker | `/downloads` (fixed in compose; `incomplete/`, `library/`). |
| `QBT_URL` | worker | `http://vpn:8080` (fixed in compose). |
| `VPN_URL` | api, worker | `http://vpn:8000` (fixed in compose). |
| `PORT` | api | `3000` (fixed in compose). |
| `VPN_DEFAULT_MODE` | vpn | `required` (default, fail closed) or `off`. Mode of the VPN sidecar after every (re)start, until the worker applies the admin's `vpn.mode` (within seconds). |
| `API_IP`, `WORKER_IP` | compose | Static addresses of `api`/`worker` inside `LAN_CIDRS` (defaults `172.31.250.250`/`.251`). They are the only addresses allowed to use qBittorrent's WebUI without a password; change them together with `LAN_CIDRS`. |
| `LAN_CIDRS` | vpn, qbittorrent | Subnet of the internal network, default `172.31.250.0/24`. Change it only if it collides with another Docker network or your LAN. |
| `LOG_LEVEL` | all | `info`. |

### Deployment variables (compose / setup.sh)

| Var | Default | Meaning |
|---|---|---|
| `COMPOSE_FILE` | `compose.yaml:compose.proxy-<mode>.yaml` | Selects the proxy mode. |
| `COMPOSE_PROFILES` | `authelia` | Starts Authelia; empty for `AUTH_MODE=external`. |
| `COMPOSE_PROJECT_NAME` | `seedbox` | Prefix of containers, network and volumes. |
| `SEEDBOX_REGISTRY` | `ghcr.io/ma-04` | Registry/owner of the prebuilt images. |
| `SEEDBOX_VERSION` | `latest` | Image tag. |
| `AUTH_POLICY` | `one_factor` | Authelia policy for the app host; `two_factor` requires TOTP. |
| `AUTHELIA_SESSION_SECRET`, `AUTHELIA_STORAGE_ENCRYPTION_KEY`, `AUTHELIA_JWT_SECRET` | generated | Authelia secrets (session, SQLite encryption, password-reset tokens). |
| `ACME_EMAIL` | empty | Let's Encrypt contact (bundled/external nginx-proxy). |
| `PROXY_NETWORK` | empty | External mode: Docker network of your proxy. |
| `HTTP_BIND`, `HTTP_PORT` | `127.0.0.1`, `8080` | None mode: where the gateway is published. |

`setup.sh` also reads `SEEDBOX_DOMAIN`, `SEEDBOX_ADMIN_USER`, `SEEDBOX_ADMIN_PASSWORD`, `SEEDBOX_ADMIN_EMAIL`, `SEEDBOX_PROXY`, `SEEDBOX_PROXY_NETWORK`, `SEEDBOX_ACME_EMAIL`, `SEEDBOX_BUILD`, `SEEDBOX_YES` as alternatives to its flags (`./setup.sh --help`).

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
| `google.oauthClientId` / `google.oauthClientSecret` | unset | Reserved for the planned per-user Google Drive connect (not a supported feature yet). |

### VPN

Admin -> VPN: paste or upload one or more WireGuard configs (`wg-quick` format, e.g. from your provider). IPv6 (`::/0`) is stripped from `AllowedIPs`. Set `vpn.mode` to `required` before adding torrents you want protected. The server needs `/dev/net/tun` (check with `./setup.sh doctor`). Rotation switches to the next enabled config.

### Destinations

Admin -> Destinations creates shared destinations visible to every user. Files land in `<prefix>/<user>-<id>/<torrent name> [<8 hex of the infohash>]/...`.

**Google Drive (shared account).** The seedbox uploads to one Drive account/folder you control.

1. In Google Cloud Console create an OAuth client (type "Desktop app") and enable the Google Drive API. Use your own client; rclone's shared default client is heavily rate limited. Publish the consent screen to "In production" so the refresh token does not expire after 7 days.
2. On any machine with [rclone](https://rclone.org): `rclone config` -> new remote -> storage `drive` -> your client id and secret -> scope `drive` -> authorize in the browser.
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

**Local folder.** Stored in the `downloads` volume under `library/` and served by the gateway at `https://FILES_HOST/dl/<path>?exp=&sig=` with Range support. `publicBaseUrl` defaults to `https://FILES_HOST`; `linkTtlSeconds` of 0 never expires. This uses the server's disk, so mind `limits.minFreeDiskBytes`. To keep files outside Docker volumes, replace the `downloads` named volume with a bind mount in a `compose.override.yaml` (the gateway reads it as uid 101, so it must be world-readable).
