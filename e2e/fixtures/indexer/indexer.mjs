// Test-only torrent "site" that Jackett indexes through a custom Cardigann definition (sbmock.yml). It serves search results
// built from the seeder's /fixtures/manifest.json, the seeder's .torrent files, and a link that redirects to a magnet.
// It sits behind the WireGuard servers (203.0.113.40) and also on the fake internet (198.51.100.40): Jackett runs in the
// VPN sidecar's namespace, so the address it arrives from (GET /seen) tells the suite which path the query took.
//
//   GET /api/search?q=...   {"results":[...]}; every result whose title contains all query words (case-insensitive)
//   GET /dl/<key>.torrent   the seeder's .torrent file for <key> (multi | single | slow | slow2 | slow3)
//   GET /magnet/<key>       302 to the seeder's magnet for <key> (the "download link that turns out to be a magnet" case)
//   GET /external/<key>     302 to an http(s) URL outside Jackett (the API must refuse to fetch it)
//   GET /seen               ["<remote address>", ...] of every /api/search and /dl request, oldest first
//   GET /healthz            ok
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const FIXTURES = process.env.FIXTURES_DIR ?? '/fixtures';
const PORT = Number(process.env.PORT ?? 8080);
const seen = [];

async function manifest() {
  return JSON.parse(await readFile(`${FIXTURES}/manifest.json`, 'utf8'));
}

// cat: the definition's category ids (1 Movies, 2 TV, 3 XXX, 4 Audio/Audiobook). The XXX row reuses a real torrent, so a
// leak through the category filter would be addable, not just visible. Every download link is unique: Jackett drops results
// whose link (its guid) repeats another one.
function rows(m) {
  const now = Math.floor(Date.now() / 1000);
  return [
    { title: 'E2E Search Single File', cat: 1, key: 'single', download: '/dl/single.torrent', magnet: null, size: 2000000, seeders: 42, leechers: 3, date: now - 3600 },
    { title: 'E2E Search Multi Pack', cat: 2, key: 'multi', download: '/magnet/multi', magnet: null, size: 3850000, seeders: 7, leechers: 1, date: now - 86400 },
    { title: 'E2E Search Slow File', cat: 2, key: 'slow2', download: '/dl/slow2.torrent', magnet: m.slow2.magnet, size: 8000000, seeders: 120, leechers: 30, date: now - 600 },
    { title: 'E2E Search External Link', cat: 1, key: 'single', download: '/external/single', magnet: null, size: 1000, seeders: 1, leechers: 0, date: now - 60 },
    { title: 'E2E Search Audiobook Sample', cat: 4, key: 'single', download: '/dl/single.torrent?row=audiobook', magnet: null, size: 2000000, seeders: 5, leechers: 0, date: now - 7200 },
    { title: 'E2E Search Adult Sample', cat: 3, key: 'single', download: '/dl/single.torrent?row=adult', magnet: null, size: 2000000, seeders: 9, leechers: 0, date: now - 900 },
  ].map((r) => ({ ...r, details: `/details/${encodeURIComponent(r.title)}`, date: new Date(r.date * 1000).toISOString() }));
}

const send = (res, status, type, body, headers = {}) => { res.writeHead(status, { 'content-type': type, ...headers }); res.end(body); };

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://indexer');
  const p = url.pathname;
  try {
    if (p === '/healthz') return send(res, 200, 'text/plain', 'ok\n');
    if (p === '/seen') return send(res, 200, 'application/json', JSON.stringify(seen));
    if (p === '/api/search' || p.startsWith('/dl/') || p.startsWith('/magnet/') || p.startsWith('/external/')) seen.push(req.socket.remoteAddress ?? '');
    if (seen.length > 1000) seen.splice(0, seen.length - 1000);
    const m = await manifest();
    if (p === '/api/search') {
      const words = (url.searchParams.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const results = rows(m).filter((r) => words.every((w) => r.title.toLowerCase().includes(w)));
      return send(res, 200, 'application/json', JSON.stringify({ results }));
    }
    let k = /^\/dl\/([a-z0-9]+)\.torrent$/.exec(p);
    if (k && m[k[1]]) return send(res, 200, 'application/x-bittorrent', await readFile(`${FIXTURES}/${m[k[1]].torrent}`));
    k = /^\/magnet\/([a-z0-9]+)$/.exec(p);
    if (k && m[k[1]]) return send(res, 302, 'text/plain', '', { location: m[k[1]].magnet });
    k = /^\/external\/([a-z0-9]+)$/.exec(p);
    if (k && m[k[1]]) return send(res, 302, 'text/plain', '', { location: `https://torrents.example.net/${k[1]}.torrent` });
    return send(res, 404, 'text/plain', 'not found\n');
  } catch (e) {
    return send(res, 503, 'text/plain', `not ready: ${e.message}\n`);
  }
}).listen(PORT, () => console.log(`indexer: listening on ${PORT}`));
