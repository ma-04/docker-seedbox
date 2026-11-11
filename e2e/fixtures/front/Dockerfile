# Test-only TLS front: stands in for the operator's outer reverse proxy (Authelia needs https).
FROM nginx:1.27-alpine
RUN apk add --no-cache openssl
COPY 05-cert.sh /docker-entrypoint.d/05-cert.sh
COPY front.conf.template /etc/nginx/templates/front.conf.template
COPY lists /srv/lists
RUN chmod 755 /docker-entrypoint.d/05-cert.sh
