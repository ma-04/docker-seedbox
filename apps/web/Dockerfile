# Build context: repository root.  docker build -f apps/web/Dockerfile .
FROM node:22-alpine AS build
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
RUN cd apps/web && npx vite build

FROM nginxinc/nginx-unprivileged:1.30.6-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
