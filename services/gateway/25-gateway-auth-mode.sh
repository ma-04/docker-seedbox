#!/bin/sh
# Selects the auth snippets for AUTH_MODE (nginx cannot branch on env vars).
set -eu
mode="${AUTH_MODE:-authelia}"
out=/tmp/gateway
mkdir -p "$out"

if [ -z "${GATEWAY_SECRET:-}" ]; then
  echo "gateway: GATEWAY_SECRET must be set" >&2
  exit 1
fi
for v in APP_HOST AUTH_HOST FILES_HOST; do
  eval "val=\${$v:-}"
  if [ -z "$val" ]; then
    echo "gateway: $v must be set" >&2
    exit 1
  fi
done

case "$mode" in
  authelia)
    cp /etc/nginx/snippets/auth-authelia-page.conf "$out/auth-page.conf"
    cp /etc/nginx/snippets/auth-authelia-api.conf "$out/auth-api.conf"
    ;;
  external)
    echo "gateway: AUTH_MODE=external - trusting Remote-* headers from the upstream proxy." >&2
    echo "gateway: The gateway must be reachable ONLY from your SSO proxy." >&2
    cp /etc/nginx/snippets/auth-external.conf "$out/auth-page.conf"
    cp /etc/nginx/snippets/auth-external.conf "$out/auth-api.conf"
    ;;
  *)
    echo "gateway: AUTH_MODE must be 'authelia' or 'external' (got '$mode')" >&2
    exit 1
    ;;
esac
