# Deployment

`./setup.sh` does everything below for you; this page explains what it chose and how to do it by hand.

## Requirements

- Linux host with Docker Engine **26+** and Compose **2.26+** (`docker compose version`; needed for volume subpaths, see [Volumes](#volumes)). `./setup.sh` and `doctor` check.
- For the VPN: a WireGuard-capable kernel (5.6+ has it built in; the sidecar needs `NET_ADMIN` but no `/dev/net/tun`). `./setup.sh doctor` checks for the kernel module.
- One DNS name pointing at the server (`seedbox.example.com` below). Optionally a second one for downloads, see
  [Hosts layout](#hosts-layout).

## Hosts layout

By default everything lives on **one** hostname, `APP_HOST`:

| URL | What | Login |
|---|---|---|
| `https://seedbox.example.com/` | web UI | yes (redirects to the portal) |
| `https://seedbox.example.com/api/` | API | yes (a bare `401` without a session) |
| `https://seedbox.example.com/auth/` | Authelia login portal | no (it *is* the login) |
| `https://seedbox.example.com/dl/...?exp=&sig=` | local-folder downloads | no, the signed link is the credential |

Two independent options, each one more DNS record pointing at the server:

| `.env` | Effect |
|---|---|
| `FILES_HOST=dl.example.net` | Local downloads move to `https://dl.example.net/dl/...`; `/dl/` on `APP_HOST` answers 404. **Recommended hardening**: downloaded files (user-supplied content) then never share the app's origin, see [SECURITY.md](../SECURITY.md) ("Hosts and origins"). Pick a host **outside** `COOKIE_DOMAIN` (ideally a different registrable domain) so the browser does not even send the login cookie there. `./setup.sh --files-host dl.example.net`. |
| `AUTH_HOST=auth.seedbox.example.com` | The portal moves to its own host (served at `/`), with `COOKIE_DOMAIN` a parent of both hosts. This is the layout every install had before single-domain support; there is little reason to choose it for a new one. `./setup.sh --auth-host auth.seedbox.example.com`. |

Empty means "on `APP_HOST`" (a value equal to `APP_HOST` means the same, but leave it empty: it would be listed twice for the proxy; `setup.sh` empties it). Host values are trimmed and lowercased by every component. With the portal on `APP_HOST` the login cookie is always scoped to `APP_HOST`, whatever `COOKIE_DOMAIN` says; with a separate `AUTH_HOST`, `COOKIE_DOMAIN` is required (a parent of both) and Authelia refuses to start without it. With `AUTH_MODE=external` there is no portal and `AUTH_HOST` is ignored. The gateway, Authelia and
the API all derive their layout from these variables, so `deploy/.env` is the only place to change it (then
`cd deploy && docker compose up -d`, or re-run `./setup.sh`, which also updates the DNS list it prints).

**Existing three-host installs** (`AUTH_HOST` and `FILES_HOST` set) keep working unchanged after `./setup.sh update`:
the gateway renders the same three server blocks and Authelia gets byte-identical settings. Differences: `/dl/` on
`APP_HOST` now answers 404 instead of falling through to the SPA, the portal host no longer forwards client-supplied
`Remote-*` headers to Authelia, and `/dl/` no longer forwards the browser's `Cookie`/`Authorization` to the API. To move
to one domain: `./setup.sh --single-domain` (or empty `AUTH_HOST`/`FILES_HOST` by hand: the cookie then follows `APP_HOST` on its own),
`docker compose up -d`. Everyone has to log in once more (the cookie's domain changes), links already handed out on the
old files host stop working (create them again from the Files panel), and the old DNS records can go once nothing uses
them. Keep `FILES_HOST` if you want the origin isolation.

### How the portal works under `/auth/` (Authelia 4.39)

Sources: Authelia's [server](https://www.authelia.com/configuration/miscellaneous/server/) and
[session](https://www.authelia.com/configuration/session/introduction/) configuration docs, the
[NGINX integration guide](https://www.authelia.com/integration/proxies/nginx/), and the v4.39.28 source
([`StripPath`](https://github.com/authelia/authelia/blob/v4.39.28/internal/middlewares/strip_path.go),
[server address validation](https://github.com/authelia/authelia/blob/v4.39.28/internal/configuration/validator/server.go),
[session validation](https://github.com/authelia/authelia/blob/v4.39.28/internal/configuration/validator/session.go),
[authz redirect](https://github.com/authelia/authelia/blob/v4.39.28/internal/handlers/handler_authz.go),
[`PathPrefix` integration suite](https://github.com/authelia/authelia/tree/v4.39.28/internal/suites/PathPrefix)).

- **Subpath:** `server.address: 'tcp://:9091/auth'`. The path must be **one** alphanumeric segment without a trailing
  slash (`/auth/` or `/my/auth` fail validation), so it is fixed to `/auth`. Authelia strips the prefix itself and keeps
  answering on `/` as well, so the proxy passes `/auth/...` through **unchanged** (stripping it breaks the portal's base
  URL) and the internal authz call keeps using `/api/authz/auth-request` at the root. The portal's assets, its API
  (`/auth/api/...`) and its pages are all below `/auth/`; it uses no websockets.
- **Same-host session cookie:** `session.cookies[].domain` may equal the host in `authelia_url`
  (`authelia_url: 'https://APP_HOST/auth/'`, a path is allowed and gets a trailing slash). The domain must contain a
  dot or be an IP address and must not be on the public suffix list, so a bare `localhost` or a single-label name cannot
  work, and a name directly under a public suffix (`example.duckdns.org`) only works as its own cookie domain. TLS is
  required. `default_redirection_url` must differ from `authelia_url` (`https://APP_HOST` vs `https://APP_HOST/auth/`).
  The cookie is `Path=/`, `HttpOnly`, `Secure`, `SameSite=Lax`, and with the domain set to `APP_HOST` it is also sent
  to subdomains of `APP_HOST`.
- **Redirect flow:** for nginx `auth_request` Authelia's AuthRequest endpoint always answers `401` and puts the portal URL
  in `Location`: `https://APP_HOST/auth/?rd=<full original URL, query included>&rm=<method>`. The gateway turns that into a
  `302` for pages only; `/api/*` uses the same check without the `error_page`, so XHRs get a bare `401`. `rd` must lie
  inside the cookie domain, which with `domain = APP_HOST` limits post-login redirects to the app itself. Logout is
  `https://APP_HOST/auth/logout`. Links Authelia writes itself (2FA registration / password reset, here into
  `notification.txt`) and, if OIDC is enabled one day, its issuer are built from `X-Forwarded-Proto`/`-Host` plus the
  base path, i.e. `https://APP_HOST/auth/...`; the gateway sets those headers.

## The three proxy modes

`setup.sh` writes `COMPOSE_FILE=compose.yaml:compose.proxy-<mode>.yaml` into `deploy/.env`, so a plain `docker compose up -d` run inside `deploy/` keeps using your choice.

### 1. `bundled` - fresh server

Ships [nginx-proxy](https://github.com/nginx-proxy/nginx-proxy) + [acme-companion](https://github.com/nginx-proxy/acme-companion): ports 80/443, automatic Let's Encrypt certificates for every host in use (`VIRTUAL_HOST`/`LETSENCRYPT_HOST` list exactly those). Ports 80 and 443 must be free and reachable from the internet. nginx-proxy and acme-companion mount the Docker socket (that is effectively root on the host, and `:ro` does not limit the API); this is the only place the stack does. If you do not want that, use `external` or `none` mode.

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
      - traefik.http.routers.seedbox.rule=Host(`seedbox.example.com`)   # || Host(`dl.example.net`) etc. for separate hosts
      - traefik.http.routers.seedbox.entrypoints=websecure
      - traefik.http.routers.seedbox.tls.certresolver=letsencrypt
      - traefik.http.services.seedbox.loadbalancer.server.port=8080
```

**Caddy**: put Caddy on the same network and use

```
seedbox.example.com {                # add separate hosts, if any: seedbox.example.com, dl.example.net {
    reverse_proxy gateway:8080 {
        flush_interval -1
    }
}
```

Whatever the proxy, it must preserve the `Host` header, set `X-Forwarded-Proto: https`, and (if it is Traefik/Caddy) allow request bodies of at least 10 MB.

### 3. `none` - TLS terminated elsewhere

Publishes the gateway on `${HTTP_BIND:-127.0.0.1}:${HTTP_PORT:-8080}`. Use it behind a Cloudflare Tunnel or a proxy on another machine.

**Authelia's session cookie is `Secure`: users must reach `APP_HOST` (and `AUTH_HOST`, if separate) over https**, and the outer proxy must send `X-Forwarded-Proto: https` (Cloudflare does). Without TLS, login redirects fail (Authelia refuses to act on `http://` URLs). With Cloudflare Tunnel, add `APP_HOST` (and any separate host) as a public hostname pointing at `http://localhost:8080` and do **not** override the HTTP Host header; the gateway routes by it. Set `HTTP_BIND=0.0.0.0` only if the proxy is on another machine and a firewall protects the port.

## First start

```sh
cd deploy && docker compose up -d      # setup.sh already did this
docker compose ps                      # everything should become healthy
```

Images come from `ghcr.io/ma-04/docker-seedbox-*` (`SEEDBOX_REGISTRY`, `SEEDBOX_VERSION` in `.env`; see [Versions](#versions-upgrades-and-verification)). To build from your clone instead: `./setup.sh --build` (or `docker compose build`). With neither a release nor `edge` published, `./setup.sh` offers exactly that.

## Authelia users

`deploy/authelia/users/users_database.yml` (git-ignored) is the user list. `./setup.sh add-user --admin-user alice --admin-email alice@example.com` appends one (add `--group admins` for an admin); Authelia reloads the file without a restart. Members of the `admins` group (`ADMIN_GROUP`) see the Admin pages. Password reset e-mails are not configured (the notifier writes to a file inside the `authelia` volume); admins reset passwords by editing the file with a hash from `docker run --rm authelia/authelia:4.39.28 authelia crypto hash generate argon2`. Set `AUTH_POLICY=two_factor` in `.env` to require 2FA (users then register a TOTP device; the registration link is written to `/data/notification.txt` in the `authelia` volume since no SMTP is configured).

## External SSO mode

If you already have an SSO proxy (oauth2-proxy, Authentik, Pomerium, a Cloudflare Access setup, ...):

1. In `deploy/.env` set `AUTH_MODE=external` and clear `COMPOSE_PROFILES` (this stops Authelia).
2. Your proxy must authenticate users and send `Remote-User`, `Remote-Groups` (comma-separated, containing `admins` for admins), `Remote-Email` and `Remote-Name` to the gateway for `APP_HOST`. There is no `/auth/` portal in this mode (a set `AUTH_HOST` is ignored); set `LOGOUT_URL` to your SSO's sign-out page to get a "Log out" link in the web UI.
3. **The gateway must be reachable only from that proxy.** Do not publish its port and do not put it on a shared network with untrusted containers: in this mode anyone who can reach the gateway can claim any identity. Prefer `external` proxy mode with a dedicated network.
4. Downloads must stay **public** (no SSO): links are protected by their signatures. With the default layout that means your proxy must let `https://APP_HOST/dl/...` through without a login (or set a separate `FILES_HOST` and leave that host public).
5. The gateway always sets `X-Gateway-Secret` itself, but in this mode it does **not** remove client-supplied `Remote-*` headers: your SSO proxy has to overwrite them.
6. `setup.sh` refuses `AUTH_MODE=external` together with the bundled proxy (it publishes the gateway on 80/443 with nothing authenticating): use `--proxy external` or `--proxy none`, or pass `--i-know-external-auth-is-unsafe` if something else really guarantees that only your SSO can reach the gateway. `./setup.sh doctor` flags the combination.

## Versions, upgrades and verification

Images are published to `ghcr.io/ma-04/docker-seedbox-{api,web,gateway,vpn,qbittorrent}` by the release workflow
([releasing.md](releasing.md)):

| Tag | What it is |
|---|---|
| `1.2.3` | an exact release (git tag `v1.2.3`): pin this in production. Never moved. |
| `1.2` | the newest `1.2.x` release |
| `1` | the newest `1.x.y` release (not published for `0.x`, where every minor may break) |
| `latest` | the newest stable release (the highest version, not the most recently built one; never a pre-release) |
| `1.3.0-rc.1` | a pre-release (never moves `1.3`, `1` or `latest`) |
| `edge` | the head of `main`, published after the whole CI suite passed; for trying things, not for production |
| `sha-abc1234` | the `main` build of commit `abc1234` (what `edge` pointed at then); never moved |

**Architectures.** Every tag is a multi-arch image for `linux/amd64` and `linux/arm64`; Docker pulls the right one
automatically. Both are built natively (no emulation) and smoke-tested on their own architecture before anything is
tagged; for releases the VPN kill-switch test and the full end-to-end suite also run on arm64
([releasing.md](releasing.md)). What CI proves is GitHub's arm64 runner: Ubuntu 24.04 on an Azure arm64 VM (`ubuntu-24.04-arm`).
Other 64-bit ARM Linux hosts, such as a Raspberry Pi 4/5 or another board with a **64-bit** OS, or an
Ampere / Graviton cloud server, are expected to work the same way but are not tested. They need a kernel with WireGuard
(Linux 5.6+, built in or as a module) and nftables; `./setup.sh doctor` checks for WireGuard. 32-bit ARM (`armv7`) is
not built. Docker Desktop on Apple Silicon can pull the arm64 images, but it is not a supported or tested deployment
host (the VPN needs the host kernel's WireGuard and nftables).

`./setup.sh` pins `SEEDBOX_VERSION` in `deploy/.env` to the newest release (as its exact `X.Y.Z`) when it installs.
While no release is published yet it uses `edge` instead and says so; if `edge` is not in the registry either (or
the registry is unreachable), it builds the images from your clone (`SEEDBOX_VERSION=local`; with `--yes` without
asking).

```sh
./setup.sh update                      # newest release; prints "Update: 1.2.3 -> 1.3.0" and what is running now
./setup.sh update --version 1.2.4      # pin a specific version (also how you roll forward one step at a time)
./setup.sh update --version latest     # resolve the newest release now and pin it (also: leave edge for a release)
./setup.sh update --version edge       # follow main; a plain `update` then stays on edge and pulls its newest build
./setup.sh update --build              # clones: rebuild from the checked-out source (git pull first)
./setup.sh backup                      # before a major upgrade
```

`update` refuses to move to an older version (database migrations run when the API starts and are not reversible):
restore a backup taken before the upgrade, then pass `--allow-downgrade`. The Authelia, nginx-proxy and
acme-companion images, and every base image, are pinned by digest in the compose files and Dockerfiles; Dependabot
proposes updates to them.

**Verifying an image.** Every published image carries a signed build-provenance attestation for its multi-arch
digest (SLSA, via GitHub artifact attestations), and each architecture inside it carries an SBOM and BuildKit's own
provenance. With the [GitHub CLI](https://cli.github.com/):

```sh
gh attestation verify oci://ghcr.io/ma-04/docker-seedbox-api:1.2.3 --repo ma-04/docker-seedbox
# or the whole set of a release:
for i in api web gateway vpn qbittorrent; do gh attestation verify "oci://ghcr.io/ma-04/docker-seedbox-$i:1.2.3" --repo ma-04/docker-seedbox || break; done
```

A successful run proves the image was built by this repository's release workflow (from a release tag, or from `main` for `:edge`), not pushed by hand.
`docker buildx imagetools inspect ghcr.io/ma-04/docker-seedbox-api:1.2.3 --format '{{ json .SBOM }}'` prints the SBOMs
(one per architecture). The GitHub Release of each version lists the digest (`@sha256:...`) of every image if you
want to pin by content; the same digest works on amd64 and arm64.

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
| `jackett-config` | jackett (search profile only) | Jackett's settings, configured indexers (including private-tracker credentials) and API key |

qBittorrent runs in the VPN namespace and parses untrusted input from the internet, so it only sees `incomplete/`:
a compromised qBittorrent cannot read or tamper with other users' delivered files. This uses Compose
`volume.subpath` (Docker Engine 26+, Compose 2.26+; `setup.sh` and `doctor` check). The one-shot `init` service
creates the subfolders (they must exist before the containers start) and fixes ownership. Because the worker sees
the whole volume, moving a finished download from `incomplete/` to `library/` stays a rename on one filesystem.

**Upgrading from a version where qBittorrent mounted the whole volume:** nothing to migrate. The data was always in
`incomplete/` inside the same volume; qBittorrent now simply sees that folder as `/downloads/incomplete`.

## Gateway notes

- Files served from the local destination live in the `downloads` volume under `library/` and are read by the gateway (read-only, `library/` subpath only) as uid 101: they must be world-readable (the default umask 022 is fine).
- Gateway access logs (every host) omit query strings, so magnet links, signatures and `rd=` redirect targets are not written to them. nginx's *error* log still prints the request line of failed requests: keep container log retention short (the compose files already rotate at 3 x 10 MB).
- The gateway needs Docker's embedded DNS (`127.0.0.11`), i.e. the default bridge network of Compose.

## Troubleshooting

`./setup.sh doctor` first. Typical problems: DNS not propagated; ports 80/443 busy (use `external` mode); no WireGuard kernel support in an LXC/VPS container; with a separate `AUTH_HOST`, a cookie domain that is not a parent of both hosts; plain-http access in `none` mode; an outer proxy or tunnel that strips the `/auth/` prefix (it must pass paths unchanged).

**Downloads stall or crawl only when the VPN is on** (small requests work, large transfers hang): a path-MTU problem. Set `VPN_MTU` in `deploy/.env` lower than the default 1280 (try 1200, then 1100), then `docker compose up -d vpn` (a config's own `MTU =` line overrides `VPN_MTU`). See [configuration.md](configuration.md#vpn).
