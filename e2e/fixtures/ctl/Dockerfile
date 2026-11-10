# Test-only control service: restarts stack services and runs probes inside the qbittorrent container so the
# Playwright suite can exercise infrastructure from anywhere (including a dev laptop through one tunnel).
# It mounts the Docker socket, which is why it exists only in compose.e2e.yaml. It exposes a fixed set of
# operations on containers of its own compose project and nothing else.
FROM docker:cli
RUN apk add --no-cache nodejs
COPY ctl.mjs /ctl.mjs
ENTRYPOINT []
CMD ["node", "/ctl.mjs"]
