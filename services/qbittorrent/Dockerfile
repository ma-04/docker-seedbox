# Thin wrapper: the official image plus an entrypoint that (re)asserts the settings the
# seedbox relies on in qBittorrent.conf (see seed-config.sh / conf-edit.sh). Everything else stays admin-editable in the WebUI
# and persists in the /config volume.
FROM qbittorrentofficial/qbittorrent-nox:5.3.0-2@sha256:43b2d352cf76330a7ca34c7320b9b74227d6f31e662e0e123d0457206b09a7ea
# Root-owned and (with `read_only: true` in compose) immutable at run time. conf-edit.sh runs as the unprivileged user.
COPY --chmod=0755 seed-config.sh conf-edit.sh /
ENV PUID=1000 PGID=1000 QBT_LEGAL_NOTICE=confirm QBT_WEBUI_PORT=8080 LAN_CIDRS=172.31.250.0/24
EXPOSE 8080 6881
# The WebUI answers (403 = it asks loopback clients to log in as well: LocalHostAuth=true) and this container still
# shares a live network namespace: one of Docker's interfaces (eth*) is visible. A qbittorrent left behind by a plain
# `docker restart vpn` keeps only lo and the sidecar's wg* interface (Docker removes only its own).
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD c=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/v2/app/version); { [ "$c" = 403 ] || [ "$c" = 200 ]; } && awk 'NR>2 && $1 ~ /^eth[0-9]+:/ {f=1} END {exit !f}' /proc/net/dev || exit 1
ENTRYPOINT ["/sbin/tini", "-g", "--", "/seed-config.sh"]
