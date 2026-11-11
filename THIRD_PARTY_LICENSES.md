# Third-party licenses

docker-seedbox is AGPL-3.0-only (see [LICENSE](LICENSE) and [NOTICE](NOTICE)). The container images it publishes
contain the third-party software below. Each keeps its own license; the full license texts are inside the images
(for Alpine and Debian packages under `/usr/share/licenses` or `/usr/share/doc/<package>/copyright`) and at the
source links. Package-level detail for every image is in its SBOM, which the release workflow attaches to the image
(`docker buildx imagetools inspect ghcr.io/<owner>/docker-seedbox-<name>:<tag> --format '{{ json .SBOM }}'`).

"Source" below is where the corresponding source of the exact version can be obtained. For distribution packages
that is the distribution's source package (`apk fetch -s <pkg>` on Alpine, `apt-get source <pkg>` on Debian).

## Images published by this project

| Image | Base | Built from |
|---|---|---|
| `docker-seedbox-api` (api and worker) | `node:22-bookworm-slim` (Debian) | `apps/api/Dockerfile` |
| `docker-seedbox-web` | `nginxinc/nginx-unprivileged` (Alpine) | `apps/web/Dockerfile` |
| `docker-seedbox-gateway` | `nginxinc/nginx-unprivileged` (Alpine) | `services/gateway/Dockerfile` |
| `docker-seedbox-vpn` | `alpine` | `services/vpn/Dockerfile` |
| `docker-seedbox-qbittorrent` | `qbittorrentofficial/qbittorrent-nox` | `services/qbittorrent/Dockerfile` |

The base image digests are pinned in the Dockerfiles; Dependabot proposes updates.

## Redistributed components

| Component | Image(s) | License | Source |
|---|---|---|---|
| qBittorrent-nox | qbittorrent | GPL-2.0-or-later (with an OpenSSL linking exception) | https://github.com/qbittorrent/qBittorrent |
| libtorrent-rasterbar (statically part of qBittorrent-nox) | qbittorrent | BSD-3-Clause | https://github.com/arvidn/libtorrent |
| Qt, Boost, OpenSSL, zlib and the other libraries linked into qBittorrent-nox | qbittorrent | LGPL-3.0 / BSL-1.0 / Apache-2.0 / zlib | see the official image's Dockerfile: https://github.com/qbittorrent/docker-qbittorrent-nox |
| rclone | api (worker) | MIT | https://github.com/rclone/rclone |
| nginx | web, gateway | BSD-2-Clause | https://nginx.org/ , https://github.com/nginx/nginx |
| nginx-unprivileged image scripts | web, gateway | BSD-2-Clause | https://github.com/nginx/docker-nginx-unprivileged |
| wireguard-tools (`wg`) | vpn | GPL-2.0-only | https://git.zx2c4.com/wireguard-tools/ (Alpine: https://pkgs.alpinelinux.org/package/v3.22/main/x86_64/wireguard-tools) |
| nftables / libnftables | vpn | GPL-2.0-only | https://netfilter.org/projects/nftables/ |
| iproute2 | vpn | GPL-2.0-or-later | https://git.kernel.org/pub/scm/network/iproute2/iproute2.git |
| BusyBox | vpn, web, gateway, qbittorrent (Alpine bases), `init` helper | GPL-2.0-only | https://busybox.net/ |
| musl libc | Alpine-based images | MIT | https://musl.libc.org/ |
| Go standard library (statically linked into `vpn-control`) | vpn | BSD-3-Clause | https://go.dev/ (the project itself has no Go dependencies: `services/vpn/src/go.mod`) |
| Node.js | api | MIT (plus the licenses of its bundled dependencies, see `LICENSE` in https://github.com/nodejs/node) | https://github.com/nodejs/node |
| tini | api | MIT | https://github.com/krallin/tini |
| Debian packages (glibc, OpenSSL, ca-certificates, ...) | api | various, mostly GPL/LGPL/MIT/BSD | https://sources.debian.org/ |
| Alpine packages | web, gateway, vpn, qbittorrent | various, see each package | https://pkgs.alpinelinux.org/ |

The GPL-2.0 programs in the vpn image (`wg`, `nft`, `ip`) are separate executables started by `vpn-control`; they are
not linked into it and do not make it a derivative work. Likewise the qBittorrent image runs qBittorrent-nox
unmodified.

## Referenced, not redistributed

These are pulled by Docker from their own publishers when you run the stack; this project publishes no copy:

| Component | Used for | License | Source |
|---|---|---|---|
| Authelia (`authelia/authelia`) | login portal | Apache-2.0 | https://github.com/authelia/authelia |
| nginx-proxy (`nginxproxy/nginx-proxy`) and docker-gen | optional bundled TLS proxy | MIT | https://github.com/nginx-proxy/nginx-proxy |
| acme-companion (`nginxproxy/acme-companion`) and acme.sh | optional Let's Encrypt automation | GPL-3.0 | https://github.com/nginx-proxy/acme-companion , https://github.com/acmesh-official/acme.sh |
| BusyBox (`busybox`) | the one-shot `init` helper and `setup.sh` backup/restore | GPL-2.0-only | https://busybox.net/ |

## npm dependencies (summary)

The api, worker and web images contain the production dependencies of the npm workspaces in `apps/`, installed from
`package-lock.json`. Counted from the lockfile at the time of writing (production packages only, workspaces
excluded): MIT 103, Apache-2.0 27, ISC 9, BSD-3-Clause 5, 0BSD 1, and two dual-licensed ones (`MIT OR WTFPL`,
`BSD-2-Clause OR MIT OR Apache-2.0`); none is copyleft. To list
exactly what is shipped for a checkout:

```sh
npm ci
npx license-checker-rseidelsohn --production --summary      # or: npm ls --omit=dev --all
```

Dependabot (npm) keeps these current. If you spot a license that is missing or
wrong here, please open an issue.
