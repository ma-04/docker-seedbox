#!/bin/sh
# Test seeder: generates random multi-file / single-file / slow torrents, announces to the tracker by IP,
# seeds them with transmission and publishes torrents, magnets and sha256 sums as /fixtures/manifest.json
# (the volume is served by the TLS front as https://fixtures.seedbox.test/).
# env: TRACKER_URL (http://<ip>:6969/announce), SLOW_KBPS
set -eu
OUT=/fixtures
DATA=/seed/data
CFG=/seed/config
mkdir -p "$DATA" "$CFG" "$OUT/torrents"
rm -f "$OUT/manifest.json"

rnd() { head -c "$2" /dev/urandom > "$1"; }

# --- 1. multi-file torrent: root folder, a subfolder, awkward file names --------------------------
M="$DATA/E2E Multi Pack"
mkdir -p "$M/sub dir/deeper"
rnd "$M/plain.bin" 1200000
rnd "$M/with space.bin" 600000
rnd "$M/ünï cødé.bin" 400000
rnd "$M/hash #1.bin" 300000
rnd "$M/100% real.bin" 300000
printf "it's a trap?\nline two\n" > "$M/it's a file.txt"
rnd "$M/sub dir/nested file.bin" 500000
rnd "$M/sub dir/deeper/日本語.bin" 250000

# --- 2. single-file torrent -------------------------------------------------------------------------
rnd "$DATA/Single File.bin" 2000000

# --- 3. slow torrent (upload-limited below) so tests can act mid-download ---------------------------
rnd "$DATA/Slow File.bin" 8000000
# Two more, each used by exactly one restart test: a torrent whose data was just delivered is reused, not re-downloaded.
rnd "$DATA/Slow File 2.bin" 8000000
rnd "$DATA/Slow File 3.bin" 8000000

mk() { # mk <file-or-dir name inside $DATA> <torrent file base>
  transmission-create -o "$OUT/torrents/$2.torrent" -t "$TRACKER_URL" -c "" "$DATA/$1" >/dev/null
  chmod 644 "$OUT/torrents/$2.torrent"
}
mk "E2E Multi Pack" multi
mk "Single File.bin" single
mk "Slow File.bin" slow
mk "Slow File 2.bin" slow2
mk "Slow File 3.bin" slow3

hash_of() { transmission-show "$OUT/torrents/$1.torrent" | sed -n 's/^ *Hash\( v1\)\{0,1\}: *//p' | head -1; }
H_MULTI=$(hash_of multi); H_SINGLE=$(hash_of single); H_SLOW=$(hash_of slow); H_SLOW2=$(hash_of slow2); H_SLOW3=$(hash_of slow3)

cat > "$CFG/settings.json" <<JSON
{
  "download-dir": "$DATA",
  "incomplete-dir-enabled": false,
  "rpc-bind-address": "127.0.0.1",
  "rpc-authentication-required": false,
  "rpc-whitelist-enabled": false,
  "rpc-host-whitelist-enabled": false,
  "peer-port": 51413,
  "peer-port-random-on-start": false,
  "port-forwarding-enabled": false,
  "dht-enabled": false,
  "pex-enabled": false,
  "lpd-enabled": false,
  "utp-enabled": false,
  "encryption": 0,
  "peer-limit-global": 200,
  "peer-limit-per-torrent": 50,
  "upload-slots-per-torrent": 10,
  "speed-limit-up-enabled": false,
  "ratio-limit-enabled": false,
  "idle-seeding-limit-enabled": false,
  "umask": "022"
}
JSON
transmission-daemon -f --config-dir "$CFG" --log-level=error &
for i in $(seq 1 60); do transmission-remote -l >/dev/null 2>&1 && break; sleep 0.5; done
for t in multi single slow slow2 slow3; do
  transmission-remote -a "$OUT/torrents/$t.torrent" -w "$DATA" >/dev/null
