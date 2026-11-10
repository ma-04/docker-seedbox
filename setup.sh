#!/usr/bin/env bash
# docker-seedbox setup: generates secrets, writes deploy/.env, creates the first admin user,
# pulls (or builds) the images and starts the stack. Safe to re-run: existing secrets and
# settings are kept, only missing values are added.
#
#   ./setup.sh                       interactive install
#   ./setup.sh --domain seedbox.example.com --admin-email me@example.com --yes
#   ./setup.sh add-user              add a login (Authelia mode)
#   ./setup.sh update                pull newer images and restart
#   ./setup.sh doctor                check DNS, containers, VPN prerequisites, disk space
#
# Run `./setup.sh --help` for all options. Docs: docs/deployment.md
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEPLOY="$ROOT/deploy"
ENV_FILE="$DEPLOY/.env"
USERS_DIR="$DEPLOY/authelia/users"
USERS_FILE="$USERS_DIR/users_database.yml"

# --- output helpers -----------------------------------------------------------------------
if [ -t 1 ]; then B=$'\033[1m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; N=$'\033[0m'; else B=""; R=""; G=""; Y=""; N=""; fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s%s%s\n' "$G" "$N" "$B" "$*" "$N"; }
warn() { printf '%sWARNING:%s %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '%sERROR:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: ./setup.sh [command] [options]

Commands:
  install (default)   configure, pull/build images and start the stack
  add-user            add an Authelia user (--admin-user NAME --admin-password PW --admin-email MAIL [--group admins])
  update              pull newer images and restart (add --build to rebuild from this clone)
  doctor              diagnose DNS, containers, the WireGuard kernel module and disk space

Install options (each also readable from the environment as SEEDBOX_<NAME>, e.g. SEEDBOX_DOMAIN):
  --domain DOMAIN        app host, e.g. seedbox.example.com (auth./files. subdomains are derived)
  --auth-host HOST       override the login host      (default auth.<domain>)
  --files-host HOST      override the downloads host  (default files.<domain>)
  --cookie-domain DOMAIN parent domain for the login cookie (default: the app domain)
  --admin-user NAME      first admin login            (default admin)
  --admin-password PW    its password                 (default: generated and printed once)
  --admin-email MAIL     its e-mail address
  --proxy MODE           bundled | external | none
  --proxy-network NAME   Docker network of your existing reverse proxy (external mode)
  --acme-email MAIL      e-mail for Let's Encrypt (bundled / nginx-proxy + acme-companion)
  --build                build images from this clone instead of pulling from GHCR
  --no-start             write configuration only; do not pull or start anything
  --yes, -y              never prompt; use flags/env/defaults
  --help, -h             this text
EOF
}

# --- argument parsing ------------------------------------------------------------------------
CMD=install
DOMAIN=${SEEDBOX_DOMAIN:-}; AUTH_HOST_IN=${SEEDBOX_AUTH_HOST:-}; FILES_HOST_IN=${SEEDBOX_FILES_HOST:-}
COOKIE_IN=${SEEDBOX_COOKIE_DOMAIN:-}
ADMIN_USER=${SEEDBOX_ADMIN_USER:-}; ADMIN_PASSWORD=${SEEDBOX_ADMIN_PASSWORD:-}; ADMIN_EMAIL=${SEEDBOX_ADMIN_EMAIL:-}
PROXY=${SEEDBOX_PROXY:-}; PROXY_NETWORK_IN=${SEEDBOX_PROXY_NETWORK:-}; ACME_EMAIL_IN=${SEEDBOX_ACME_EMAIL:-}
BUILD=${SEEDBOX_BUILD:-0}; YES=${SEEDBOX_YES:-0}; NO_START=0; USER_GROUP=users

if [ $# -gt 0 ]; then
  case "$1" in install|add-user|update|doctor) CMD=$1; shift ;; esac
