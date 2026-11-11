# syntax=docker/dockerfile:1
# Image for both the `api` and `worker` services. Build context = repository root:
#   docker build -f apps/api/Dockerfile .
# The worker overrides CMD with `node dist/worker.js`.

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
# Pinned: a floating tag would change the uploader (and its flags) under a running deployment.
ARG RCLONE_IMAGE=rclone/rclone:1.74.4@sha256:c61954aaa32328a5486715dd063a81c7879f5195ad3505cd362deddd509dc4a1

# --- Build tools for native modules (better-sqlite3 falls back to node-gyp if no prebuilt binary matches).
FROM ${NODE_IMAGE} AS build-base
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Only the manifests + lockfile, so the `npm ci` layers are cached independently of source edits and no local
# file (.env, credentials, ...) can enter the build cache.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/drive-proxy/package.json apps/drive-proxy/package.json
COPY e2e/package.json e2e/package.json
# The two `npm ci` stages below build in parallel: their npm cache mounts are `sharing=locked` (concurrent writers to
# one shared npm cache corrupt it: EEXIST/ENOENT on _cacache renames).

# --- Full install + TypeScript build.
FROM build-base AS build
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --workspace @seedbox/api --include-workspace-root
COPY tsconfig.base.json ./
COPY apps/api/tsconfig.json apps/api/tsconfig.json
COPY apps/api/src apps/api/src
COPY apps/api/migrations apps/api/migrations
RUN npm run build -w @seedbox/api

# --- Production-only dependencies.
FROM build-base AS prod-deps
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --workspace @seedbox/api --include-workspace-root \
 && mkdir -p apps/api/node_modules \
 && npm cache clean --force

# --- Runtime.
FROM ${RCLONE_IMAGE} AS rclone

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
ENV NODE_ENV=production \
    DATA_DIR=/data \
    DOWNLOADS_DIR=/downloads \
    RCLONE_BIN=/usr/local/bin/rclone
# The node base image already ships a non-root `node` user with uid/gid 1000.
RUN mkdir -p /data /downloads /app/apps/api && chown -R 1000:1000 /data /downloads /app
WORKDIR /app
COPY --from=prod-deps --chown=1000:1000 /app/package.json ./package.json
COPY --from=prod-deps --chown=1000:1000 /app/node_modules ./node_modules
WORKDIR /app/apps/api
COPY --from=prod-deps --chown=1000:1000 /app/apps/api/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/apps/api/package.json ./package.json
COPY --from=build --chown=1000:1000 /app/apps/api/dist ./dist
COPY --from=build --chown=1000:1000 /app/apps/api/migrations ./migrations
USER 1000:1000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/api.js"]
