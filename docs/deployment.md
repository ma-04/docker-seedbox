# Deployment

`./setup.sh` does everything below for you; this page explains what it chose and how to do it by hand.

## Requirements

- Linux host with Docker Engine **26+** and Compose **2.26+** (`docker compose version`; needed for volume subpaths, see [Volumes](#volumes)). `./setup.sh` and `doctor` check.
- For the VPN: a WireGuard-capable kernel (5.6+ has it built in; the sidecar needs `NET_ADMIN` but no `/dev/net/tun`). `./setup.sh doctor` checks for the kernel module.
- Three DNS names. `seedbox.example.com` is used below:

| Record | Purpose |
|---|---|
| `seedbox.example.com` (`APP_HOST`) | web UI and `/api` |
| `auth.seedbox.example.com` (`AUTH_HOST`) | Authelia login portal |
| `files.seedbox.example.com` (`FILES_HOST`) | local-folder downloads (signed links, no login) |

All three point at the server. `COOKIE_DOMAIN` must be a parent of both `APP_HOST` and `AUTH_HOST` (default: the app domain).

## The three proxy modes

`setup.sh` writes `COMPOSE_FILE=compose.yaml:compose.proxy-<mode>.yaml` into `deploy/.env`, so a plain `docker compose up -d` run inside `deploy/` keeps using your choice.

### 1. `bundled` - fresh server

Ships [nginx-proxy](https://github.com/nginx-proxy/nginx-proxy) + [acme-companion](https://github.com/nginx-proxy/acme-companion): ports 80/443, automatic Let's Encrypt certificates for all three hosts. Ports 80 and 443 must be free and reachable from the internet. nginx-proxy and acme-companion mount the Docker socket (that is effectively root on the host, and `:ro` does not limit the API); this is the only place the stack does. If you do not want that, use `external` or `none` mode.

```sh
./setup.sh --domain seedbox.example.com --proxy bundled --acme-email me@example.com
```

### 2. `external` - you already run a proxy

Set `PROXY_NETWORK` to the Docker network your proxy uses and the gateway joins it.

**nginx-proxy / acme-companion** (detected automatically by `setup.sh`): the gateway carries `VIRTUAL_HOST`, `VIRTUAL_PORT=8080` and `LETSENCRYPT_HOST`, so certificates and routing appear on their own. Two things to configure on that proxy:

- Uploads: nginx-proxy limits bodies to 1m; `.torrent` uploads need more. Add `client_max_body_size 10m;` for the app host, e.g. a file `vhost.d/seedbox.example.com` containing that line (or a global `conf.d` file).
- Streaming: the gateway sends `X-Accel-Buffering: no` for `/api/events` and downloads, which nginx honours. Raising `proxy_read_timeout` for the app host (e.g. `3600s`) keeps live updates from reconnecting.

**Traefik**: attach Traefik to `PROXY_NETWORK` and add labels to the gateway in a `compose.override.yaml`:

```yaml
services:
  gateway:
    labels:
      - traefik.enable=true
      - traefik.docker.network=PROXY_NETWORK
      - traefik.http.routers.seedbox.rule=Host(`seedbox.example.com`) || Host(`auth.seedbox.example.com`) || Host(`files.seedbox.example.com`)
      - traefik.http.routers.seedbox.entrypoints=websecure
      - traefik.http.routers.seedbox.tls.certresolver=letsencrypt
      - traefik.http.services.seedbox.loadbalancer.server.port=8080
```

**Caddy**: put Caddy on the same network and use

```
seedbox.example.com, auth.seedbox.example.com, files.seedbox.example.com {
    reverse_proxy gateway:8080 {
        flush_interval -1
    }
}
```

Whatever the proxy, it must preserve the `Host` header, set `X-Forwarded-Proto: https`, and (if it is Traefik/Caddy) allow request bodies of at least 10 MB.

### 3. `none` - TLS terminated elsewhere

Publishes the gateway on `${HTTP_BIND:-127.0.0.1}:${HTTP_PORT:-8080}`. Use it behind a Cloudflare Tunnel or a proxy on another machine.

**Authelia's session cookie is `Secure`: users must reach `APP_HOST` and `AUTH_HOST` over https**, and the outer proxy must send `X-Forwarded-Proto: https` (Cloudflare does). Without TLS, login redirects fail (Authelia refuses to act on `http://` URLs). With Cloudflare Tunnel, add the three hostnames as public hostnames pointing at `http://localhost:8080` and do **not** override the HTTP Host header; the gateway routes by it. Set `HTTP_BIND=0.0.0.0` only if the proxy is on another machine and a firewall protects the port.

## First start

```sh
cd deploy && docker compose up -d      # setup.sh already did this
docker compose ps                      # everything should become healthy
```

Images come from `ghcr.io/ma-04/docker-seedbox-*` (`SEEDBOX_REGISTRY`, `SEEDBOX_VERSION` in `.env`; see [Versions](#versions-upgrades-and-verification)). To build from your clone instead: `./setup.sh --build` (or `docker compose build`). With no published release yet, `./setup.sh` offers exactly that.

## Authelia users

`deploy/authelia/users/users_database.yml` (git-ignored) is the user list. `./setup.sh add-user --admin-user alice --admin-email alice@example.com` appends one (add `--group admins` for an admin); Authelia reloads the file without a restart. Members of the `admins` group (`ADMIN_GROUP`) see the Admin pages. Password reset e-mails are not configured (the notifier writes to a file inside the `authelia` volume); admins reset passwords by editing the file with a hash from `docker run --rm authelia/authelia:4.39.28 authelia crypto hash generate argon2`. Set `AUTH_POLICY=two_factor` in `.env` to require 2FA (users then register a TOTP device; the registration link is written to `/data/notification.txt` in the `authelia` volume since no SMTP is configured).

## External SSO mode

If you already have an SSO proxy (oauth2-proxy, Authentik, Pomerium, a Cloudflare Access setup, ...):

1. In `deploy/.env` set `AUTH_MODE=external` and clear `COMPOSE_PROFILES` (this stops Authelia).
2. Your proxy must authenticate users and send `Remote-User`, `Remote-Groups` (comma-separated, containing `admins` for admins), `Remote-Email` and `Remote-Name` to the gateway for `APP_HOST`.
3. **The gateway must be reachable only from that proxy.** Do not publish its port and do not put it on a shared network with untrusted containers: in this mode anyone who can reach the gateway can claim any identity. Prefer `external` proxy mode with a dedicated network.
4. `FILES_HOST` must stay **public** (no SSO): links are protected by their signatures.
5. The gateway always sets `X-Gateway-Secret` itself, but in this mode it does **not** remove client-supplied `Remote-*` headers: your SSO proxy has to overwrite them.
6. `setup.sh` refuses `AUTH_MODE=external` together with the bundled proxy (it publishes the gateway on 80/443 with nothing authenticating): use `--proxy external` or `--proxy none`, or pass `--i-know-external-auth-is-unsafe` if something else really guarantees that only your SSO can reach the gateway. `./setup.sh doctor` flags the combination.

## Versions, upgrades and verification

Images are published to `ghcr.io/ma-04/docker-seedbox-{api,web,gateway,vpn,qbittorrent}` by the release workflow
([releasing.md](releasing.md)):

| Tag | What it is |
|---|---|
| `1.2.3` | an exact release: pin this in production |
| `1.2` | the newest `1.2.x` release |
| `latest` | the newest non-prerelease release |
| `1.3.0-rc.1` | a pre-release (never moves `1.3` or `latest`) |
| `edge` | the head of `main`, published only after the whole CI suite passed; for trying things, not for production |

`./setup.sh` pins `SEEDBOX_VERSION` in `deploy/.env` to the newest release when it installs. While no release is
published yet (or the registry has no images for the version), it says so and builds the images from your clone
instead (`SEEDBOX_VERSION=local`); with `--yes` it does that without asking.

```sh
./setup.sh update                      # newest release; prints "Update: 1.2.3 -> 1.3.0" and what is running now
./setup.sh update --version 1.2.4      # pin a specific version (also how you roll forward one step at a time)
./setup.sh update --build              # clones: rebuild from the checked-out source (git pull first)
./setup.sh backup                      # before a major upgrade
```

`update` refuses to move to an older version (database migrations run when the API starts and are not reversible):
restore a backup taken before the upgrade, then pass `--allow-downgrade`. The Authelia, nginx-proxy and
acme-companion images, and every base image, are pinned by digest in the compose files and Dockerfiles; Dependabot
proposes updates to them.

**Verifying an image.** Every published image carries a signed build-provenance attestation (SLSA, via GitHub
artifact attestations) and an SBOM. With the [GitHub CLI](https://cli.github.com/):

```sh
gh attestation verify oci://ghcr.io/ma-04/docker-seedbox-api:1.2.3 --repo ma-04/docker-seedbox
# or the whole set of a release:
for i in api web gateway vpn qbittorrent; do gh attestation verify "oci://ghcr.io/ma-04/docker-seedbox-$i:1.2.3" --repo ma-04/docker-seedbox || break; done
```

A successful run proves the image was built by this repository's release workflow (from a release tag, or from `main` for `:edge`), not pushed by hand.
`docker buildx imagetools inspect ghcr.io/ma-04/docker-seedbox-api:1.2.3 --format '{{ json .SBOM }}'` prints the SBOM.
Use the digest (`@sha256:...`) printed by `docker compose images` or the workflow summary if you want to pin by content.

## Backups

```sh
./setup.sh backup                      # -> ./seedbox-backup-<time>.tar.gz (mode 600); --out FILE_OR_DIR to choose
./setup.sh restore seedbox-backup-20260101-120000.tar.gz     # asks first; --yes to skip the question
```

`backup` stops `api`, `worker` and `authelia` for a consistent copy of SQLite (seconds for a normal database),
archives `deploy/.env`, `deploy/authelia/users/`, the `data` volume and the `authelia` volume (sessions, 2FA
registrations), and starts them again. **The archive contains `APP_SECRET` and every other secret**: store it
somewhere private and off this server. `restore` replaces those four things (the current `.env` and users file are
kept as `*.pre-restore-<time>`), then starts the stack. It also works onto a fresh server: clone the repository, run
`./setup.sh restore FILE`.

Not backed up, on purpose: the `downloads` volume is transient working space (`incomplete/` is in-flight torrents,
`library/` the files of the local destination, which you can re-download or re-deliver), and `qbt-config` is
regenerated on start.

**Without `APP_SECRET` the database is unreadable** (destination credentials, VPN configs and torrent sources are
encrypted with it). `setup.sh` keeps a short, non-secret fingerprint of the secret inside the `data` volume: if
`deploy/.env` is lost or edited so that its `APP_SECRET` no longer matches the database, `install` and `update`
stop with an explanation and `doctor` reports it. If the secret is truly gone, `--accept-new-secret` continues with a
new one and you re-enter credentials in the Admin UI.

By hand (same result): `docker compose stop api worker authelia`, then
`docker run --rm -v seedbox_data:/v:ro -v "$PWD":/b busybox tar cf /b/data.tar -C /v .`, copy `.env` and
`authelia/users/`, `docker compose start api worker authelia`. (`seedbox_` is the Compose project name; see
`docker volume ls`.)

## Volumes

| Volume | Mounted by | Holds |
|---|---|---|
| `data` | api, worker | SQLite database, the APP_SECRET fingerprint |
| `downloads` | worker (whole volume); qbittorrent (`incomplete/` only); gateway (`library/`, read-only); api (`library/` only, for the local-destination test) | in-flight torrents (`incomplete/<infohash>`), delivered files for the local destination (`library/`) |
| `authelia` | authelia | Authelia sessions, SQLite, `notification.txt` |
| `qbt-config` | qbittorrent | qBittorrent settings |

qBittorrent runs in the VPN namespace and parses untrusted input from the internet, so it only sees `incomplete/`:
a compromised qBittorrent cannot read or tamper with other users' delivered files. This uses Compose
`volume.subpath` (Docker Engine 26+, Compose 2.26+; `setup.sh` and `doctor` check). The one-shot `init` service
creates the subfolders (they must exist before the containers start) and fixes ownership. Because the worker sees
the whole volume, moving a finished download from `incomplete/` to `library/` stays a rename on one filesystem.

**Upgrading from a version where qBittorrent mounted the whole volume:** nothing to migrate. The data was always in
`incomplete/` inside the same volume; qBittorrent now simply sees that folder as `/downloads/incomplete`.

## Gateway notes

- Files served from the local destination live in the `downloads` volume under `library/` and are read by the gateway (read-only, `library/` subpath only) as uid 101: they must be world-readable (the default umask 022 is fine).
- Gateway access logs (all three hosts) omit query strings, so magnet links, signatures and `rd=` redirect targets are not written to them. nginx's *error* log still prints the request line of failed requests: keep container log retention short (the compose files already rotate at 3 x 10 MB).
- The gateway needs Docker's embedded DNS (`127.0.0.11`), i.e. the default bridge network of Compose.

## Troubleshooting

`./setup.sh doctor` first. Typical problems: DNS not propagated; ports 80/443 busy (use `external` mode); no WireGuard kernel support in an LXC/VPS container; cookie domain not a parent of both hosts; plain-http access in `none` mode.

**Downloads stall or crawl only when the VPN is on** (small requests work, large transfers hang): a path-MTU problem. Set `VPN_MTU` in `deploy/.env` lower than the default 1280 (try 1200, then 1100), then `docker compose up -d vpn` (a config's own `MTU =` line overrides `VPN_MTU`). See [configuration.md](configuration.md#vpn).