done
# Slow torrent: cap its upload so a 6 MB download takes ~20 s.
for SLOW_ID in $(transmission-remote -l | awk '/Slow File/ {gsub(/\*/,"",$1); print $1}'); do
  transmission-remote -t "$SLOW_ID" -u "${SLOW_KBPS:-300}" >/dev/null
done
# wait until all five are verified and seeding
for i in $(seq 1 120); do
  n=$(transmission-remote -l | grep -c -E 'Seeding|Idle' || true)
  [ "$n" -ge 5 ] && break
  sleep 0.5
done
[ "$n" -ge 5 ] || { echo "seeder: torrents did not reach Seeding"; transmission-remote -l; exit 1; }

magnet() { # magnet <hash> <display name>
  dn=$(printf '%s' "$2" | jq -sRr @uri)
  tr=$(printf '%s' "$TRACKER_URL" | jq -sRr @uri)
  printf 'magnet:?xt=urn:btih:%s&dn=%s&tr=%s' "$1" "$dn" "$tr"
}
files_json() { # files_json <dir> : [{path,size,sha256}] relative to dir (sorted); names contain no tab/newline
  (cd "$1" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r f; do
    printf '%s\t%s\t%s\n' "$f" "$(stat -c %s "$f")" "$(sha256sum "$f" | cut -d' ' -f1)"
  done) | jq -R 'split("\t") | {path: .[0], size: (.[1]|tonumber), sha256: .[2]}' | jq -s .
}
one_file_json() { # one_file_json <file>
  jq -n --arg p "$(basename "$1")" --argjson s "$(stat -c %s "$1")" --arg h "$(sha256sum "$1" | cut -d' ' -f1)" '[{path:$p, size:$s, sha256:$h}]'
}

jq -n \
  --arg tracker "$TRACKER_URL" \
  --arg hm "$H_MULTI" --arg hs "$H_SINGLE" --arg hl "$H_SLOW" --arg hl2 "$H_SLOW2" --arg hl3 "$H_SLOW3" \
  --arg mm "$(magnet "$H_MULTI" 'E2E Multi Pack')" --arg ms "$(magnet "$H_SINGLE" 'Single File.bin')" --arg ml "$(magnet "$H_SLOW" 'Slow File.bin')" \
  --arg ml2 "$(magnet "$H_SLOW2" 'Slow File 2.bin')" --arg ml3 "$(magnet "$H_SLOW3" 'Slow File 3.bin')" \
  --argjson fm "$(files_json "$M")" \
  --argjson fs "$(one_file_json "$DATA/Single File.bin")" \
  --argjson fl "$(one_file_json "$DATA/Slow File.bin")" \
  --argjson fl2 "$(one_file_json "$DATA/Slow File 2.bin")" --argjson fl3 "$(one_file_json "$DATA/Slow File 3.bin")" \
  '{tracker: $tracker,
    multi:  {name: "E2E Multi Pack", infohash: $hm, torrent: "torrents/multi.torrent",  magnet: $mm, files: $fm},
    single: {name: "Single File.bin", infohash: $hs, torrent: "torrents/single.torrent", magnet: $ms, files: $fs},
    slow:   {name: "Slow File.bin",   infohash: $hl, torrent: "torrents/slow.torrent",   magnet: $ml, files: $fl},
    slow2:  {name: "Slow File 2.bin", infohash: $hl2, torrent: "torrents/slow2.torrent", magnet: $ml2, files: $fl2},
    slow3:  {name: "Slow File 3.bin", infohash: $hl3, torrent: "torrents/slow3.torrent", magnet: $ml3, files: $fl3}}' > "$OUT/manifest.json.tmp"
chmod 644 "$OUT/manifest.json.tmp"
mv "$OUT/manifest.json.tmp" "$OUT/manifest.json"
echo "seeder: ready ($(jq -c '[.multi.infohash,.single.infohash,.slow.infohash]' "$OUT/manifest.json"))"
wait
