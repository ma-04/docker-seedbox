# End-to-end tests (Playwright)

A hermetic stack runs the **real** gateway, Authelia, web, api, worker, vpn and qBittorrent next to test fixtures
(`deploy/compose.e2e.yaml`, layered on `deploy/compose.yaml`). The suite drives the real UI through the real Authelia
login page. Nothing leaves the Docker host: no real VPN, cloud or Google credentials are needed.

| Fixture | What it is |
|---|---|
| `front` | nginx with a throw-away self-signed certificate for `app.`, `auth.`, `files.`, `s3.`, `fixtures.`, `ctl.seedbox.test`; forwards `X-Forwarded-Proto: https` to `gateway:8080` (Authelia requires https) |
| `tracker` (172.31.250.30), `seeder` (.31) | a tiny HTTP tracker and a transmission seeder. The seeder generates, at start, a multi-file torrent (folder, sub-folders, names with spaces, unicode, `#`, `%`, `'`), a single-file torrent and a rate-limited "slow" torrent, and publishes `.torrent` files, magnets and sha256 sums as `https://fixtures.seedbox.test/manifest.json`. The app drops trackers on private addresses from submitted magnets and `.torrent` files (SSRF policy), so global setup sets the engine's "add trackers to new downloads" to the fixture tracker. They are addressed by IP: while a tunnel is up the vpn namespace cannot resolve compose names |
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

`11-hardening` SSRF (a normal user cannot create an S3 destination on `vpn`, a private or a metadata address), CSRF
header (`X-Requested-With: seedbox`), local `/dl` links revoked when the job is deleted, qBittorrent WebUI refused to
ordinary containers (`ctl /webui`), and the kill switch holding after a sidecar restart while the worker is stopped
(`ctl /stop`, `/start`).

## c) Live suite: a real deployment (opt-in)

`e2e/live/` + `playwright.live.config.ts` drive the real UI in Chromium against a **real** installation made by
`./setup.sh` (public DNS, Let's Encrypt, a real WireGuard VPN, a real Google Drive, a real S3/B2 bucket and the
Cloudflare Worker). It is never run by CI and `e2e/run.sh` does not know it. It downloads **only** official, legal
Linux ISO torrents (the current Ubuntu Server LTS from releases.ubuntu.com, the Debian netinst from cdimage.debian.org)
and compares the result with the sha256 those projects publish.

Everything environment specific comes from one git-ignored env file (default `../credentials/deploy.env`, or
`LIVE_ENV_FILE=/path`); `e2e/live/env.example` lists the keys. No host name, address, id, bucket or key is committed.

```sh
cd e2e
npx playwright test -c playwright.live.config.ts                # all numbered specs, in order
npx playwright test -c playwright.live.config.ts 02 03          # selected specs
```

| Spec | What it checks |
|---|---|
| `01-tls-auth` | Let's Encrypt certificates on the app, auth and files hosts, HTTP -> HTTPS, unauthenticated -> Authelia, admin login, a normal user has no admin access (also through `/api/%61dmin/...`) |
| `02-vpn` | both WireGuard configs uploaded through the UI, mode `required`, public IP is not the server's, "Rotate now" changes config and IP, and from inside the qbittorrent container: egress is the VPN, IPv6 and bypassing the tunnel are blocked |
| `03-destinations` | shared Local, Google Drive (pasted rclone section, `anyone` sharing, Worker proxy) and S3/B2 (under the run prefix) created through the UI; "Test" shows OK |
| `04-add-torrents` | with the VPN required and connected, adds the Ubuntu ISO -> Local, Debian -> Drive (admin) and -> B2 (normal user); the shared torrent is a single engine download |
| `05-engine-limit` | Advanced -> a download limit is applied (speed drops) and reset |
| `06-vpn-restart-midflight` | `compose restart vpn` mid-download: the server's own IP is never seen from the namespace, the VPN comes back and the download resumes |
| `07-complete-and-verify` | jobs complete in the UI; local link: sha256 equals the published one, Range gives 206, a tampered signature is refused; Drive: shared folder opens unauthenticated, Worker link sha256; B2: presigned link sha256, object below the run prefix; the torrent was downloaded once |
| `08-stack-restart` | `docker compose down && up -d`: healthy again, jobs and links intact, the VPN reconnects by itself and stays `required` |
| `99-cleanup` | deletes the test jobs, the Drive folders this run created, the B2 objects under the run prefix and the big ISO from the server (the deployment, its destinations and the VPN stay) |

Safety rules baked in: a run id is generated once (`e2e/.out/live/state.json`); every S3/B2 delete asserts the
`<base>/<run-id>/` prefix first and only ever calls `rclone delete` on exactly that path (no `sync`, no `purge`, no
bucket-root listing/deletion); Drive removals address only the job folders recorded for this run. Credentials are passed
through the app's own UI/API over HTTPS; the env file and the rclone/WireGuard files are read on the machine running the
tests and never copied to the server (the ssh probes only run `docker`, `curl` and `compose` commands).

Notes for the credentials you feed it:

- A Drive OAuth token with the `drive.file` scope (what many rclone remotes use) can only see folders that **this OAuth
  client created**: pointing the destination at a folder made elsewhere fails with `File not found`. Create the root
  folder with the same remote (`rclone mkdir remote:seedbox-root`, id from `rclone lsjson`) or use a `drive`-scope token.
- Commercial VPNs rarely forward ports: expect only outgoing peer connections and modest torrent speeds; a 3 GB ISO can
  take a while. Timeouts are generous (30 minutes per test).