fi
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN=${2:?--domain needs a value}; shift 2 ;;
    --auth-host) AUTH_HOST_IN=${2:?}; shift 2 ;;
    --files-host) FILES_HOST_IN=${2:?}; shift 2 ;;
    --cookie-domain) COOKIE_IN=${2:?}; shift 2 ;;
    --admin-user) ADMIN_USER=${2:?}; shift 2 ;;
    --admin-password) ADMIN_PASSWORD=${2:?}; shift 2 ;;
    --admin-email) ADMIN_EMAIL=${2:?}; shift 2 ;;
    --group) USER_GROUP=${2:?}; shift 2 ;;
    --proxy) PROXY=${2:?}; shift 2 ;;
    --proxy-network) PROXY_NETWORK_IN=${2:?}; shift 2 ;;
    --acme-email) ACME_EMAIL_IN=${2:?}; shift 2 ;;
    --build) BUILD=1; shift ;;
    --no-start) NO_START=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "Unknown option: $1" ;;
  esac
done

INTERACTIVE=1
if [ "$YES" = 1 ] || [ ! -t 0 ]; then INTERACTIVE=0; fi

# --- small utilities ---------------------------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }
dc() { (cd "$DEPLOY" && docker compose "$@"); }

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

gen_hex() { # gen_hex BYTES -> 2*BYTES hex characters
  if have openssl; then openssl rand -hex "$1"; else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}
gen_password() { # 20 chars, no ambiguous or shell-special characters
  local out=""
  while [ "${#out}" -lt 20 ]; do
    out="$out$(head -c 64 /dev/urandom | LC_ALL=C tr -dc 'A-HJ-NP-Za-km-z2-9' | head -c 20 || true)"
  done
  printf '%s' "${out:0:20}"
}

