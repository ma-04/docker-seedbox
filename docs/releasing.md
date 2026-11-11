# Releasing

Images are published to GHCR only by `.github/workflows/release.yml`, and only after the whole CI suite passed for
the exact commit. Nobody pushes images by hand.

Every image is **multi-arch: `linux/amd64` and `linux/arm64`**, each built **natively** on a GitHub-hosted runner of
that architecture (`ubuntu-24.04` and `ubuntu-24.04-arm`, the arm64 runner GitHub offers free to public repositories);
there is no QEMU emulation anywhere. The two builds are then merged into one manifest list (OCI index) per image, so
`docker pull` picks the right one by itself.

## What triggers what

| Event | Tags written (all five images) |
|---|---|
| tag `vX.Y.Z` | `X.Y.Z`; `X.Y` if it is the highest `X.Y.*`; `X` if it is the highest `X.*` and `X >= 1`; `latest` if it is the highest stable version overall. Plus a GitHub Release. |
| tag `vX.Y.Z-rc.N` (any `-suffix`) | `X.Y.Z-rc.N` only: a pre-release never moves anything, and gets no GitHub Release |
| push to `main` | `sha-<7-char commit>` (immutable) and `edge` (moves only while that commit is still the head of `main`) |
| `workflow_dispatch` on a tag (`gh workflow run release.yml --ref vX.Y.Z`) | the same as pushing that tag (to re-publish after a fix in the pipeline itself) |
| `workflow_dispatch` with `dry-run: true`, or a pull request that changes the pipeline | a **dry run**: everything below except the GitHub Release, under the throw-away tag `dryrun-<run id>` / `pr-<N>-test` (and a test move to `<that>-moved`); every package version it pushed is deleted at the end. `gh workflow run release.yml --ref <branch> -f dry-run=true -f arm64-suites=false` skips the arm64 suites, i.e. runs the job graph of a `main` build. Fork and Dependabot PRs build and smoke-test only |
| any other pull request | CI only (`ci.yml`, which also builds and smoke-tests both architectures); nothing is published |

"Highest" is computed from the repository's `v*` tags at the moment the tags move
([`.github/scripts/release-tags.sh`](../.github/scripts/release-tags.sh), self-tested on every run): a patch release on
an older line (`v1.2.5` after `v1.3.0`) moves `1.2` but neither `1` nor `latest`, and re-running an old release never
moves anything backwards. `0.x` releases get no `:0` tag (in `0.x` every minor may break).

## The workflow

1. `guard`: the ref must be a `vMAJOR.MINOR.PATCH[-prerelease]` tag on a commit **that is on `main`**, or `main`
   itself, or a dry run.
2. In parallel:
   - `ci`: `ci.yml` as a reusable workflow: typecheck and unit tests, shellcheck and `docker compose config` for every
     proxy mode, the VPN-sidecar test (`services/vpn/test/run.sh`) and the hermetic end-to-end suite (amd64).
   - `build` (`images.yml`): 5 images x 2 architectures, each on its native runner, with a per-image-and-arch build
     cache. Each image is pushed **untagged, by digest**, with an SBOM and SLSA provenance (`mode=max`) attached, then
     pulled back by that digest and **smoke-tested on the runner that built it** (`.github/scripts/smoke.sh`):
     platform check; api boots with a fresh database, applies every migration (better-sqlite3 native module) and
     answers `/api/health`, `rclone version`; web serves `/healthz` and carries the version; gateway serves `/healthz`
     and passes `nginx -t`; vpn's control binary installs the nftables kill switch and passes its healthcheck,
     `wg`/`nft`/`ip` run; `qbittorrent-nox --version` and its WebUI comes up through the entrypoint. Containers run
     with the same read-only/capability flags as in `deploy/compose.yaml`.
   - releases, pre-releases and dry runs only: `arm64-vpn` and `arm64-e2e` run the VPN-sidecar test and the whole
     end-to-end suite again **on the arm64 runner** (they build their arm64 images there from the same commit).
