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

`docker compose build` builds every image from a clone. CI runs typecheck, unit tests, the compose/shellcheck checks and a build of every image.

## Pull requests

- Keep changes focused; add or update tests; update the docs and `docs/architecture.md` when behaviour or interfaces change.
- Never commit secrets, real hostnames or personal data. Use `example.com` in examples.
- Only legal, public-domain/CC torrents in tests.
- By contributing you agree that your contribution is licensed under AGPL-3.0-only.
