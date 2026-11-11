# Build context: repository root.  docker build -f apps/web/Dockerfile .
FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/drive-proxy/package.json apps/drive-proxy/package.json
COPY apps/web/package.json apps/web/package.json
COPY e2e/package.json e2e/package.json
RUN npm ci --workspace @seedbox/web --include-workspace-root
# The web app imports wire types (type-only) from the API sources.
COPY tsconfig.base.json ./
COPY apps/api/src/lib apps/api/src/lib
COPY apps/web apps/web
# Shown in the footer (AGPL: users of the running service can find the corresponding source).
ARG VITE_APP_VERSION=dev
ARG VITE_SOURCE_URL=https://github.com/ma-04/docker-seedbox
ENV VITE_APP_VERSION=$VITE_APP_VERSION VITE_SOURCE_URL=$VITE_SOURCE_URL
RUN cd apps/web && npx vite build

FROM nginxinc/nginx-unprivileged:1.30.6-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
