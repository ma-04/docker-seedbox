#!/usr/bin/env bash
# docker-seedbox setup: generates secrets, writes deploy/.env, creates the first admin user,
# pulls (or builds) the images and starts the stack. Safe to re-run: existing secrets and
# settings are kept, only missing values are added.
#
#   ./setup.sh                       interactive install
#   ./setup.sh --domain seedbox.example.com --admin-email me@example.com --yes
#   ./setup.sh add-user              add a login (Authelia mode)
#   ./setup.sh update                move to the newest release (or --version X.Y.Z|latest|edge) and restart
#   ./setup.sh backup                archive .env, the Authelia users and the data volume
#   ./setup.sh restore FILE          put such an archive back
#   ./setup.sh doctor                check DNS, containers, VPN prerequisites, disk space
#
# Run `./setup.sh --help` for all options. Docs: docs/deployment.md
set -euo pipefail
umask 077            # .env, the users file and every temp file are never world-readable, not even for an instant
export LC_ALL=C      # byte-wise regexes/classes below; no locale surprises

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEPLOY="$ROOT/deploy"
ENV_FILE="$DEPLOY/.env"
USERS_DIR="$DEPLOY/authelia/users"
USERS_FILE="$USERS_DIR/users_database.yml"
FPR_FILE=.app-secret-fingerprint   # inside the data volume

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
  update              move to the newest release (or --version X.Y.Z|latest|edge), pull and restart; on edge it stays on
                      edge unless --version says otherwise; add --build to rebuild from this clone
  backup              archive deploy/.env, the Authelia users and the data volume (--out FILE_OR_DIR)
  restore FILE        put a backup archive back (replaces .env, users and the data volume; asks first unless --yes)
  doctor              diagnose DNS, containers, the WireGuard kernel module, disk space, APP_SECRET and version

Install options (each also readable from the environment as SEEDBOX_<NAME>, e.g. SEEDBOX_DOMAIN):
  --domain DOMAIN        the one hostname, e.g. seedbox.example.com: app, login page (/auth/) and downloads (/dl/)
  --files-host HOST      serve downloads from this separate host instead of <domain>/dl/ (isolates downloaded
                         files from the app's origin; see SECURITY.md). Asked on an interactive first install.
  --auth-host HOST       serve the login portal from this separate host instead of <domain>/auth/
  --single-domain        move an existing install with separate login/download hosts back to the one domain
  --cookie-domain DOMAIN domain of the login cookie (default: <domain>; with --auth-host, a parent of both hosts)
  --admin-user NAME      first admin login            (default admin; letters, digits . _ -)
  --admin-password PW    its password                 (default: generated and printed once)
  --admin-email MAIL     its e-mail address
  --auth-mode MODE       authelia (default) | external (your own SSO in front of the gateway)
  --proxy MODE           bundled | external | none
  --proxy-network NAME   Docker network of your existing reverse proxy (external mode)
  --acme-email MAIL      e-mail for Let's Encrypt (bundled / nginx-proxy + acme-companion)
  --version VERSION      image version to run: X.Y.Z, latest (= the newest release, pinned as its X.Y.Z), edge (the
                         head of main, CI-tested, not for production) or local (default: the newest release; with none
                         published yet, edge; with neither in the registry, the images are built from this clone)
  --build                build images from this clone instead of pulling from GHCR
  --no-start             write configuration only; do not pull or start anything
  --yes, -y              never prompt; use flags/env/defaults

Other options:
  --allow-downgrade      update: allow moving to an older version (database migrations are not reversible: restore a backup)
  --accept-new-secret    install/update: continue although APP_SECRET differs from the one the database was created with
                         (stored destination credentials and VPN configs become unreadable)
  --i-know-external-auth-is-unsafe
                         allow AUTH_MODE=external together with the bundled proxy, which publishes the gateway on 80/443
                         WITHOUT anything in front of it that authenticates: anyone can then claim any identity
  --out PATH             backup: archive file, or directory to put it in (default: ./seedbox-backup-<time>.tar.gz)
  --help, -h             this text
EOF
}

# --- argument parsing ------------------------------------------------------------------------
CMD=install
DOMAIN=${SEEDBOX_DOMAIN:-}; AUTH_HOST_IN=${SEEDBOX_AUTH_HOST:-}; FILES_HOST_IN=${SEEDBOX_FILES_HOST:-}
COOKIE_IN=${SEEDBOX_COOKIE_DOMAIN:-}; SINGLE_DOMAIN=${SEEDBOX_SINGLE_DOMAIN:-0}
ADMIN_USER=${SEEDBOX_ADMIN_USER:-}; ADMIN_PASSWORD=${SEEDBOX_ADMIN_PASSWORD:-}; ADMIN_EMAIL=${SEEDBOX_ADMIN_EMAIL:-}
PROXY=${SEEDBOX_PROXY:-}; PROXY_NETWORK_IN=${SEEDBOX_PROXY_NETWORK:-}; ACME_EMAIL_IN=${SEEDBOX_ACME_EMAIL:-}
AUTH_MODE_IN=${SEEDBOX_AUTH_MODE:-}; VERSION_IN=${SEEDBOX_VERSION_OVERRIDE:-}
BUILD=${SEEDBOX_BUILD:-0}; YES=${SEEDBOX_YES:-0}; NO_START=0; USER_GROUP=users
ALLOW_DOWNGRADE=0; ACCEPT_NEW_SECRET=0; I_KNOW=${SEEDBOX_I_KNOW_EXTERNAL_AUTH_IS_UNSAFE:-0}
BACKUP_OUT=""; RESTORE_FILE=""

if [ $# -gt 0 ]; then
  case "$1" in install|add-user|update|doctor|backup|restore) CMD=$1; shift ;; esac
fi
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN=${2:?--domain needs a value}; shift 2 ;;
    --auth-host) AUTH_HOST_IN=${2:?}; shift 2 ;;
    --files-host) FILES_HOST_IN=${2:?}; shift 2 ;;
    --cookie-domain) COOKIE_IN=${2:?}; shift 2 ;;
    --single-domain) SINGLE_DOMAIN=1; shift ;;
    --admin-user) ADMIN_USER=${2:?}; shift 2 ;;
    --admin-password) ADMIN_PASSWORD=${2:?}; shift 2 ;;
    --admin-email) ADMIN_EMAIL=${2:?}; shift 2 ;;
    --group) USER_GROUP=${2:?}; shift 2 ;;
    --auth-mode) AUTH_MODE_IN=${2:?}; shift 2 ;;
    --proxy) PROXY=${2:?}; shift 2 ;;
    --proxy-network) PROXY_NETWORK_IN=${2:?}; shift 2 ;;
    --acme-email) ACME_EMAIL_IN=${2:?}; shift 2 ;;
    --version) VERSION_IN=${2:?}; shift 2 ;;
    --out) BACKUP_OUT=${2:?}; shift 2 ;;
    --build) BUILD=1; shift ;;
    --no-start) NO_START=1; shift ;;
    --allow-downgrade) ALLOW_DOWNGRADE=1; shift ;;
    --accept-new-secret) ACCEPT_NEW_SECRET=1; shift ;;
    --i-know-external-auth-is-unsafe) I_KNOW=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --help|-h) usage; exit 0 ;;
    -*) usage >&2; die "Unknown option: $1" ;;
    *)
      if [ "$CMD" = restore ] && [ -z "$RESTORE_FILE" ]; then RESTORE_FILE=$1; shift
      else usage >&2; die "Unexpected argument: $1"; fi ;;
  esac
done

