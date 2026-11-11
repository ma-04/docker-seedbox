#!/bin/sh
# One-shot: writes the Authelia users database for the e2e stack. Passwords come from the environment
# (generated per run by e2e/run.sh into a git-ignored dir); only argon2 hashes land in the volume.
set -eu
hash() { authelia crypto hash generate argon2 --password "$1" | sed -n 's/^Digest: //p'; }
user() { # user <name> <password> <groups yaml>
  printf '  %s:\n    disabled: false\n    displayname: "%s"\n    email: "%s@seedbox.test"\n    password: "%s"\n    groups: %s\n' \
    "$1" "$1" "$1" "$(hash "$2")" "$3"
}
{
  echo "users:"
  user admin "$E2E_ADMIN_PASSWORD" "[admins, users]"
  user alice "$E2E_ALICE_PASSWORD" "[users]"
  user bob "$E2E_BOB_PASSWORD" "[users]"
  user carol "$E2E_CAROL_PASSWORD" "[users]"
} > /users/users_database.yml
chmod 644 /users/users_database.yml
echo "users-init: wrote $(grep -c '^  [a-z]' /users/users_database.yml) users"
