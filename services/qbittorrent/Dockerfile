# Thin wrapper: the official image plus an entrypoint that (re)asserts the settings the
# seedbox relies on in qBittorrent.conf. Everything else stays admin-editable in the WebUI
# and persists in the /config volume.
FROM qbittorrentofficial/qbittorrent-nox:5.3.0-2@sha256:43b2d352cf76330a7ca34c7320b9b74227d6f31e662e0e123d0457206b09a7ea
COPY seed-config.sh /seed-config.sh
ENV PUID=1000 PGID=1000 QBT_LEGAL_NOTICE=confirm QBT_WEBUI_PORT=8080 LAN_CIDRS=172.31.250.0/24
EXPOSE 8080 6881
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS -o /dev/null http://127.0.0.1:8080/api/v2/app/version || exit 1
ENTRYPOINT ["/sbin/tini", "-g", "--", "/seed-config.sh"]