env_get() { # env_get KEY -> value (empty if missing)
  [ -f "$ENV_FILE" ] || return 0
  awk -v k="$1" 'index($0, k "=") == 1 { print substr($0, length(k) + 2); exit }' "$ENV_FILE"
}
env_put() { # env_put KEY VALUE : replace the line (or append). Edits in place, keeps mode.
  local k=$1 v=$2 tmp
  tmp=$(mktemp)
  if grep -q "^$k=" "$ENV_FILE" 2>/dev/null; then
    K="$k" V="$v" awk 'index($0, ENVIRON["K"] "=") == 1 { print ENVIRON["K"] "=" ENVIRON["V"]; next } { print }' "$ENV_FILE" >"$tmp"
  else
    { cat "$ENV_FILE"; printf '%s=%s\n' "$k" "$v"; } >"$tmp"
  fi
  cat "$tmp" >"$ENV_FILE"; rm -f "$tmp"
}
lan_ips() { # lan_ips CIDR -> "<vpn ip> <api ip> <worker ip> <dynamic range>" (IPv4, /8../26)
  # vpn/api/worker get network+2/+3/+4 (the low half of the subnet); Docker hands out the rest from the upper half.
  local cidr=$1 a b c d bits n mask net half
  printf '%s' "$cidr" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$' || return 1
  IFS=. read -r a b c d <<<"${cidr%/*}"; bits=${cidr#*/}
  [ "$bits" -ge 8 ] && [ "$bits" -le 26 ] || return 1
  [ "$a" -le 255 ] && [ "$b" -le 255 ] && [ "$c" -le 255 ] && [ "$d" -le 255 ] || return 1
  n=$(( (a << 24) | (b << 16) | (c << 8) | d )); mask=$(( (0xFFFFFFFF << (32 - bits)) & 0xFFFFFFFF ))
  net=$(( n & mask )); half=$(( net + (1 << (31 - bits)) ))
  dotted() { printf '%d.%d.%d.%d' $(( ($1 >> 24) & 255 )) $(( ($1 >> 16) & 255 )) $(( ($1 >> 8) & 255 )) $(( $1 & 255 )); }
  printf '%s %s %s %s/%d\n' "$(dotted $((net + 2)))" "$(dotted $((net + 3)))" "$(dotted $((net + 4)))" "$(dotted $half)" $((bits + 1))
}
env_ensure() { # env_ensure KEY VALUE : only if currently unset/empty (secrets!)
  [ -n "$(env_get "$1")" ] || env_put "$1" "$2"
}

ask() { # ask VAR "prompt" "default"   (VAR already set => no question)
  local var=$1 prompt=$2 def=${3:-} cur reply
  eval "cur=\${$var:-}"
  [ -z "$cur" ] || return 0
  if [ "$INTERACTIVE" = 1 ]; then
    if [ -n "$def" ]; then printf '%s [%s]: ' "$prompt" "$def"; else printf '%s: ' "$prompt"; fi
    IFS= read -r reply || reply=""
    reply=${reply:-$def}
  else
    reply=$def
  fi
  eval "$var=\$reply"
}
ask_secret() { # ask_secret VAR "prompt" : hidden input, empty => stays empty
  local var=$1 prompt=$2 cur reply=""
  eval "cur=\${$var:-}"
  [ -z "$cur" ] || return 0
  if [ "$INTERACTIVE" = 1 ]; then
    printf '%s: ' "$prompt"; IFS= read -r -s reply || reply=""; printf '\n'
  fi
  eval "$var=\$reply"
}

valid_host() { printf '%s' "$1" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'; }
valid_user() { printf '%s' "$1" | grep -Eq '^[a-z0-9][a-z0-9._-]{0,63}$'; }
valid_email() { printf '%s' "$1" | grep -Eq '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'; }
yaml_q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }

need_docker() {
  have docker || die "Docker is not installed. See https://docs.docker.com/engine/install/"
  docker info >/dev/null 2>&1 || die "Cannot talk to the Docker daemon (is it running, and are you in the 'docker' group?)"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required ('docker compose', not 'docker-compose'). See https://docs.docker.com/compose/install/"
}

authelia_image() { # single source of truth: deploy/compose.yaml
  sed -n 's/^[[:space:]]*image:[[:space:]]*\(authelia\/authelia:[^[:space:]]*\).*/\1/p' "$DEPLOY/compose.yaml" | head -n 1
}

# --- Authelia users -------------------------------------------------------------------------------
hash_password() { # hash_password PASSWORD -> argon2id digest, via the pinned Authelia image
  # The password goes in through a 0600 env file, never on the `docker run` command line (visible in `ps` and
  # shell history to every local user). Limitation: `authelia crypto hash generate` has no stdin/file input, so
  # the authelia process inside the throw-away container still has it in its argv for about a second.
  local out envf rc=0
  envf=$(mktemp) || die "Cannot create a temporary file"
  chmod 600 "$envf"
  printf 'SEEDBOX_PW=%s\n' "$1" >"$envf"
  # shellcheck disable=SC2016  # $SEEDBOX_PW must expand inside the container
  out=$(docker run --rm --env-file "$envf" --entrypoint sh "$(authelia_image)" \
    -c 'exec authelia crypto hash generate argon2 --password "$SEEDBOX_PW" --no-confirm' 2>&1) || rc=$?
  rm -f "$envf"
  [ "$rc" -eq 0 ] || die "Could not hash the password with $(authelia_image) (exit $rc)"
  printf '%s\n' "$out" | sed -n 's/^Digest: //p' | head -n 1
}

user_exists() { [ -f "$USERS_FILE" ] && grep -q "^  $1:" "$USERS_FILE"; }

write_user() { # write_user NAME PASSWORD EMAIL GROUPS(comma-separated)
  local name=$1 pw=$2 email=$3 groups=$4 digest g
  valid_user "$name" || die "Invalid user name '$name' (use lowercase letters, digits, . _ -)"
  valid_email "$email" || die "Invalid e-mail address '$email'"
  [ "${#pw}" -ge 8 ] || die "Password must be at least 8 characters"
  user_exists "$name" && die "User '$name' already exists in $USERS_FILE"
  digest=$(hash_password "$pw")
  # shellcheck disable=SC2016
  case "$digest" in '$argon2'*) ;; *) die "Unexpected hash output from Authelia" ;; esac
  mkdir -p "$USERS_DIR"
  [ -f "$USERS_FILE" ] || { printf 'users:\n' >"$USERS_FILE"; }
  {
    printf '  %s:\n' "$name"
    printf '    disabled: false\n'
    printf '    displayname: %s\n' "$(yaml_q "$name")"
    printf '    email: %s\n' "$(yaml_q "$email")"
    printf '    password: %s\n' "$(yaml_q "$digest")"
    printf '    groups:\n'
    for g in $(printf '%s' "$groups" | tr ',' ' '); do printf '      - %s\n' "$(yaml_q "$g")"; done
  } >>"$USERS_FILE"
  chmod 600 "$USERS_FILE"
}

