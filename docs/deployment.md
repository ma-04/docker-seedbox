# Deployment

`./setup.sh` does everything below for you; this page explains what it chose and how to do it by hand.

## Requirements

- Linux host with Docker Engine and Compose v2 (`docker compose version`).
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

Images come from `ghcr.io/ma-04/docker-seedbox-*` (`SEEDBOX_REGISTRY`, `SEEDBOX_VERSION` in `.env`). To build from your clone instead: `./setup.sh --build` (or `docker compose build`).

## Authelia users

`deploy/authelia/users/users_database.yml` (git-ignored) is the user list. `./setup.sh add-user --admin-user alice --admin-email alice@example.com` appends one (add `--group admins` for an admin); Authelia reloads the file without a restart. Members of the `admins` group (`ADMIN_GROUP`) see the Admin pages. Password reset e-mails are not configured (the notifier writes to a file inside the `authelia` volume); admins reset passwords by editing the file with a hash from `docker run --rm authelia/authelia:4.39.28 authelia crypto hash generate argon2`. Set `AUTH_POLICY=two_factor` in `.env` to require 2FA (users then register a TOTP device; the registration link is written to `/data/notification.txt` in the `authelia` volume since no SMTP is configured).

## External SSO mode

If you already have an SSO proxy (oauth2-proxy, Authentik, Pomerium, a Cloudflare Access setup, ...):

1. In `deploy/.env` set `AUTH_MODE=external` and clear `COMPOSE_PROFILES` (this stops Authelia).
2. Your proxy must authenticate users and send `Remote-User`, `Remote-Groups` (comma-separated, containing `admins` for admins), `Remote-Email` and `Remote-Name` to the gateway for `APP_HOST`.
3. **The gateway must be reachable only from that proxy.** Do not publish its port and do not put it on a shared network with untrusted containers: in this mode anyone who can reach the gateway can claim any identity. Prefer `external` proxy mode with a dedicated network.
4. `FILES_HOST` must stay **public** (no SSO): links are protected by their signatures.
5. The gateway always sets `X-Gateway-Secret` itself, but in this mode it does **not** remove client-supplied `Remote-*` headers: your SSO proxy has to overwrite them.

## Upgrades

```sh
./setup.sh update          # pulls newer images and recreates what changed
./setup.sh update --build  # for clones: rebuild from source (git pull first)
```

Database migrations run when the API starts. Pin `SEEDBOX_VERSION=1.2.3` in `deploy/.env` to control upgrades; the default is `latest`. The Authelia, nginx-proxy and acme-companion versions are pinned in the compose files.

## Backups

Back up:

- `deploy/.env` (**`APP_SECRET` is required to decrypt stored credentials**) and `deploy/authelia/users/`.
- The `data` volume (SQLite). Stop the writers for a consistent copy:

```sh
cd deploy
docker compose stop api worker
docker run --rm -v seedbox_data:/data -v "$PWD":/backup alpine tar czf /backup/seedbox-data.tgz -C /data .
docker compose start api worker
```

- The `authelia` volume (sessions, 2FA registrations) if you use 2FA.

The `downloads` volume is transient working space; `qbt-config` holds qBittorrent settings generated on start. (`seedbox_` is the Compose project name; see `docker volume ls`.)

## Gateway notes

- Files served from the local destination live in the `downloads` volume under `library/` and are read by the gateway as uid 101: they must be world-readable (the default umask 022 is fine).
- Gateway access logs on the files host omit query strings.
- The gateway needs Docker's embedded DNS (`127.0.0.11`), i.e. the default bridge network of Compose.

## Troubleshooting

`./setup.sh doctor` first. Typical problems: DNS not propagated; ports 80/443 busy (use `external` mode); no WireGuard kernel support in an LXC/VPS container; cookie domain not a parent of both hosts; plain-http access in `none` mode.
