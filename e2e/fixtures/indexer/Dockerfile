# Test-only mock torrent site for Jackett (see indexer.mjs and sbmock.yml).
FROM node:22-alpine
COPY indexer.mjs /indexer.mjs
USER node
EXPOSE 8080
HEALTHCHECK --interval=3s --timeout=2s --retries=20 CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "/indexer.mjs"]