cmd_add_user() {
  need_docker
  [ -f "$ENV_FILE" ] || die "No deploy/.env yet - run ./setup.sh first."
  [ "$(env_get AUTH_MODE)" = "external" ] && die "AUTH_MODE=external: users are managed by your own SSO, not Authelia."
  ask ADMIN_USER "Username" ""
  ask ADMIN_EMAIL "E-mail" ""
  [ -n "$ADMIN_USER" ] && [ -n "$ADMIN_EMAIL" ] || die "Username and e-mail are required (use --admin-user / --admin-email)"
  local generated=0 groups="users"
  if [ -z "$ADMIN_PASSWORD" ]; then ask_secret ADMIN_PASSWORD "Password (empty = generate one)"; fi
  if [ -z "$ADMIN_PASSWORD" ]; then ADMIN_PASSWORD=$(gen_password); generated=1; fi
  if [ "$USER_GROUP" = admins ]; then groups="admins,users"; fi
  ADMIN_USER=$(lower "$ADMIN_USER")
  write_user "$ADMIN_USER" "$ADMIN_PASSWORD" "$ADMIN_EMAIL" "$groups"
  say "User '$ADMIN_USER' added (groups: $groups). Authelia picks it up automatically."
  if [ "$generated" = 1 ]; then say "Generated password: $ADMIN_PASSWORD"; fi
  say "To make someone an admin: ./setup.sh add-user --group admins ..."
}

# --- install ---------------------------------------------------------------------------------------
detect_nginx_proxy() { # prints "<container> <network>" of a running nginx-proxy, if any
  have docker || return 0
  local name net
  name=$(docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | awk '$2 ~ /(nginxproxy|jwilder)\/nginx-proxy/ { print $1; exit }') || true
  [ -n "$name" ] || return 0
  net=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$name" 2>/dev/null \
        | tr ' ' '\n' | grep -vE '^(bridge|host|none)?$' | head -n 1) || true
  printf '%s %s\n' "$name" "$net"
}

port_in_use() { # port_in_use 80
  if have ss; then ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1\$"; else return 1; fi
}