INTERACTIVE=1
if [ "$YES" = 1 ] || [ ! -t 0 ]; then INTERACTIVE=0; fi

# --- input validation ----------------------------------------------------------------------------
# Every value that ends up in deploy/.env, the Authelia users file or a docker command line is checked as a WHOLE
# string: a check that works line by line (grep) lets "bob\n  evil: ..." through its first line.
has_ctl() { [[ $1 == *[[:cntrl:]]* ]]; }   # newline, CR, tab, ESC, DEL, ...
reject_ctl() { # reject_ctl NAME VALUE
  if has_ctl "$2"; then die "$1 must not contain newlines or control characters."; fi
  return 0
}
HOST_RE='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
USER_RE='^[a-zA-Z0-9._-]{1,64}$'
EMAIL_RE='^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]+$'
NETWORK_RE='^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$'
GROUP_RE='^[a-z0-9][a-z0-9_-]{0,31}$'
VERSION_RE='^(latest|edge|local|[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)$'
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
# Host values are compared the way the gateway, Authelia and the API read them: surrounding blanks dropped, lowercase.
norm_host() { local v; v=$(lower "$1"); v=${v#"${v%%[![:space:]]*}"}; printf '%s' "${v%"${v##*[![:space:]]}"}"; }
valid_host() { [ "${#1}" -le 253 ] && [[ $1 =~ $HOST_RE ]]; }
valid_user() { [[ $1 =~ $USER_RE ]]; }
valid_email() { [ "${#1}" -le 254 ] && [[ $1 =~ $EMAIL_RE ]] && valid_host "$(lower "${1#*@}")"; }
valid_network() { [[ $1 =~ $NETWORK_RE ]]; }
valid_group() { [[ $1 =~ $GROUP_RE ]]; }
valid_version() { [[ $1 =~ $VERSION_RE ]]; }

reject_ctl "--domain" "$DOMAIN"; reject_ctl "--auth-host" "$AUTH_HOST_IN"; reject_ctl "--files-host" "$FILES_HOST_IN"
reject_ctl "--cookie-domain" "$COOKIE_IN"; reject_ctl "--admin-user" "$ADMIN_USER"; reject_ctl "--admin-password" "$ADMIN_PASSWORD"
reject_ctl "--admin-email" "$ADMIN_EMAIL"; reject_ctl "--proxy" "$PROXY"; reject_ctl "--proxy-network" "$PROXY_NETWORK_IN"
reject_ctl "--acme-email" "$ACME_EMAIL_IN"; reject_ctl "--group" "$USER_GROUP"; reject_ctl "--auth-mode" "$AUTH_MODE_IN"
reject_ctl "--version" "$VERSION_IN"; reject_ctl "--out" "$BACKUP_OUT"; reject_ctl "restore file" "$RESTORE_FILE"
[ -z "$ADMIN_USER" ] || valid_user "$ADMIN_USER" || die "Invalid user name: use 1-64 letters, digits, '.', '_' or '-'."
[ -z "$ADMIN_EMAIL" ] || valid_email "$ADMIN_EMAIL" || die "Invalid admin e-mail address."
[ -z "$ACME_EMAIL_IN" ] || valid_email "$ACME_EMAIL_IN" || die "Invalid --acme-email address."
[ -z "$PROXY_NETWORK_IN" ] || valid_network "$PROXY_NETWORK_IN" || die "Invalid Docker network name '$PROXY_NETWORK_IN'."
valid_group "$USER_GROUP" || die "Invalid group name '$USER_GROUP' (lowercase letters, digits, '_' or '-')."
[ -z "$VERSION_IN" ] || valid_version "$VERSION_IN" || die "Invalid --version '$VERSION_IN' (use X.Y.Z, latest, edge or local)."
case "$AUTH_MODE_IN" in ""|authelia|external) ;; *) die "--auth-mode must be authelia or external." ;; esac
case "$SINGLE_DOMAIN" in 0|1) ;; *) die "SEEDBOX_SINGLE_DOMAIN must be 0 or 1." ;; esac

# --- small utilities ---------------------------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }
dc() { (cd "$DEPLOY" && docker compose "$@"); }

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
sha256_hex() {
  if have sha256sum; then sha256sum | awk '{print $1}'
  elif have shasum; then shasum -a 256 | awk '{print $1}'
  else openssl dgst -sha256 | awk '{print $NF}'; fi
}

