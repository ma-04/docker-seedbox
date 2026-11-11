# Contributing

Thanks for helping. Please read [docs/architecture.md](docs/architecture.md) first: it is the contract between components, and interface changes start there.

## Development setup

Requirements: Node 22+, npm, Docker (for image builds and e2e).

```sh
git clone https://github.com/ma-04/docker-seedbox.git
cd docker-seedbox
npm ci                 # installs every workspace (apps/*, e2e)
npm run typecheck      # all workspaces
npm test               # unit tests (vitest) in all workspaces
npm run dev:api -w @seedbox/api      # API with reload (needs APP_SECRET, GATEWAY_SECRET, VPN_CONTROL_TOKEN)
npm run dev:worker -w @seedbox/api   # worker
```

The web app and Cloudflare Worker have their own scripts; see `apps/web/package.json` and [apps/drive-proxy/README.md](apps/drive-proxy/README.md).

## Layout

| Path | What |
|---|---|
| `apps/api` | REST API and worker (one image, two commands) |
| `apps/web` | React SPA |
| `apps/drive-proxy` | Cloudflare Worker for Drive links |
| `services/gateway`, `services/vpn`, `services/qbittorrent` | container images |
| `deploy/` | compose files, Authelia config, proxy stack |
| `e2e/` | Playwright and hermetic-stack tests |

## Testing the deployment layer

```sh
shellcheck -x -s bash setup.sh services/gateway/25-gateway-auth-mode.sh
# writes deploy/.env (git-ignored) and validates every compose file without starting anything:
./setup.sh --domain seedbox.example.com --admin-email me@example.com --proxy none --yes --no-start
```

`docker compose build` builds every image from a clone. CI runs typecheck, unit tests, the compose/shellcheck checks, a build of every image, the VPN sidecar test (`services/vpn/test/run.sh`, needs Docker with Compose 2.33+ and a kernel with WireGuard) and the end-to-end suite. All of it must pass before anything is published: see [docs/releasing.md](docs/releasing.md).

```sh
services/vpn/test/run.sh        # kill switch, LAN policy, rotation, qBittorrent seeding; project name sbvpn, cleans up after itself
cd services/vpn/src && go vet ./... && go test ./...
```

## Pull requests

- Keep changes focused; add or update tests; update the docs and `docs/architecture.md` when behaviour or interfaces change.
- Never commit secrets, real hostnames or personal data. Use `example.com` in examples.
- GitHub Actions are pinned to full commit SHAs (`uses: owner/repo@<sha> # vX.Y.Z`) and base images to digests; Dependabot proposes the updates. Look SHAs up with `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` (dereference annotated tags), never guess them.
- Only legal, public-domain/CC torrents in tests.
- By contributing you agree that your contribution is licensed under AGPL-3.0-only.