cmd_install() {
  step "Checking prerequisites"
  need_docker
  say "Docker $(docker version -f '{{.Server.Version}}' 2>/dev/null || echo '?'), $(docker compose version --short 2>/dev/null || echo compose)"
  [ -f "$DEPLOY/compose.yaml" ] || die "deploy/compose.yaml not found - run this script from a docker-seedbox checkout."

  # ---- configuration ----------------------------------------------------------------------------
  step "Configuration"
  local fresh=0
  if [ ! -f "$ENV_FILE" ]; then cp "$DEPLOY/.env.example" "$ENV_FILE"; fresh=1; fi
  chmod 600 "$ENV_FILE"

  local cur_app cur_auth cur_files cur_cookie
  cur_app=$(env_get APP_HOST); cur_auth=$(env_get AUTH_HOST); cur_files=$(env_get FILES_HOST); cur_cookie=$(env_get COOKIE_DOMAIN)
  if [ "$fresh" = 1 ]; then cur_app=""; cur_auth=""; cur_files=""; cur_cookie=""; fi   # .env.example values are placeholders

  if [ -z "$DOMAIN" ] && [ -n "$cur_app" ]; then DOMAIN=$cur_app; fi
  ask DOMAIN "App domain (e.g. seedbox.example.com)" ""
  DOMAIN=$(lower "$DOMAIN")
  [ -n "$DOMAIN" ] || die "An app domain is required: ./setup.sh --domain seedbox.example.com"
  valid_host "$DOMAIN" || die "'$DOMAIN' is not a valid fully-qualified domain name (hostnames only, no https://)."
  # Changing the domain on a re-run re-derives the other hosts unless they are given explicitly.
  if [ -n "$cur_app" ] && [ "$cur_app" != "$DOMAIN" ]; then cur_auth=""; cur_files=""; cur_cookie=""; fi
  local app_host=$DOMAIN
  local auth_host=${AUTH_HOST_IN:-${cur_auth:-auth.$DOMAIN}}
  local files_host=${FILES_HOST_IN:-${cur_files:-files.$DOMAIN}}
  local cookie_domain=${COOKIE_IN:-${cur_cookie:-$DOMAIN}}
  auth_host=$(lower "$auth_host"); files_host=$(lower "$files_host"); cookie_domain=$(lower "$cookie_domain")
  local h
  for h in "$auth_host" "$files_host" "$cookie_domain"; do valid_host "$h" || die "'$h' is not a valid hostname."; done
  case "$app_host" in *".$cookie_domain"|"$cookie_domain") ;; *) die "APP_HOST ($app_host) must be inside the cookie domain ($cookie_domain). Use --cookie-domain." ;; esac
  case "$auth_host" in *".$cookie_domain"|"$cookie_domain") ;; *) die "AUTH_HOST ($auth_host) must be inside the cookie domain ($cookie_domain). Use --cookie-domain." ;; esac
  [ "$app_host" != "$auth_host" ] && [ "$app_host" != "$files_host" ] && [ "$auth_host" != "$files_host" ] \
    || die "APP_HOST, AUTH_HOST and FILES_HOST must be three different hostnames."

  # ---- proxy mode ---------------------------------------------------------------------------------
  local cur_files_compose detected det_name det_net
  cur_files_compose=$(env_get COMPOSE_FILE)
  if [ -z "$PROXY" ] && [ "$fresh" = 0 ]; then
    case "$cur_files_compose" in
      *proxy-bundled*) PROXY=bundled ;; *proxy-external*) PROXY=external ;; *proxy-none*) PROXY=none ;;
    esac
  fi
  detected=$(detect_nginx_proxy || true)
  det_name=${detected%% *}; det_net=${detected#* }
  if [ -z "$PROXY" ]; then
    local def=bundled
    if [ -n "$detected" ]; then
      say "Found a running nginx-proxy container ($det_name) on Docker network '$det_net'."
      def=external
    elif port_in_use 80 || port_in_use 443; then
      say "Ports 80/443 are already in use on this host - the bundled proxy would not be able to start."
      def=external
    fi
    say "Reverse proxy:  bundled  = ships nginx-proxy + Let's Encrypt on 80/443 (fresh server)"
    say "                external = join the network of a proxy you already run (nginx-proxy, Traefik, Caddy)"
    say "                none     = publish a local port; you terminate TLS elsewhere (Cloudflare Tunnel, ...)"
    ask PROXY "Proxy mode" "$def"
  fi
  PROXY=$(lower "$PROXY")
  case "$PROXY" in bundled|external|none) ;; *) die "--proxy must be bundled, external or none (got '$PROXY')" ;; esac

  local proxy_network=${PROXY_NETWORK_IN:-$(env_get PROXY_NETWORK)}
  local acme_email=${ACME_EMAIL_IN:-$(env_get ACME_EMAIL)}
  if [ "$PROXY" = external ]; then
    if [ -z "$proxy_network" ] && [ -n "$det_net" ]; then proxy_network=$det_net; fi
    PROXY_NETWORK_IN=$proxy_network
    ask PROXY_NETWORK_IN "Docker network of your reverse proxy" ""
    proxy_network=$PROXY_NETWORK_IN
    [ -n "$proxy_network" ] || die "External mode needs --proxy-network (the Docker network your proxy is on; see: docker network ls)"
    if [ "$NO_START" = 0 ]; then
      docker network inspect "$proxy_network" >/dev/null 2>&1 || die "Docker network '$proxy_network' does not exist."
    fi
  fi
  if [ "$PROXY" != none ] && [ -z "$acme_email" ]; then
    ACME_EMAIL_IN=""
    ask ACME_EMAIL_IN "E-mail for Let's Encrypt expiry notices (optional)" ""
    acme_email=$ACME_EMAIL_IN
  fi

  # ---- write .env -------------------------------------------------------------------------------------
  env_put APP_HOST "$app_host"
  env_put AUTH_HOST "$auth_host"
  env_put FILES_HOST "$files_host"
  env_put COOKIE_DOMAIN "$cookie_domain"
  env_put COMPOSE_FILE "compose.yaml:compose.proxy-$PROXY.yaml"
  [ -z "$proxy_network" ] || env_put PROXY_NETWORK "$proxy_network"
  [ -z "$acme_email" ] || env_put ACME_EMAIL "$acme_email"
  if [ "$(env_get AUTH_MODE)" = external ]; then
    env_put COMPOSE_PROFILES ""
  else
    env_put AUTH_MODE authelia
    env_put COMPOSE_PROFILES authelia
  fi
  [ -n "$(env_get SEEDBOX_REGISTRY)" ] || env_put SEEDBOX_REGISTRY ghcr.io/ma-04
  [ -n "$(env_get SEEDBOX_VERSION)" ] || env_put SEEDBOX_VERSION latest
  # One source of truth: LAN_CIDRS. The static addresses of vpn/api/worker (api and worker are the only ones
  # qBittorrent's WebUI trusts) and the dynamic range must lie inside it, so they are always re-derived from it.
  local lan lan_vpn lan_api lan_worker lan_range
  lan=$(env_get LAN_CIDRS); lan=${lan:-172.31.250.0/24}
  read -r lan_vpn lan_api lan_worker lan_range < <(lan_ips "$lan") || die "LAN_CIDRS '$lan' is not a valid IPv4 CIDR (/8 to /26)"
  env_put LAN_CIDRS "$lan"; env_put VPN_IPV4 "$lan_vpn"; env_put API_IP "$lan_api"; env_put WORKER_IP "$lan_worker"
  env_put LAN_IP_RANGE "$lan_range"

  # Secrets: generated once, never overwritten.
  env_ensure APP_SECRET "$(gen_hex 32)"
  env_ensure GATEWAY_SECRET "$(gen_hex 32)"
  env_ensure VPN_CONTROL_TOKEN "$(gen_hex 24)"
  env_ensure AUTHELIA_SESSION_SECRET "$(gen_hex 32)"
  env_ensure AUTHELIA_STORAGE_ENCRYPTION_KEY "$(gen_hex 32)"
  env_ensure AUTHELIA_JWT_SECRET "$(gen_hex 32)"
  chmod 600 "$ENV_FILE"
  say "Wrote $ENV_FILE (mode 600). Keep it: it holds the encryption secrets."

  # ---- first admin user ---------------------------------------------------------------------------------
  local generated_pw=""
  if [ "$(env_get AUTH_MODE)" = authelia ]; then
    mkdir -p "$USERS_DIR"
    if [ -f "$USERS_FILE" ] && [ -z "$ADMIN_USER" ] && [ -z "$ADMIN_PASSWORD" ]; then
      say "Users file already exists - not creating another admin (use ./setup.sh add-user)."
    else
      step "First admin user"
      ask ADMIN_USER "Admin username" "admin"
      ADMIN_USER=$(lower "${ADMIN_USER:-admin}")
      ask ADMIN_EMAIL "Admin e-mail" "admin@$cookie_domain"
      ask_secret ADMIN_PASSWORD "Admin password (empty = generate one)"
      if user_exists "$ADMIN_USER"; then
        say "User '$ADMIN_USER' already exists - leaving it unchanged."
      else
        if [ -z "$ADMIN_PASSWORD" ]; then ADMIN_PASSWORD=$(gen_password); generated_pw=$ADMIN_PASSWORD; fi
        write_user "$ADMIN_USER" "$ADMIN_PASSWORD" "${ADMIN_EMAIL:-admin@$cookie_domain}" "admins,users"
        say "Created admin '$ADMIN_USER' in $USERS_FILE"
      fi
    fi
  fi

  step "Validating the compose configuration"
  dc config -q || die "docker compose config failed - see the message above."

  if [ "$NO_START" = 1 ]; then
    say "--no-start: configuration written, nothing started. Next: (cd deploy && docker compose up -d)"
    print_summary "$generated_pw"
    return 0
  fi

  # ---- images -------------------------------------------------------------------------------------------------
  if [ "$BUILD" = 1 ]; then
    step "Building images from this clone (first build takes a few minutes)"
    dc build
  else
    step "Pulling images"
    if ! dc pull; then
      warn "Pulling failed (images not published for this version yet?). Falling back to a local build."
      dc build
    fi
  fi

  step "Starting the stack"
  dc up -d --remove-orphans --wait --wait-timeout 300 || {
    dc ps || true
    die "Some containers did not become healthy. Inspect with: (cd deploy && docker compose logs --tail 50)   or ./setup.sh doctor"
  }
  print_summary "$generated_pw"
}

