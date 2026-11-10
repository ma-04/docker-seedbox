FROM node:22-alpine
COPY tracker.mjs /tracker.mjs
USER node
EXPOSE 6969
HEALTHCHECK --interval=3s --timeout=2s --retries=10 CMD wget -q -O /dev/null http://127.0.0.1:6969/healthz || exit 1
CMD ["node", "/tracker.mjs"]
