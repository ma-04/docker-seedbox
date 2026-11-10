#!/bin/sh
# Self-signed certificate valid for every *.seedbox.test host, generated at container start.
set -eu
mkdir -p /etc/nginx/certs
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -keyout /etc/nginx/certs/key.pem -out /etc/nginx/certs/cert.pem \
  -subj "/CN=seedbox.test" -addext "subjectAltName=DNS:*.seedbox.test,DNS:seedbox.test" >/dev/null 2>&1
