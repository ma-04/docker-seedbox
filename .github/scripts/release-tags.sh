#!/usr/bin/env bash
# Which moving image tags a release version gets. Used by .github/workflows/release.yml (publish job) and testable
# without Docker:
#
#   git ls-remote --tags origin 'v*' | .github/scripts/release-tags.sh 1.2.3
#   .github/scripts/release-tags.sh --self-test
#
# stdin: the repository's tags, one per line, either bare (v1.2.3) or as `git ls-remote` prints them
# (<sha>\trefs/tags/v1.2.3, peeled ^{} lines included). The version being released is always counted, whether or not
# it is in the list. Prints the moving tags, one per line, `latest` last (so it moves after everything else).
#
# Rules, for a stable version X.Y.Z (a pre-release such as 1.3.0-rc.1 gets none of them, only its exact tag):
#   X.Y     only if X.Y.Z is the highest stable X.Y.* tag   (a re-run of an old release never moves it backwards)
#   X       only if X.Y.Z is the highest stable X.*.* tag, and X >= 1 (0.x minors are breaking; :0 would mislead)
#   latest  only if X.Y.Z is the highest stable tag overall (a patch on an older line must not steal :latest)
set -euo pipefail

STABLE_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
ANY_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'

highest() { sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1; }   # numeric per field: 1.10.0 > 1.9.0

moving_tags() { # moving_tags VERSION  (stable tags on stdin)
  local v=$1 major minor stable
  [[ $v =~ $ANY_RE ]] || { echo "release-tags: '$v' is not X.Y.Z[-prerelease]" >&2; return 2; }
  [[ $v =~ $STABLE_RE ]] || return 0                          # pre-release: exact tag only
  major=${v%%.*}; minor=${v%.*}
  stable=$({ cat; printf '%s\n' "$v"; } \
    | sed -E 's#^[0-9a-f]+[[:space:]]+##; s#^refs/tags/##; s#\^\{\}$##; s#^v##' \
    | grep -E "$STABLE_RE" | sort -u || true)
  [ "$(grep -E "^${minor//./\\.}\\." <<<"$stable" | highest)" = "$v" ] && echo "$minor"
  if [ "$major" != 0 ] && [ "$(grep -E "^${major}\\." <<<"$stable" | highest)" = "$v" ]; then echo "$major"; fi
  [ "$(highest <<<"$stable")" = "$v" ] && echo latest
  return 0
}

self_test() {
  local fails=0 got
  t() { # t "expected tags (space separated)" VERSION existing-tag...
    local want=$1 v=$2; shift 2
    got=$(printf '%s\n' "$@" | moving_tags "$v" | paste -sd' ' -)
    if [ "$got" = "$want" ]; then echo "  ok   $v with [$*] -> [$got]"
    else echo "  FAIL $v with [$*] -> [$got], want [$want]"; fails=$((fails + 1)); fi
  }
  t "0.1 latest"         0.1.0
  t "1.2 1 latest"       1.2.3   v1.2.2 v1.1.9
  t "1.2 1 latest"       1.2.3   v1.2.3
  t "1.2"                1.2.5   v1.3.0 v1.2.4
  t "1.2"                1.2.5   v1.3.0 v2.0.0
  t "1.3 1"              1.3.1   v1.3.0 v2.0.0
  t ""                   1.2.4   v1.2.5 v1.3.0
  t "1.10 1 latest"      1.10.0  v1.9.9
  t "0.3 latest"         0.3.1   v0.3.0 v0.2.7
  t "0.2"                0.2.8   v0.3.0
  t ""                   1.3.0-rc.1 v1.2.0
  t "1.2 1 latest"       1.2.0   v1.3.0-rc.1 v1.2.0-rc.2
  t "1.2 1 latest"       1.2.0   $'0123abc\trefs/tags/v1.2.0' $'4567def\trefs/tags/v1.2.0^{}' $'89ab\trefs/tags/v1.1.0'
  t ""                   1.2.0   $'89ab\trefs/tags/v1.2.1'
  t "2.0 2"              2.0.0   v10.0.0
  t "1.2 1 latest"       1.2.3   vfoo bar v1.2 v1.2.3.4
  if printf '' | moving_tags 1.2 >/dev/null 2>&1; then echo "  FAIL '1.2' must be rejected"; fails=$((fails + 1)); else echo "  ok   '1.2' rejected"; fi
  [ "$fails" = 0 ] || { echo "release-tags: $fails self-test case(s) failed" >&2; return 1; }
  echo "release-tags: all self-tests passed"
}

case "${1:-}" in
  --self-test) self_test ;;
  ""|-h|--help) sed -n '2,16p' "$0"; [ -n "${1:-}" ] ;;
  *) moving_tags "$1" ;;
esac