env_get() { # env_get KEY -> value (empty if missing)
  [ -f "$ENV_FILE" ] || return 0
  awk -v k="$1" 'index($0, k "=") == 1 { print substr($0, length(k) + 2); exit }' "$ENV_FILE"
}
env_put() { # env_put KEY VALUE : replace the line (or append). Edits in place, keeps mode.
  local k=$1 v=$2 tmp
  if has_ctl "$v"; then die "Refusing to write a value with newlines or control characters to $ENV_FILE ($k)."; fi
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
confirm() { # confirm "question" [default y|n] -> 0 for yes. Non-interactive: the default (--yes: always yes).
  local q=$1 def=${2:-y} reply
  if [ "$YES" = 1 ]; then return 0; fi
  if [ "$INTERACTIVE" = 0 ]; then [ "$def" = y ]; return; fi
  if [ "$def" = y ]; then printf '%s [Y/n]: ' "$q"; else printf '%s [y/N]: ' "$q"; fi
  IFS= read -r reply || reply=""
  reply=${reply:-$def}
  case "$reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

yaml_q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }

ver_ge() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$2" ]; }   # $1 >= $2

need_docker() {
  have docker || die "Docker is not installed. See https://docs.docker.com/engine/install/"
  docker info >/dev/null 2>&1 || die "Cannot talk to the Docker daemon (is it running, and are you in the 'docker' group?)"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required ('docker compose', not 'docker-compose'). See https://docs.docker.com/compose/install/"
  # compose.yaml mounts only incomplete/ into qBittorrent and only library/ into the gateway/api (volume.subpath):
  # that needs Docker Engine 26+ (API 1.45) and Compose 2.26+.
  local engine comp
  engine=$(docker version -f '{{.Server.Version}}' 2>/dev/null || true); comp=$(docker compose version --short 2>/dev/null || true); comp=${comp#v}
  if [[ $engine =~ ^[0-9]+\.[0-9]+ ]] && ! ver_ge "$engine" 26.0; then
    die "Docker Engine $engine is too old: this stack needs 26.0 or newer (volume subpaths). Upgrade Docker: https://docs.docker.com/engine/install/"
  fi
  if [[ $comp =~ ^[0-9]+\.[0-9]+ ]] && ! ver_ge "$comp" 2.26; then
    die "Docker Compose $comp is too old: this stack needs 2.26 or newer (volume subpaths). See https://docs.docker.com/compose/install/"
  fi
}

authelia_image() { # single source of truth: deploy/compose.yaml (tag, and @sha256 digest when pinned)
  sed -n 's/^[[:space:]]*image:[[:space:]]*\(authelia\/authelia:[^[:space:]]*\).*/\1/p' "$DEPLOY/compose.yaml" | head -n 1
}
helper_image() { # the busybox of the init service: used for volume housekeeping (backup, restore, fingerprint)
  sed -n 's/^[[:space:]]*image:[[:space:]]*\(busybox:[^[:space:]]*\).*/\1/p' "$DEPLOY/compose.yaml" | head -n 1
}

# --- Docker volumes (backup, restore, APP_SECRET fingerprint) ---------------------------------------
project_name() {
  local p=${COMPOSE_PROJECT_NAME:-}
  [ -n "$p" ] || p=$(env_get COMPOSE_PROJECT_NAME)
  printf '%s' "${p:-seedbox}"
}
vol_name() { # vol_name data -> the Docker volume compose created for it (empty if none)
  docker volume ls -q --filter "label=com.docker.compose.project=$(project_name)" --filter "label=com.docker.compose.volume=$1" | head -n 1
}
vol_run() { # vol_run VOLUME MODE(ro|rw) EXTRA_DOCKER_ARGS... -- SHELL_SNIPPET   (root, no network, pinned busybox)
  local vol=$1 mode=$2; shift 2
  local extra=()
  while [ "$1" != "--" ]; do extra+=("$1"); shift; done
  shift
  docker run --rm --network none --user 0:0 -v "$vol:/v:$mode" ${extra[@]+"${extra[@]}"} "$(helper_image)" sh -c "$1"
}

# A change of APP_SECRET makes every encrypted value in the database (destination credentials, torrent sources,
# VPN configs) unreadable. A short non-secret fingerprint of the secret is kept NEXT TO THE DATA (in the data
# volume), so a regenerated or edited deploy/.env is noticed instead of silently producing an unusable install.
secret_fpr() { printf 'docker-seedbox app-secret fingerprint v1\n%s' "$(env_get APP_SECRET)" | sha256_hex | cut -c1-16; }
fpr_stored() { # prints the fingerprint stored in the data volume, nothing if none/no volume
  local vol; vol=$(vol_name data)
  [ -n "$vol" ] || return 0
  vol_run "$vol" ro -- "cat /v/$FPR_FILE 2>/dev/null || true" 2>/dev/null || true
}
fpr_record() { # write the fingerprint if the volume has none (fresh install, or one that predates this check)
  local vol; vol=$(vol_name data)
  [ -n "$vol" ] || return 0
  [ -z "$(fpr_stored)" ] || return 0
  vol_run "$vol" rw -e "FPR=$(secret_fpr)" -- "printf '%s' \"\$FPR\" > /v/$FPR_FILE && chown 1000:1000 /v/$FPR_FILE && chmod 644 /v/$FPR_FILE" >/dev/null 2>&1 \
    || warn "Could not record the APP_SECRET fingerprint in the data volume."
}
fpr_check() { # fpr_check [force] : die (or warn when force) when the data volume belongs to a different APP_SECRET
  local stored
  stored=$(fpr_stored)
  [ -n "$stored" ] || return 0
  [ "$stored" != "$(secret_fpr)" ] || return 0
  if [ "$ACCEPT_NEW_SECRET" = 1 ]; then
    warn "APP_SECRET differs from the one the database was created with. Stored credentials (destinations, VPN configs, torrent sources) are UNREADABLE; re-enter them in the Admin UI."
    local vol; vol=$(vol_name data)
    vol_run "$vol" rw -e "FPR=$(secret_fpr)" -- "printf '%s' \"\$FPR\" > /v/$FPR_FILE" >/dev/null 2>&1 || true
    return 0
  fi
  die "APP_SECRET in $ENV_FILE is not the one the existing database in volume '$(vol_name data)' was created with.
Everything encrypted in that database (destination credentials, VPN configs, torrent sources) would be unreadable.
  - Restore your original deploy/.env (or './setup.sh restore <backup>'), then run this again; or
  - if the secret is really lost, continue with --accept-new-secret and re-enter those credentials in the Admin UI."
}

# --- AUTH_MODE=external + bundled proxy -----------------------------------------------------------
check_auth_proxy() { # check_auth_proxy AUTH_MODE PROXY
  [ "$1" = external ] && [ "$2" = bundled ] || return 0
  if [ "$I_KNOW" = 1 ] || [ "$(env_get ALLOW_EXTERNAL_AUTH_WITH_BUNDLED_PROXY)" = 1 ]; then
    warn "AUTH_MODE=external with the bundled proxy: the gateway is on the internet with NO authentication in front of it. Anyone can send 'Remote-User: admin'."
    return 0
  fi
  die "AUTH_MODE=external together with the bundled proxy publishes the gateway on ports 80/443 with nothing that authenticates.
In external mode the gateway trusts the Remote-User/Remote-Groups headers: anyone could claim to be an admin.
Put your SSO proxy in front (use --proxy external or --proxy none and reach the gateway only through it), or pass
--i-know-external-auth-is-unsafe if something else (a firewall, a tunnel) really guarantees that only your SSO can reach the gateway."
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
  # On a fresh host `docker run` first pulls the image and prints "Digest: sha256:..." too: take only the argon2 line.
  # shellcheck disable=SC2016  # the $ in the pattern is literal
  printf '%s\n' "$out" | sed -n 's/^Digest: \(\$argon2.*\)$/\1/p' | head -n 1
}

user_exists() { [ -f "$USERS_FILE" ] && grep -qxF "  $1:" "$USERS_FILE"; }

write_user() { # write_user NAME PASSWORD EMAIL GROUPS(comma-separated)
  local name=$1 pw=$2 email=$3 groups=$4 digest g
  reject_ctl "user name" "$name"; reject_ctl "e-mail" "$email"; reject_ctl "password" "$pw"; reject_ctl "groups" "$groups"
  valid_user "$name" || die "Invalid user name '$name' (use 1-64 letters, digits, . _ -)"
  [[ $name =~ ^[a-z0-9] ]] || die "Invalid user name '$name' (must start with a letter or digit)"
  valid_email "$email" || die "Invalid e-mail address '$email'"
  [ "${#pw}" -ge 8 ] || die "Password must be at least 8 characters"
  for g in $(printf '%s' "$groups" | tr ',' ' '); do valid_group "$g" || die "Invalid group name '$g'"; done
  user_exists "$name" && die "User '$name' already exists in $USERS_FILE"
  digest=$(hash_password "$pw")
  # shellcheck disable=SC2016
  case "$digest" in '$argon2'*) ;; *) die "Unexpected hash output from Authelia" ;; esac
  mkdir -p "$USERS_DIR"
  [ -f "$USERS_FILE" ] || { printf 'users:\n' >"$USERS_FILE"; }
  chmod 600 "$USERS_FILE"
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
  reject_ctl "username" "$ADMIN_USER"; reject_ctl "e-mail" "$ADMIN_EMAIL"
  valid_user "$ADMIN_USER" || die "Invalid user name: use 1-64 letters, digits, '.', '_' or '-'."
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

# --- releases and images ---------------------------------------------------------------------------
registry() { local r; r=$(env_get SEEDBOX_REGISTRY); printf '%s' "${r:-ghcr.io/ma-04}"; }

latest_release() { # prints X.Y.Z of the newest non-prerelease GitHub release; nothing when unknown (none yet, offline, rate-limited)
  local reg owner repo body tag
  reg=$(registry)
  case "$reg" in ghcr.io/*) owner=${reg#ghcr.io/}; owner=${owner%%/*} ;; *) return 0 ;; esac
  repo=${SEEDBOX_REPO:-$owner/docker-seedbox}
  have curl || return 0
  body=$(curl -fsS -m 5 -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$repo/releases/latest" 2>/dev/null) || return 0
  tag=$(printf '%s\n' "$body" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([0-9][^"]*\)".*/\1/p' | head -n 1)
  if [ -n "$tag" ] && valid_version "$tag"; then printf '%s' "$tag"; fi
  return 0
}

image_exists() { # image_exists VERSION : is the vpn image of that version in the registry? (all five are pushed together)
  local ref; ref="$(registry)/docker-seedbox-vpn:$1"
  if have timeout; then timeout 30 docker manifest inspect "$ref" >/dev/null 2>&1; else docker manifest inspect "$ref" >/dev/null 2>&1; fi
}

use_local_build() { # use_local_build REASON : switch this run to building from the clone (asks first when interactive)
  warn "$1"
  if ! confirm "Build the images from this clone instead? (takes a few minutes)" y; then
    die "Nothing to start. Re-run with --build to build locally, or --version X.Y.Z once that release is published."
  fi
  say "Building from this clone."
  BUILD=1
}

resolve_images() { # decide pull-vs-build for install; pins SEEDBOX_VERSION in .env
  if [ "$BUILD" = 1 ]; then env_put SEEDBOX_VERSION local; return 0; fi
  local cur ver
  cur=$(env_get SEEDBOX_VERSION)
  if [ -n "$VERSION_IN" ]; then ver=$VERSION_IN; else ver=${cur:-latest}; fi
  if [ "$ver" = latest ]; then ver=$(latest_release); fi        # pinned as the X.Y.Z it is today
  if [ "$ver" = local ]; then BUILD=1; return 0; fi
  if [ -z "$ver" ]; then
    if [ "$NO_START" = 1 ]; then return 0; fi
    # :latest exists once anything was released: then the lookup failed (offline, rate-limited), not "no release yet".
    # (Only where the lookup applies: for another registry latest_release never asks GitHub.)
    if [ -z "$VERSION_IN" ] && [[ $(registry) == ghcr.io/* ]] && image_exists latest; then
      die "Could not look up the newest release (GitHub API unreachable or rate-limited). Re-run later, or pin one: --version X.Y.Z (https://github.com/${SEEDBOX_REPO:-ma-04/docker-seedbox}/releases)."
    fi
    if [ -z "$VERSION_IN" ] && image_exists edge; then
      warn "No stable release published yet: using the 'edge' images (the head of main, built and tested by CI). Move to a release later with: ./setup.sh update --version latest"
      env_put SEEDBOX_VERSION edge
      return 0
    fi
    use_local_build "No published release found (none yet, GitHub unreachable or rate-limited). The images are not available from $(registry)."
    env_put SEEDBOX_VERSION local
    return 0
  fi
  if [ "$NO_START" = 1 ]; then env_put SEEDBOX_VERSION "$ver"; return 0; fi
  if ! image_exists "$ver"; then
    use_local_build "No published image $(registry)/docker-seedbox-vpn:$ver (not built yet, wrong registry, or the package is private)."
    env_put SEEDBOX_VERSION local
    return 0
  fi
  env_put SEEDBOX_VERSION "$ver"
  say "Using released images, version $ver (pinned as SEEDBOX_VERSION in deploy/.env)."
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
  if [ ! -f "$ENV_FILE" ]; then
    fresh=1
    # A lost deploy/.env next to a surviving database: a new APP_SECRET would make that database unreadable.
    if [ -n "$(fpr_stored)" ] && [ "$ACCEPT_NEW_SECRET" != 1 ]; then
      die "deploy/.env is missing, but the data volume '$(vol_name data)' of project '$(project_name)' already holds a database created with another APP_SECRET.
Generating a new secret would make every stored credential unreadable. Restore your deploy/.env (or run './setup.sh restore <backup>'),
or continue with --accept-new-secret if you want a new secret and will re-enter credentials in the Admin UI."
    fi
    cp "$DEPLOY/.env.example" "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"

  # Hosts layout. Default: ONE domain - the app, the login portal (APP_HOST/auth/) and local downloads (APP_HOST/dl/).
  # Optional, independently: a separate login host (AUTH_HOST) and/or a separate download host (FILES_HOST). Empty
  # AUTH_HOST / FILES_HOST in .env mean "on APP_HOST". Re-runs keep whatever layout .env already has (an existing
  # three-host install stays exactly as it is) unless flags change it.
  local auth_mode=${AUTH_MODE_IN:-$(env_get AUTH_MODE)}
  auth_mode=$(norm_host "${auth_mode:-authelia}")
  case "$auth_mode" in authelia|external) ;; *) die "AUTH_MODE must be authelia or external (got '$auth_mode')" ;; esac

  local cur_app cur_auth cur_files cur_cookie
  cur_app=$(env_get APP_HOST); cur_auth=$(env_get AUTH_HOST); cur_files=$(env_get FILES_HOST); cur_cookie=$(env_get COOKIE_DOMAIN)
  if [ "$fresh" = 1 ]; then cur_app=""; cur_auth=""; cur_files=""; cur_cookie=""; fi   # .env.example values are placeholders
  cur_app=$(norm_host "$cur_app"); cur_auth=$(norm_host "$cur_auth"); cur_files=$(norm_host "$cur_files"); cur_cookie=$(norm_host "$cur_cookie")
  [ "$cur_auth" != "$cur_app" ] || cur_auth=""     # equal to APP_HOST = the single-domain layout
  [ "$cur_files" != "$cur_app" ] || cur_files=""

  if [ -z "$DOMAIN" ] && [ -n "$cur_app" ]; then DOMAIN=$cur_app; fi
  ask DOMAIN "Domain (e.g. seedbox.example.com)" ""
  reject_ctl "domain" "$DOMAIN"
  DOMAIN=$(norm_host "$DOMAIN")
  [ -n "$DOMAIN" ] || die "A domain is required: ./setup.sh --domain seedbox.example.com"
  valid_host "$DOMAIN" || die "'$DOMAIN' is not a valid fully-qualified domain name (hostnames only, no https://)."
  # Changing the domain on a re-run keeps the layout. Only hosts that still are the old derived defaults (auth.<old>,
  # files.<old>) follow the new domain; a host chosen deliberately (e.g. a download domain outside the cookie domain)
  # stays as it is. A cookie domain that was simply the old domain is re-derived; a custom parent is kept (and checked).
  if [ -n "$cur_app" ] && [ "$cur_app" != "$DOMAIN" ]; then
    [ "$cur_auth" != "auth.$cur_app" ] || cur_auth="auth.$DOMAIN"
    [ "$cur_files" != "files.$cur_app" ] || cur_files="files.$DOMAIN"
    [ "$cur_cookie" != "$cur_app" ] || cur_cookie=""
  fi
  local app_host=$DOMAIN auth_host files_host
  if [ "$SINGLE_DOMAIN" = 1 ]; then
    { [ -z "$AUTH_HOST_IN" ] && [ -z "$FILES_HOST_IN" ]; } || die "--single-domain cannot be combined with --auth-host / --files-host."
    cur_auth=""; cur_files=""; cur_cookie=""
  fi
  auth_host=$(norm_host "${AUTH_HOST_IN:-$cur_auth}")
  files_host=$(norm_host "${FILES_HOST_IN:-$cur_files}")
  if [ "$fresh" = 1 ] && [ "$INTERACTIVE" = 1 ] && [ "$SINGLE_DOMAIN" = 0 ]; then
    say "Everything is served from $DOMAIN: the app, the login page ($DOMAIN/auth/) and downloads ($DOMAIN/dl/)."
    if [ -z "$FILES_HOST_IN" ] && confirm "Serve downloads from a separate domain? (isolates downloaded files from the app's origin; one more DNS record)" n; then
      say "Use a name OUTSIDE $DOMAIN (e.g. on another domain you own): a subdomain of $DOMAIN would still receive the login cookie."
      FILES_HOST_IN=""
      ask FILES_HOST_IN "Download hostname (empty = keep downloads on $DOMAIN/dl/)" ""
      files_host=$(norm_host "$FILES_HOST_IN")
    fi
    if [ "$auth_mode" = authelia ] && [ -z "$AUTH_HOST_IN" ] && confirm "Serve the login page from a separate hostname instead of $DOMAIN/auth/? (rarely needed; one more DNS record)" n; then
      AUTH_HOST_IN=""
      ask AUTH_HOST_IN "Login hostname" "auth.$DOMAIN"
      auth_host=$(norm_host "$AUTH_HOST_IN")
    fi
  fi
  reject_ctl "login host" "$auth_host"; reject_ctl "download host" "$files_host"
  [ "$auth_host" != "$app_host" ] || auth_host=""
  [ "$files_host" != "$app_host" ] || files_host=""
  if [ "$auth_mode" = external ] && [ -n "$auth_host" ]; then
    say "AUTH_MODE=external has no login portal: dropping the separate login host $auth_host."
    auth_host=""
  fi
  local h
  for h in "$auth_host" "$files_host"; do [ -z "$h" ] || valid_host "$h" || die "'$h' is not a valid hostname."; done
  if [ -n "$auth_host" ] && [ "$auth_host" = "$files_host" ]; then die "The login host and the download host must be different hostnames."; fi
  # Authelia's session cookie. Portal on APP_HOST: scoped to APP_HOST itself, always (a parent domain left over from a
  # three-host install would send the cookie to sibling hosts, files host included, and allow post-login redirects to
  # them). Separate login host: a parent domain of both, required (--cookie-domain; default: the app domain).
  local cookie_domain
  if [ -z "$auth_host" ]; then
    COOKIE_IN=$(norm_host "$COOKIE_IN")
    if [ -n "$COOKIE_IN" ] && [ "$COOKIE_IN" != "$app_host" ]; then
      die "--cookie-domain only applies with a separate login host (--auth-host): with the portal on $app_host/auth/ the login cookie is scoped to $app_host."
    fi
    if [ -n "$cur_cookie" ] && [ "$cur_cookie" != "$app_host" ]; then
      say "Login cookie domain: $cur_cookie -> $app_host (the portal is on $app_host; users log in once more)."
    fi
    cookie_domain=$app_host
  else
    cookie_domain=$(norm_host "${COOKIE_IN:-${cur_cookie:-$DOMAIN}}")
  fi
  reject_ctl "cookie domain" "$cookie_domain"
  valid_host "$cookie_domain" || die "'$cookie_domain' is not a valid hostname."
  case "$app_host" in *".$cookie_domain"|"$cookie_domain") ;; *) die "APP_HOST ($app_host) must be inside the cookie domain ($cookie_domain). Use --cookie-domain." ;; esac
  if [ -n "$auth_host" ]; then
    case "$auth_host" in *".$cookie_domain"|"$cookie_domain") ;; *) die "AUTH_HOST ($auth_host) must be inside the cookie domain ($cookie_domain). Use --cookie-domain." ;; esac
  fi
  if [ -n "$files_host" ] && in_cookie_domain "$files_host" "$cookie_domain"; then
    warn "The download host $files_host is inside the login cookie's domain ($cookie_domain): browsers send the session cookie there and treat it as same-site. A host outside it (e.g. another registrable domain) isolates downloads fully; see SECURITY.md."
  fi

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

  check_auth_proxy "$auth_mode" "$PROXY"

  local proxy_network=${PROXY_NETWORK_IN:-$(env_get PROXY_NETWORK)}
  local acme_email=${ACME_EMAIL_IN:-$(env_get ACME_EMAIL)}
  if [ "$PROXY" = external ]; then
    if [ -z "$proxy_network" ] && [ -n "$det_net" ]; then proxy_network=$det_net; fi
    PROXY_NETWORK_IN=$proxy_network
    ask PROXY_NETWORK_IN "Docker network of your reverse proxy" ""
    proxy_network=$PROXY_NETWORK_IN
    [ -n "$proxy_network" ] || die "External mode needs --proxy-network (the Docker network your proxy is on; see: docker network ls)"
    reject_ctl "proxy network" "$proxy_network"
    valid_network "$proxy_network" || die "Invalid Docker network name '$proxy_network'."
    if [ "$NO_START" = 0 ]; then
      docker network inspect "$proxy_network" >/dev/null 2>&1 || die "Docker network '$proxy_network' does not exist."
    fi
  fi
  if [ "$PROXY" != none ] && [ -z "$acme_email" ]; then
    ACME_EMAIL_IN=""
    ask ACME_EMAIL_IN "E-mail for Let's Encrypt expiry notices (optional)" ""
    acme_email=$ACME_EMAIL_IN
  fi
  reject_ctl "ACME e-mail" "$acme_email"
  [ -z "$acme_email" ] || valid_email "$acme_email" || die "Invalid ACME e-mail address '$acme_email'."

  # ---- write .env -------------------------------------------------------------------------------------
  env_put APP_HOST "$app_host"
  env_put AUTH_HOST "$auth_host"      # empty = login portal at APP_HOST/auth/
  env_put FILES_HOST "$files_host"    # empty = downloads at APP_HOST/dl/
  env_put COOKIE_DOMAIN "$cookie_domain"
  env_put COMPOSE_FILE "compose.yaml:compose.proxy-$PROXY.yaml"
  [ -z "$proxy_network" ] || env_put PROXY_NETWORK "$proxy_network"
  [ -z "$acme_email" ] || env_put ACME_EMAIL "$acme_email"
  env_put AUTH_MODE "$auth_mode"
  if [ "$auth_mode" = external ]; then
    env_put COMPOSE_PROFILES ""
    if [ "$PROXY" = bundled ]; then env_put ALLOW_EXTERNAL_AUTH_WITH_BUNDLED_PROXY 1; fi
  else
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
  say "Wrote $ENV_FILE (mode 600). Keep it (and back it up: ./setup.sh backup): it holds the encryption secrets."

  # ---- images: released version, or a local build -------------------------------------------------------
  step "Image version"
  resolve_images
  if [ "$BUILD" = 1 ]; then env_put SEEDBOX_VERSION local; fi

  # ---- first admin user ---------------------------------------------------------------------------------
  local generated_pw=""
  if [ "$(env_get AUTH_MODE)" = authelia ]; then
    mkdir -p "$USERS_DIR"
    if [ -f "$USERS_FILE" ] && [ -z "$ADMIN_USER" ] && [ -z "$ADMIN_PASSWORD" ]; then
      say "Users file already exists - not creating another admin (use ./setup.sh add-user)."
    else
      step "First admin user"
      ask ADMIN_USER "Admin username" "admin"
      ADMIN_USER=${ADMIN_USER:-admin}
      reject_ctl "admin username" "$ADMIN_USER"
      valid_user "$ADMIN_USER" || die "Invalid user name: use 1-64 letters, digits, '.', '_' or '-'."
      ADMIN_USER=$(lower "$ADMIN_USER")
      ask ADMIN_EMAIL "Admin e-mail" "admin@$cookie_domain"
      ask_secret ADMIN_PASSWORD "Admin password (empty = generate one)"
      reject_ctl "admin e-mail" "$ADMIN_EMAIL"; reject_ctl "admin password" "$ADMIN_PASSWORD"
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

  fpr_check
  ensure_images
  step "Starting the stack"
  dc up -d --remove-orphans --wait --wait-timeout 300 || {
    dc ps || true
    die "Some containers did not become healthy. Inspect with: (cd deploy && docker compose logs --tail 50)   or ./setup.sh doctor"
  }
  fpr_record
  print_summary "$generated_pw"
}

build_version() { # shown in the web footer: git describe when this is a clone, else the pinned version (or dev)
  local v; v=$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null) || v=${SEEDBOX_BUILD_VERSION:-dev}
  printf '%s' "$v"
}

ensure_images() { # pull the pinned version, or build from this clone
  if [ "$BUILD" = 1 ]; then
    step "Building images from this clone (first build takes a few minutes)"
    export SEEDBOX_BUILD_VERSION; SEEDBOX_BUILD_VERSION=$(build_version)
    dc build
  else
    step "Pulling images ($(env_get SEEDBOX_VERSION))"
    dc pull || die "Pulling failed. If these images are not published, run: ./setup.sh --build"
  fi
}

in_cookie_domain() { # in_cookie_domain HOST COOKIE_DOMAIN -> 0 if a cookie for COOKIE_DOMAIN is sent to HOST
  case "$1" in *".$2"|"$2") return 0 ;; *) return 1 ;; esac
}
sep_host() { # sep_host KEY : AUTH_HOST / FILES_HOST from .env if it is a separate host (empty or = APP_HOST -> nothing)
  local v app
  # AUTH_MODE=external has no portal: the gateway ignores AUTH_HOST then, and so does everything here
  if [ "$1" = AUTH_HOST ] && [ "$(norm_host "$(env_get AUTH_MODE)")" = external ]; then return 0; fi
  v=$(norm_host "$(env_get "$1")"); app=$(norm_host "$(env_get APP_HOST)")
  [ "$v" = "$app" ] || printf '%s' "$v"
}
hosts_in_use() { # the public hostnames this install answers on, one per line: APP_HOST, then any separate ones
  local h
  norm_host "$(env_get APP_HOST)"; printf '\n'
  for h in "$(sep_host AUTH_HOST)" "$(sep_host FILES_HOST)"; do [ -z "$h" ] || printf '%s\n' "$h"; done
}

print_summary() {
  local gen_pw=${1:-} proxy scheme app auth files n
  app=$(norm_host "$(env_get APP_HOST)"); auth=$(sep_host AUTH_HOST); files=$(sep_host FILES_HOST)
  scheme=$(env_get PUBLIC_SCHEME); scheme=${scheme:-https}
  case "$(env_get COMPOSE_FILE)" in *proxy-bundled*) proxy=bundled ;; *proxy-external*) proxy=external ;; *) proxy=none ;; esac
  step "Done"
  say "Open:       ${B}$scheme://$app${N}"
  if [ "$(env_get AUTH_MODE)" = authelia ]; then
    say "Login:      $scheme://${auth:-$app/auth}/  (you are redirected there automatically)"
  fi
  say "Downloads:  $scheme://${files:-$app}/dl/...  (signed links shown in the app)"
  [ -z "$gen_pw" ] || say "Admin password (shown once, change it later): ${B}$gen_pw${N}"
  say ""
  n=$(hosts_in_use | wc -l | tr -d ' ')
  if [ "$n" = 1 ]; then say "DNS record you need (pointing at this server's public IP):"
  else say "DNS records you need (all pointing at this server's public IP):"; fi
  local h
  while IFS= read -r h; do say "    $h    A/AAAA  <server-ip>"; done < <(hosts_in_use)
  case "$proxy" in
    bundled) say "Ports 80 and 443 must be reachable from the internet (Let's Encrypt validates over port 80)." ;;
    external) if [ "$n" = 1 ]; then say "Your reverse proxy must forward $app to the gateway (nginx-proxy does this automatically)."
              else say "Your reverse proxy must forward all $n hosts to the gateway (nginx-proxy does this automatically)."; fi ;;
    none) say "Gateway is published on $(env_get HTTP_BIND):$(env_get HTTP_PORT). Terminate TLS in front of it and send"
          say "X-Forwarded-Proto: https - Authelia's login cookie only works over https (see docs/deployment.md)." ;;
  esac
  say ""
  say "Next steps:"
  say "  1. Log in, open Admin -> Destinations and add where finished downloads go (Google Drive, S3/B2, local)."
  say "  2. Optional: Admin -> VPN: upload WireGuard configs, then set VPN mode to 'required'."
  say "  3. ./setup.sh doctor   checks DNS, TLS, containers and the VPN prerequisites."
  say "  4. ./setup.sh backup   (deploy/.env holds APP_SECRET: without it the database is unreadable);"
  say "     ./setup.sh add-user adds more logins;  ./setup.sh update  upgrades."
}

# --- update ----------------------------------------------------------------------------------------------------
running_version() { # what is actually running: the api image's version label (set on released images) and short image id
  local cid info label iid
  cid=$(dc ps -q api 2>/dev/null | head -n 1) || true
  [ -n "$cid" ] || return 0
  info=$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}|{{.Image}}' "$cid" 2>/dev/null) || return 0
  label=${info%%|*}; iid=${info#*|}; iid=${iid#sha256:}
  printf '%s(image %s)' "${label:+$label }" "${iid:0:12}"
}

cmd_update() {
  need_docker
  [ -f "$ENV_FILE" ] || die "No deploy/.env yet - run ./setup.sh first."
  local proxy
  case "$(env_get COMPOSE_FILE)" in *proxy-bundled*) proxy=bundled ;; *proxy-external*) proxy=external ;; *) proxy=none ;; esac
  check_auth_proxy "$(env_get AUTH_MODE)" "$proxy"
  fpr_check
  local cur target run
  cur=$(env_get SEEDBOX_VERSION); cur=${cur:-latest}
  run=$(running_version)
  if [ "$BUILD" = 1 ]; then
    step "Rebuilding images from this clone"
    say "Version: ${cur} -> local build of $(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || echo 'this clone')${run:+   (running now: $run)}"
    env_put SEEDBOX_VERSION local
    export SEEDBOX_BUILD_VERSION; SEEDBOX_BUILD_VERSION=$(build_version)
    dc build --pull
  else
    target=$VERSION_IN
    if [ -z "$target" ] && [ "$cur" = edge ]; then target=edge; fi   # edge follows main until you pick a release
    if [ -z "$target" ] || [ "$target" = latest ]; then target=$(latest_release); fi
    if [ -z "$target" ]; then
      if [ "$cur" = local ]; then
        die "These images were built from this clone. Pull the new source (git pull) and run: ./setup.sh update --build
(or pin a published release with: ./setup.sh update --version X.Y.Z)"
      fi
      warn "Could not determine the newest release (none published yet, offline, or rate-limited); staying on '$cur'. Pin one with --version X.Y.Z."
      target=$cur
    fi
    if [[ $cur =~ ^[0-9] ]] && [[ $target =~ ^[0-9] ]] && [ "$cur" != "$target" ] && ! ver_ge "$target" "$cur"; then
      [ "$ALLOW_DOWNGRADE" = 1 ] || die "$target is older than the installed $cur. Database migrations are not reversible: restore a backup made before the upgrade (./setup.sh restore FILE), then use --allow-downgrade."
    fi
    step "Update: ${cur} -> ${target}${run:+   (running now: $run)}"
    if [ "$target" != local ] && [ "$target" != "$cur" ] && ! image_exists "$target"; then
      die "Image $(registry)/docker-seedbox-vpn:$target does not exist (not published yet, a typo, or the package is private)."
    fi
    say "Tip: ./setup.sh backup first; to roll back later: ./setup.sh update --version $cur --allow-downgrade (after restoring that backup)."
    env_put SEEDBOX_VERSION "$target"
    step "Pulling images"
    dc pull
  fi
  step "Restarting changed services"
  dc up -d --remove-orphans --wait --wait-timeout 300
  fpr_record
  say "Updated to $(env_get SEEDBOX_VERSION). Running images:"
  dc ps --format '  {{.Service}}  {{.Image}}' 2>/dev/null || true
  say "The 'data' volume (database) is untouched; migrations run on api start."
}

# --- backup / restore ----------------------------------------------------------------------------------------------
BK_TMP=""; BK_STOPPED=""
bk_cleanup() {
  if [ -n "$BK_STOPPED" ]; then
    # shellcheck disable=SC2086  # word splitting of the service list is intended
    dc start $BK_STOPPED >/dev/null 2>&1 || warn "Could not restart: $BK_STOPPED (run: cd deploy && docker compose up -d)"
    BK_STOPPED=""
  fi
  if [ -n "$BK_TMP" ]; then rm -rf "$BK_TMP"; BK_TMP=""; fi
}

cmd_backup() {
  need_docker
  [ -f "$ENV_FILE" ] || die "No deploy/.env yet - nothing to back up."
  local ts out dvol avol running version
  ts=$(date +%Y%m%d-%H%M%S)
  out=${BACKUP_OUT:-$ROOT/seedbox-backup-$ts.tar.gz}
  if [ -d "$out" ]; then out=${out%/}/seedbox-backup-$ts.tar.gz; fi
  [ ! -e "$out" ] || die "$out already exists."
  dvol=$(vol_name data); avol=$(vol_name authelia)
  [ -n "$dvol" ] || die "No data volume found for compose project '$(project_name)' (never started?)."
  BK_TMP=$(mktemp -d)
  trap bk_cleanup EXIT

  # Stop the writers for a consistent copy of SQLite (a few seconds for a typical database), restart them after.
  running=$(dc ps --status running --services 2>/dev/null | grep -E '^(api|worker|authelia)$' | tr '\n' ' ' || true)
  if [ -n "$running" ]; then
    step "Stopping ${running% } for a consistent copy"
    # shellcheck disable=SC2086
    dc stop $running >/dev/null
    BK_STOPPED=$running
  fi
  step "Archiving"
  vol_run "$dvol" ro -v "$BK_TMP:/b" -- 'tar cf /b/data.tar -C /v .'
  if [ -n "$avol" ]; then vol_run "$avol" ro -v "$BK_TMP:/b" -- 'tar cf /b/authelia.tar -C /v .'; fi
  cp "$ENV_FILE" "$BK_TMP/env"
  if [ -d "$USERS_DIR" ]; then cp -a "$USERS_DIR" "$BK_TMP/authelia-users"; fi
  version=$(env_get SEEDBOX_VERSION)
  {
    printf 'docker-seedbox backup v1\n'
    printf 'created=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'project=%s\n' "$(project_name)"
    printf 'version=%s\n' "${version:-unknown}"
    printf 'app_secret_fingerprint=%s\n' "$(secret_fpr)"
    printf 'volumes=data%s\n' "${avol:+,authelia}"
  } >"$BK_TMP/MANIFEST"
  local members=(MANIFEST env data.tar)
  [ ! -f "$BK_TMP/authelia.tar" ] || members+=(authelia.tar)
  [ ! -d "$BK_TMP/authelia-users" ] || members+=(authelia-users)
  tar czf "$out" -C "$BK_TMP" "${members[@]}"
  chmod 600 "$out"
  bk_cleanup
  trap - EXIT
  say "Backup written: $out ($(du -h "$out" | awk '{print $1}'), mode 600)"
  say "It contains deploy/.env (APP_SECRET and every other secret) and the encrypted database: keep it private and"
  say "store it away from this server. Restore with: ./setup.sh restore $out"
}

cmd_restore() {
  need_docker
  [ -n "$RESTORE_FILE" ] || die "Usage: ./setup.sh restore FILE"
  [ -f "$RESTORE_FILE" ] || die "$RESTORE_FILE not found."
  local ts bk project listing
  ts=$(date +%Y%m%d-%H%M%S)
  BK_TMP=$(mktemp -d)
  trap bk_cleanup EXIT
  bk=$BK_TMP
  listing=$(tar tzf "$RESTORE_FILE" 2>/dev/null) || die "$RESTORE_FILE is not a readable .tar.gz archive."
  local need
  for need in MANIFEST env data.tar; do
    if ! printf '%s\n' "$listing" | grep -qx "$need"; then die "$RESTORE_FILE is not a docker-seedbox backup ($need missing)."; fi
  done
  # Only the known members are extracted (never paths taken from the archive).
  tar xzf "$RESTORE_FILE" -C "$bk" MANIFEST env data.tar
  head -n 1 "$bk/MANIFEST" | grep -qx 'docker-seedbox backup v1' || die "Unsupported backup format."
  if printf '%s\n' "$listing" | grep -qx 'authelia.tar'; then tar xzf "$RESTORE_FILE" -C "$bk" authelia.tar; fi
  if printf '%s\n' "$listing" | grep -q '^authelia-users/'; then tar xzf "$RESTORE_FILE" -C "$bk" authelia-users; fi
  say "Backup: $(sed -n 's/^created=//p' "$bk/MANIFEST"), version $(sed -n 's/^version=//p' "$bk/MANIFEST"), project $(sed -n 's/^project=//p' "$bk/MANIFEST")"
  if [ -f "$ENV_FILE" ]; then
    warn "This REPLACES deploy/.env, the Authelia users and the data volume of this installation (the current .env and users file are kept as *.pre-restore-$ts)."
  fi
  confirm "Restore now?" n || die "Aborted."

  # Stop the CURRENT stack first, with the CURRENT .env: the backup may belong to another compose project name,
  # which would leave this one running.
  if [ -f "$ENV_FILE" ]; then
    step "Stopping the current stack"
    dc down --remove-orphans >/dev/null 2>&1 || true
  fi
  step "Restoring configuration"
  if [ -f "$ENV_FILE" ]; then cp -p "$ENV_FILE" "$ENV_FILE.pre-restore-$ts"; fi
  cp "$bk/env" "$ENV_FILE"; chmod 600 "$ENV_FILE"
  if [ -d "$bk/authelia-users" ]; then
    mkdir -p "$USERS_DIR"
    if [ -f "$USERS_FILE" ]; then cp -p "$USERS_FILE" "$USERS_FILE.pre-restore-$ts"; fi
    cp -a "$bk/authelia-users/." "$USERS_DIR/"
    chmod 600 "$USERS_FILE" 2>/dev/null || true
  fi

  project=$(project_name)
  restore_volume() { # restore_volume NAME TARFILE
    local name=$1 file=$2 vol
    vol=$(vol_name "$name")
    if [ -z "$vol" ]; then
      vol="${project}_$name"
      docker volume create --label "com.docker.compose.project=$project" --label "com.docker.compose.volume=$name" "$vol" >/dev/null
    fi
    step "Restoring volume $vol"
    vol_run "$vol" rw -v "$bk:/b:ro" -- "find /v -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar xf /b/$file -C /v"
  }
  restore_volume data data.tar
  if [ -f "$bk/authelia.tar" ]; then restore_volume authelia authelia.tar; fi
  bk_cleanup
  trap - EXIT

  if [ "$NO_START" = 1 ]; then
    say "Restored. --no-start: nothing started. Next: ./setup.sh update   (or: cd deploy && docker compose up -d)"
    return 0
  fi
  fpr_check
  step "Starting the stack"
  if [ "$(env_get SEEDBOX_VERSION)" = local ]; then BUILD=1; fi
  ensure_images
  dc up -d --remove-orphans --wait --wait-timeout 300 || die "Some containers did not become healthy: ./setup.sh doctor"
  say "Restored and running."
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
  local engine comp
  engine=$(docker version -f '{{.Server.Version}}' 2>/dev/null || true); comp=$(docker compose version --short 2>/dev/null || true); comp=${comp#v}
  if [[ $engine =~ ^[0-9]+\.[0-9]+ ]]; then
    if ver_ge "$engine" 26.0; then ok "Docker Engine $engine supports volume subpaths (>= 26.0)"; else bad "Docker Engine $engine is too old: 26.0+ is required (volume subpaths)"; fi
  fi
  if [[ $comp =~ ^[0-9]+\.[0-9]+ ]] && ! ver_ge "$comp" 2.26; then bad "Docker Compose $comp is too old: 2.26+ is required (volume subpaths)"; fi
  if [ ! -f "$ENV_FILE" ]; then bad "deploy/.env missing - run ./setup.sh"; summary_doctor; return; fi
  ok "deploy/.env present"
  local perm
  perm=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null || echo "")
  if [ -n "$perm" ] && [ "$perm" != 600 ]; then meh "deploy/.env has mode $perm; run: chmod 600 deploy/.env"; fi
  if [ -f "$USERS_FILE" ]; then
    perm=$(stat -c '%a' "$USERS_FILE" 2>/dev/null || stat -f '%Lp' "$USERS_FILE" 2>/dev/null || echo "")
    if [ -n "$perm" ] && [ "$perm" != 600 ]; then meh "$USERS_FILE has mode $perm (it holds password hashes); run: chmod 600 $USERS_FILE"; fi
  fi

  say ""; say "Version"
  local ver run
  ver=$(env_get SEEDBOX_VERSION)
  run=$(running_version)
  ok "SEEDBOX_VERSION=${ver:-latest}${run:+, running api image: $run}"
  case "${ver:-latest}" in latest) meh "SEEDBOX_VERSION=latest is not pinned; ./setup.sh update pins the newest release" ;; esac

  say ""; say "Secrets and authentication"
  local proxy fp_stored
  case "$(env_get COMPOSE_FILE)" in *proxy-bundled*) proxy=bundled ;; *proxy-external*) proxy=external ;; *) proxy=none ;; esac
  if [ "$(env_get AUTH_MODE)" = external ] && [ "$proxy" = bundled ]; then
    bad "AUTH_MODE=external with the bundled proxy: the gateway is public with no authentication in front of it (anyone can claim to be admin)"
  elif [ "$(env_get AUTH_MODE)" = external ]; then
    meh "AUTH_MODE=external: make sure ONLY your SSO proxy can reach the gateway"
  else
    ok "AUTH_MODE=$(env_get AUTH_MODE)"
  fi
  fp_stored=$(fpr_stored)
  if [ -z "$fp_stored" ]; then
    meh "No APP_SECRET fingerprint recorded in the data volume yet (it is written on the next ./setup.sh / update)"
  elif [ "$fp_stored" = "$(secret_fpr)" ]; then
    ok "APP_SECRET matches the one the database was created with"
  else
    bad "APP_SECRET in deploy/.env is NOT the one the database was created with: stored credentials are unreadable. Restore the original .env (or ./setup.sh restore FILE)"
  fi

  say ""; say "Hosts"
  local h ips app_l sep_a sep_f
  local external=0 login
  [ "$(norm_host "$(env_get AUTH_MODE)")" != external ] || external=1
  app_l=$(norm_host "$(env_get APP_HOST)"); sep_a=$(sep_host AUTH_HOST); sep_f=$(sep_host FILES_HOST)
  login=${sep_a:-$app_l/auth/}; [ "$external" = 0 ] || login="your SSO proxy (AUTH_MODE=external)"
  if [ -z "$sep_a" ] && [ -z "$sep_f" ] && [ "$external" = 0 ]; then ok "single domain: $app_l (login $app_l/auth/, downloads $app_l/dl/)"
  else ok "app $app_l, login $login, downloads ${sep_f:-$app_l/dl/}"; fi
  if [ "$external" = 1 ] && [ -n "$(norm_host "$(env_get AUTH_HOST)")" ]; then
    meh "AUTH_HOST is set but ignored with AUTH_MODE=external (no login portal); leave it empty"
  fi
  for h in AUTH_HOST FILES_HOST; do
    if [ -n "$(norm_host "$(env_get "$h")")" ] && [ "$(norm_host "$(env_get "$h")")" = "$app_l" ]; then
      meh "$h repeats APP_HOST: leave it empty (same layout, but the name appears twice in VIRTUAL_HOST/LETSENCRYPT_HOST); ./setup.sh normalises it"
    fi
  done
  # the cookie domain Authelia actually uses (configuration.yml): APP_HOST with the portal on it, else COOKIE_DOMAIN
  local ck ck_set; ck_set=$(norm_host "$(env_get COOKIE_DOMAIN)"); ck=$app_l
  if [ "$external" = 0 ] && [ -n "$sep_a" ]; then
    ck=$ck_set
    if [ -z "$ck" ]; then bad "COOKIE_DOMAIN is empty but the login portal has its own host ($sep_a): Authelia will not start. Set it to a parent domain of both hosts (./setup.sh --cookie-domain)"
    elif ! in_cookie_domain "$app_l" "$ck" || ! in_cookie_domain "$sep_a" "$ck"; then bad "COOKIE_DOMAIN ($ck) must be a parent of both APP_HOST ($app_l) and AUTH_HOST ($sep_a)"
    else ok "login cookie domain: $ck"; fi
  elif [ "$external" = 0 ]; then
    if [ -n "$ck_set" ] && [ "$ck_set" != "$app_l" ]; then meh "COOKIE_DOMAIN=$ck_set is ignored: with the portal on $app_l the login cookie is scoped to $app_l (re-run ./setup.sh to tidy .env)"
    else ok "login cookie domain: $app_l"; fi
  fi
  if [ -n "$sep_f" ] && [ "$external" = 0 ] && [ -n "$ck" ] && in_cookie_domain "$sep_f" "$ck"; then
    meh "download host $sep_f is inside the login cookie's domain ($ck): it receives the session cookie and is same-site; a host outside it isolates downloads fully (SECURITY.md)"
  fi

  say ""; say "DNS"
  while IFS= read -r h; do
    ips=$(resolve_host "$h" || true)
    if [ -n "$ips" ]; then ok "$h -> $ips"; else bad "$h does not resolve (add an A/AAAA record)"; fi
  done < <(hosts_in_use)

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
    while IFS= read -r h; do
      code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$scheme://$h/healthz" 2>/dev/null || true)
      if [ "$code" = 200 ]; then ok "$scheme://$h/healthz -> 200"; else bad "$scheme://$h/healthz -> ${code:-no response} (DNS, firewall, certificate or proxy mapping?)"; fi
    done < <(hosts_in_use)
    if [ "$(env_get AUTH_MODE)" = authelia ] && [ -z "$(sep_host AUTH_HOST)" ]; then
      code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$scheme://$app_l/auth/api/health" 2>/dev/null || true)
      if [ "$code" = 200 ]; then ok "$scheme://$app_l/auth/api/health -> 200 (login portal)"; else bad "$scheme://$app_l/auth/api/health -> ${code:-no response} (is the authelia container up?)"; fi
    fi
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
  backup) cmd_backup ;;
  restore) cmd_restore ;;
  doctor) cmd_doctor ;;
esac
