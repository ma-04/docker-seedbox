# Releasing

Images are published to GHCR only by `.github/workflows/release.yml`, and only after the whole CI suite passed for
the exact commit. Nobody pushes images by hand.

## What triggers what

| Event | Result |
|---|---|
| tag `vX.Y.Z` | `:X.Y.Z`, `:X.Y`, `:latest` for all five images |
| tag `vX.Y.Z-rc.N` (any `-suffix`) | `:X.Y.Z-rc.N` only: a pre-release never moves `:X.Y` or `:latest` |
| push to `main` | `:edge` only |
| `workflow_dispatch` | the same, for the ref it is run on (a tag or `main`; other refs are refused) |
| pull request | CI only (`ci.yml`); nothing is published |

The workflow (`release.yml`):

1. `guard`: the ref must be `main` or a `vMAJOR.MINOR.PATCH[-prerelease]` tag that points at a commit **on `main`**.
2. `ci`: calls `ci.yml` as a reusable workflow: typecheck and unit tests, shellcheck and `docker compose config` for
   every proxy mode, a build of every image, the VPN-sidecar test (`services/vpn/test/run.sh`) and the hermetic
   end-to-end suite. Everything must be green; a failure stops the release.
3. `push-digests`: builds the five images (linux/amd64 and linux/arm64, with provenance and SBOM) and pushes each one
   **untagged, by digest**. `fail-fast` is on: if one fails, nothing has a tag.
4. `tag`: one job that, only when all five digests exist, applies the tags to all five.
5. `attest`: build-provenance attestations (`gh attestation verify`, see [deployment.md](deployment.md#versions-upgrades-and-verification)).

So a red or half-finished build can leave untagged blobs in the registry, never a mixed set under a version tag
or `:latest`.

## Cutting a release

1. Make sure `main` is green and contains everything. Update docs and, if the compose files, the database or the
   VPN sidecar interface changed, say so in the release notes (upgrade notes matter: `./setup.sh update` runs
   migrations that cannot be undone).
2. Pick the version ([semver](https://semver.org/)): breaking deployment/config changes bump the major (or the minor
   while `0.x`), features the minor, fixes the patch.
3. Tag the commit on `main` and push the tag:

   ```sh
   git checkout main && git pull
   git tag -a v1.2.3 -m "v1.2.3"
   git push origin v1.2.3
   ```

   For a trial run first use a pre-release tag such as `v1.2.3-rc.1`.
4. Watch the *Release images* workflow. When it is green, check one image:
   `gh attestation verify oci://ghcr.io/ma-04/docker-seedbox-api:1.2.3 --repo ma-04/docker-seedbox`.
5. Create the GitHub release for the tag (`gh release create v1.2.3 --generate-notes`, add `--prerelease` for
   `-rc` tags). `./setup.sh` finds the newest **non-prerelease GitHub release** through the API
   (`/releases/latest`), so the release must exist for installs and `update` to pick the version up.
6. First release only: the GHCR packages are created private. Make the five `docker-seedbox-*` packages public in
   the repository's package settings (and link them to the repository), otherwise `docker pull` and `setup.sh` fail
   for everyone else (`setup.sh` then offers a local build).

## If something goes wrong

- *Release workflow failed before `tag`:* fix, then re-run the workflow (or delete the tag, fix on `main`, tag again).
  Nothing was published under a version.
- *A bad release was tagged:* publish a fixed patch release; do not move a published tag. Mark the GitHub release as
  a pre-release or delete it so `./setup.sh` stops offering it. Users can pin the previous version with
  `./setup.sh update --version X.Y.Z --allow-downgrade` after restoring a backup.
- *Pushes to `main` while a release is running:* the release runs are queued per ref, not cancelled.

## Housekeeping

Dependabot (`.github/dependabot.yml`) opens weekly PRs for npm, base images (Dockerfiles and compose files),
GitHub Actions and Go modules. Actions are pinned to commit SHAs and base images to digests; review those PRs like
any other change: CI runs the full suite on them.
