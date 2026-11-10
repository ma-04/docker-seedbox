# End-to-end tests (Playwright)

A hermetic stack runs the **real** gateway, Authelia, web, api, worker, vpn and qBittorrent next to test fixtures
(`deploy/compose.e2e.yaml`, layered on `deploy/compose.yaml`). The suite drives the real UI through the real Authelia
login page. Nothing leaves the Docker host: no real VPN, cloud or Google credentials are needed.

| Fixture | What it is |
|---|---|
| `front` | nginx with a throw-away self-signed certificate for `app.`, `auth.`, `files.`, `s3.`, `fixtures.`, `ctl.seedbox.test`; forwards `X-Forwarded-Proto: https` to `gateway:8080` (Authelia requires https) |
| `tracker` (172.31.250.30), `seeder` (.31) | a tiny HTTP tracker and a transmission seeder. The seeder generates, at start, a multi-file torrent (folder, sub-folders, names with spaces, unicode, `#`, `%`, `'`), a single-file torrent and a rate-limited "slow" torrent, and publishes `.torrent` files, magnets and sha256 sums as `https://fixtures.seedbox.test/manifest.json`. They are addressed by IP: while a tunnel is up the vpn namespace cannot resolve compose names |
| `wg1`, `wg2`, `net-echo-direct`, `net-echo-behind` | two WireGuard servers with keys generated at start (client configs at `https://fixtures.seedbox.test/wg/wgN.conf`), an echo service on a network the vpn container can reach directly (`inet`) and one reachable only through the WireGuard servers (`behind`) |
| `minio` | real MinIO with bucket `seedbox-e2e`; `s3.seedbox.test` exposes it for presigned links |
| `users-init` | writes the Authelia users (`admin` in group `admins`; `alice`, `bob`, `carol`) with per-run random passwords |
| `ctl` | test-only control service (mounts the Docker socket!): restart a service, run `curl` inside the qbittorrent container. Token protected, fixed operations only, exists only in `compose.e2e.yaml` |
| `playwright` | the runner (`mcr.microsoft.com/playwright`, version pinned to `@playwright/test` in `package.json`) |

Secrets are generated per run into `e2e/.state/e2e.env` (git-ignored, mode 600) and removed on teardown.

## a) Fully containerised (CI)

```sh
e2e/run.sh                          # build, start, run, collect, tear down; exit code = test result
e2e/run.sh -- tests/03-local-download.spec.ts     # a single spec
e2e/run.sh --keep --no-build        # leave the stack running; --rmi removes the built images on teardown
```

Needs Docker with Compose >= 2.33 (`gw_priority`) and a kernel with WireGuard (5.6+). Images are tagged
`sbe2e/*:e2e`, so they never overwrite a real installation. After a run: `e2e/.out/report` (HTML),
`e2e/.out/results` (traces, screenshots of failures), `e2e/.out/junit.xml`, `e2e/.out/logs/<service>.log`
(every container's log, also written when the stack fails to start).

## b) From a developer machine, against a stack running elsewhere

On the Docker host start the stack with one loopback port published and leave it running:

```sh
e2e/run.sh --keep --publish --no-tests        # 127.0.0.1:18443 -> TLS front (E2E_PUBLISH_PORT to change)
```

On your machine (needs Node 22; `npm ci` at the repo root, `npx playwright install chromium` once):

```sh
ssh -N -L 18443:127.0.0.1:18443 user@docker-host &
scp user@docker-host:path/to/repo/e2e/.state/e2e.env /tmp/e2e.env
cd e2e
E2E_ENV_FILE=/tmp/e2e.env E2E_CONNECT=127.0.0.1:18443 npx playwright test
```

`E2E_CONNECT` makes Chromium map every `*.seedbox.test` host to the tunnel (`--host-resolver-rules`) and makes the
suite's plain HTTP calls (signed links, spoofed headers, S3) do the same; certificate errors are ignored. Other
overrides: `E2E_BASE_URL`, `E2E_FILES_URL`, `E2E_S3_URL`, `E2E_FIXTURES_URL`, `E2E_CTL_URL`. The container restarts and
the in-namespace probes go through `ctl`, so all scenarios work over the single tunnelled port. The suite resets its
own state (jobs, `e2e-*` destinations, VPN configs, limits) at start, so it can be re-run against a kept stack.

## Scenarios

`tests/01-auth` login/redirect, admin gating, spoofed `Remote-User`, logout; `02-destinations` shared Local + S3 via the
UI; `03-local-download` upload `.torrent` -> live progress -> files -> sha256 / Range / bad and expired signatures / SSE;
`04-s3-download` magnet -> MinIO -> presigned link; `05-shared-torrent` two users, one download, isolation;
`06-cancel-retry`; `07-limits`; `08-vpn` configs, required mode, rotation, kill switch, pending without VPN, no config
text leaks; `09-admin` engine settings read back from qBittorrent, disabling a user; `10-restart` restart of
worker+api, and of vpn+qbittorrent, mid-download.

`01-auth` contains one `test.fixme` for the percent-encoded admin path (`/api/%61dmin/...`); set
`E2E_ADMIN_BYPASS_FIXED=1` once the authorisation fix is merged.