print_summary() {
  local gen_pw=${1:-} proxy scheme app auth files
  app=$(env_get APP_HOST); auth=$(env_get AUTH_HOST); files=$(env_get FILES_HOST)
  scheme=$(env_get PUBLIC_SCHEME); scheme=${scheme:-https}
  case "$(env_get COMPOSE_FILE)" in *proxy-bundled*) proxy=bundled ;; *proxy-external*) proxy=external ;; *) proxy=none ;; esac
  step "Done"
  say "Open:   ${B}$scheme://$app${N}"
  say "Login:  $scheme://$auth  (you are redirected there automatically)"
  [ -z "$gen_pw" ] || say "Admin password (shown once, change it later): ${B}$gen_pw${N}"
  say ""
  say "DNS records you need (all pointing at this server's public IP):"
  say "    $app     A/AAAA  <server-ip>"
  say "    $auth    A/AAAA  <server-ip>"
  say "    $files   A/AAAA  <server-ip>"
  case "$proxy" in
    bundled) say "Ports 80 and 443 must be reachable from the internet (Let's Encrypt validates over port 80)." ;;
    external) say "Your reverse proxy must forward all three hosts to the gateway (nginx-proxy does this automatically)." ;;
    none) say "Gateway is published on $(env_get HTTP_BIND):$(env_get HTTP_PORT). Terminate TLS in front of it and send"
          say "X-Forwarded-Proto: https - Authelia's login cookie only works over https (see docs/deployment.md)." ;;
  esac
  say ""
  say "Next steps:"
  say "  1. Log in, open Admin -> Destinations and add where finished downloads go (Google Drive, S3/B2, local)."
  say "  2. Optional: Admin -> VPN: upload WireGuard configs, then set VPN mode to 'required'."
  say "  3. ./setup.sh doctor   checks DNS, TLS, containers and the VPN prerequisites."
  say "  4. ./setup.sh add-user adds more logins;  ./setup.sh update  upgrades."
}

