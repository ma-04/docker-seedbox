# docker-seedbox gateway: the only entrypoint. Build context: services/gateway
FROM nginxinc/nginx-unprivileged:1.31-alpine@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e

# Only these variables are substituted into the templates (nginx's own $vars stay intact).
ENV NGINX_ENVSUBST_FILTER='^(APP_HOST|GATEWAY_SECRET)$' \
    AUTH_MODE=authelia

USER root
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/nginx.conf
COPY templates/ /etc/nginx/templates/
COPY snippets/ /etc/nginx/snippets/
# Runs after the envsubst step (20-) and picks the auth snippet for AUTH_MODE.
COPY --chmod=0755 25-gateway-auth-mode.sh /docker-entrypoint.d/25-gateway-auth-mode.sh
USER nginx

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
