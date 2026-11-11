FROM alpine:3.20
RUN apk add --no-cache transmission-daemon transmission-remote transmission-extra jq coreutils
COPY seeder.sh /seeder.sh
RUN chmod 755 /seeder.sh
ENTRYPOINT ["/seeder.sh"]