# --- update ----------------------------------------------------------------------------------------------------
cmd_update() {
  need_docker
  [ -f "$ENV_FILE" ] || die "No deploy/.env yet - run ./setup.sh first."
  if [ "$BUILD" = 1 ]; then
    step "Rebuilding images from this clone"
    dc build --pull
  else
    step "Pulling newer images"
    dc pull
  fi
  step "Restarting changed services"
  dc up -d --remove-orphans --wait --wait-timeout 300
  say "Updated. The 'data' volume (database) is untouched; migrations run on api start."
}

# --- doctor ----------------------------------------------------------------------------------------------------
OKS=0; FAILS=0; WARNS=0
ok()   { OKS=$((OKS + 1)); printf '  %s[ok]%s   %s\n' "$G" "$N" "$*"; }
bad()  { FAILS=$((FAILS + 1)); printf '  %s[FAIL]%s %s\n' "$R" "$N" "$*"; }
meh()  { WARNS=$((WARNS + 1)); printf '  %s[warn]%s %s\n' "$Y" "$N" "$*"; }

resolve_host() {
  if have getent; then getent ahosts "$1" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' '
  elif have dig; then dig +short "$1" 2>/dev/null | tr '\n' ' '
  elif have host; then host "$1" 2>/dev/null | awk '/has address|has IPv6/ {print $NF}' | tr '\n' ' '
  elif have nslookup; then nslookup "$1" 2>/dev/null | awk '/^Address/ && !/#/ {print $2}' | tr '\n' ' '
  fi
}