3. `merge` (per image): only when all of the above are green. Merges the two digests into one index under the
   **immutable** tag (`X.Y.Z`, `sha-<short>` or the dry-run tag), copies the OCI annotations onto it, checks that both
   platforms and both attestation manifests are in it, and creates a GitHub build-provenance attestation for the
   index digest.
4. `publish`: one job, one run at a time; checks that all five immutable tags still point at this run's digests, then
   moves the **moving** tags (`X.Y`, `X`, `latest`, `edge`) on all five images, `latest` last.
5. `verify`: `gh attestation verify` for every tag written, as a user would run it.
6. `github-release` (stable tags only): creates or updates the GitHub Release: generated notes, the image digests, the
   verify command and the upgrade commands. It is marked *Latest* exactly when `:latest` moved (`setup.sh` follows
   GitHub's latest release). This is the only job with `contents: write`.

A red or half-finished run can leave untagged blobs in the registry, never a mixed set under a version tag or
`:latest`. If a `merge` leg fails after another succeeded, some images may already have the new `X.Y.Z` tag but
nothing moved; re-run the failed jobs (`gh run rerun <id> --failed`): every step is idempotent.

## Cutting a release

1. Make sure `main` is green and contains everything. Update docs and, if the compose files, the database or the
   VPN sidecar interface changed, say so in the release notes (upgrade notes matter: `./setup.sh update` runs
   migrations that cannot be undone).
2. Pick the version ([semver](https://semver.org/)): breaking deployment/config changes bump the major (or the minor
   while `0.x`), features the minor, fixes the patch.
3. Tag the commit on `main` (signed) and push the tag:

   ```sh
   git checkout main && git pull --ff-only
   git tag -s v1.2.3 -m "v1.2.3"        # -a instead of -s if you do not sign tags
   git push origin v1.2.3
   ```

   For a trial run first use a pre-release tag such as `v1.2.3-rc.1`.
4. Watch it: `gh run watch "$(gh run list -w release.yml -e push -L 1 --json databaseId --jq '.[0].databaseId')"`.
   It takes about as long as the e2e suite on arm64 plus the merge (see the run's timings).
5. When it is green the GitHub Release exists. Check one image yourself:
   `gh attestation verify oci://ghcr.io/ma-04/docker-seedbox-api:1.2.3 --repo ma-04/docker-seedbox` and
   `docker buildx imagetools inspect ghcr.io/ma-04/docker-seedbox-api:1.2.3` (two platforms).
6. Edit the generated release notes if needed (upgrade notes!). Re-running the workflow rewrites the notes.

## If something goes wrong

- *Release workflow failed before `publish`:* fix the cause; if the fix is in the pipeline itself, merge it to `main`,
  then `gh workflow run release.yml --ref v1.2.3` (the workflow file of the TAG is used, so a fix on `main` only helps
  a new tag: delete the tag, tag the fixed `main` again, or cut the next patch version). Nothing moved.
- *A bad release was tagged:* publish a fixed patch release; do not move a published tag. Mark the GitHub release as
  a pre-release or delete it so `./setup.sh` stops offering it. Users can pin the previous version with
  `./setup.sh update --version X.Y.Z --allow-downgrade` after restoring a backup.
- *Several runs at once:* runs do not queue (GitHub keeps only one pending run per group and would cancel the
  others); only the tag-moving `publish` job is serialized. A third run arriving while one `publish` job waits cancels
  the waiting one; re-run it.

## Housekeeping

Dependabot (`.github/dependabot.yml`) opens weekly PRs for npm, base images (Dockerfiles and compose files),
GitHub Actions and Go modules. Actions are pinned to commit SHAs and base images to digests of their multi-arch
index (so the same pin serves amd64 and arm64); review those PRs like any other change: CI builds and smoke-tests
both architectures on them.

Every `main` push leaves untagged per-architecture versions in the GHCR packages (the children of
superseded indexes); prune them occasionally in the package settings if storage matters.