cmd_doctor() {
  step "docker-seedbox doctor"
  if have docker && docker info >/dev/null 2>&1; then ok "Docker daemon reachable"; else bad "Docker is not installed or not running"; fi
  if docker compose version >/dev/null 2>&1; then ok "Docker Compose $(docker compose version --short)"; else bad "Docker Compose v2 missing"; fi
  if [ ! -f "$ENV_FILE" ]; then bad "deploy/.env missing - run ./setup.sh"; summary_doctor; return; fi
  ok "deploy/.env present"
  local perm
  perm=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null || echo "")
  if [ -n "$perm" ] && [ "$perm" != 600 ]; then meh "deploy/.env has mode $perm; run: chmod 600 deploy/.env"; fi

  say ""; say "DNS"
  local h ips
  for h in "$(env_get APP_HOST)" "$(env_get AUTH_HOST)" "$(env_get FILES_HOST)"; do
    ips=$(resolve_host "$h" || true)
    if [ -n "$ips" ]; then ok "$h -> $ips"; else bad "$h does not resolve (add an A/AAAA record)"; fi
  done

  say ""; say "Containers"
  if dc ps -a >/dev/null 2>&1; then
    local svc state health code
    while IFS='|' read -r svc state health code; do
      [ -n "$svc" ] || continue
      if [ "$state" = running ] && { [ "$health" = healthy ] || [ -z "$health" ]; }; then ok "$svc: $state ${health:+($health)}"
      elif [ "$state" = exited ] && [ "$code" = 0 ]; then ok "$svc: finished (exit 0; one-shot service)"
      else bad "$svc: $state ${health:+($health)} - see: (cd deploy && docker compose logs --tail 50 $svc)"; fi
    done < <(dc ps -a --format '{{.Service}}|{{.State}}|{{.Health}}|{{.ExitCode}}' 2>/dev/null)
    [ -n "$(dc ps -a -q 2>/dev/null)" ] || bad "No containers: start with ./setup.sh or (cd deploy && docker compose up -d)"
  else
    bad "docker compose ps failed (invalid configuration?)"
  fi

  say ""; say "HTTPS reachability"
  if have curl; then
    local scheme code
    scheme=$(env_get PUBLIC_SCHEME); scheme=${scheme:-https}
    for h in "$(env_get APP_HOST)" "$(env_get AUTH_HOST)" "$(env_get FILES_HOST)"; do
      code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$scheme://$h/healthz" 2>/dev/null || true)
      if [ "$code" = 200 ]; then ok "$scheme://$h/healthz -> 200"; else bad "$scheme://$h/healthz -> ${code:-no response} (DNS, firewall, certificate or proxy mapping?)"; fi
    done
  else
    meh "curl not installed; skipping HTTPS checks"
  fi

  say ""; say "VPN prerequisites"
  # The sidecar uses the kernel's WireGuard through netlink (NET_ADMIN); it needs no /dev/net/tun.
  if [ -d /sys/module/wireguard ]; then ok "WireGuard kernel module loaded/built in"
  elif have modinfo && modinfo wireguard >/dev/null 2>&1; then ok "WireGuard kernel module available (loads on demand)"
  elif have modprobe && modprobe -n wireguard >/dev/null 2>&1; then ok "WireGuard kernel module available (loads on demand)"
  else meh "Could not confirm WireGuard kernel support (kernel >= 5.6 includes it; containers/VMs may hide it). If the VPN fails to connect: sudo modprobe wireguard"; fi

  say ""; say "Disk"
  local root avail_kb
  root=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)
  [ -n "$root" ] && [ -d "$root" ] || root=$DEPLOY
  avail_kb=$(df -Pk "$root" 2>/dev/null | awk 'NR==2 {print $4}')
  if [ -n "$avail_kb" ]; then
    if [ "$avail_kb" -lt 10485760 ]; then meh "Only $((avail_kb / 1048576)) GiB free under $root (torrents need room; see limits.minFreeDiskBytes)"
    else ok "$((avail_kb / 1048576)) GiB free under $root"; fi
  fi
  summary_doctor
}

summary_doctor() {
  say ""
  say "$OKS ok, $WARNS warnings, $FAILS failures"
  [ "$FAILS" -eq 0 ]
}

case "$CMD" in
  install) cmd_install ;;
  add-user) cmd_add_user ;;
  update) cmd_update ;;
  doctor) cmd_doctor ;;
esac
