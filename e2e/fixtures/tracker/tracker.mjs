// Minimal BitTorrent HTTP tracker for the hermetic e2e stack: /announce (compact, IPv4) only.
// Peers are keyed by (infohash, ip:port) and forgotten after an hour or on event=stopped.
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 6969);
const INTERVAL = Number(process.env.ANNOUNCE_INTERVAL ?? 5);
const swarms = new Map(); // infohash (latin1 string) -> Map<"ip:port", { ip, port, left, seen }>

const bstr = (s) => Buffer.concat([Buffer.from(`${s.length}:`), Buffer.isBuffer(s) ? s : Buffer.from(s)]);
const bint = (n) => Buffer.from(`i${n}e`);
const blen = (b) => Buffer.concat([Buffer.from(`${b.length}:`), b]);

function parseQuery(raw) {
  const out = {};
  for (const kv of raw.split('&')) {
    if (!kv) continue;
    const i = kv.indexOf('=');
    const k = i < 0 ? kv : kv.slice(0, i);
    const v = i < 0 ? '' : kv.slice(i + 1);
    // Binary-safe percent decoding (info_hash is raw bytes): keep as a latin1 string.
    out[k] = v.replace(/\+/g, ' ').replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return out;
}

function fail(res, msg) {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(Buffer.concat([Buffer.from('d14:failure reason'), bstr(msg), Buffer.from('e')]));
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (url.pathname !== '/announce') { res.writeHead(404); return res.end(); }
  const q = parseQuery(url.search.slice(1));
  if (!q.info_hash || q.info_hash.length !== 20) return fail(res, 'invalid info_hash');
  const port = Number(q.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return fail(res, 'invalid port');
  const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return fail(res, 'ipv4 only');
  let swarm = swarms.get(q.info_hash);
  if (!swarm) swarms.set(q.info_hash, (swarm = new Map()));
  const key = `${ip}:${port}`;
  if (q.event === 'stopped') swarm.delete(key);
  else swarm.set(key, { ip, port, left: Number(q.left ?? 1), seen: Date.now() });
  const now = Date.now();
  for (const [k, p] of swarm) if (now - p.seen > 3_600_000) swarm.delete(k);
  const others = [...swarm.entries()].filter(([k]) => k !== key).map(([, p]) => p);
  const want = Math.min(Number(q.numwant ?? 50) || 50, 100);
  const peers = Buffer.alloc(Math.min(others.length, want) * 6);
  others.slice(0, want).forEach((p, i) => {
    p.ip.split('.').forEach((o, j) => peers.writeUInt8(Number(o), i * 6 + j));
    peers.writeUInt16BE(p.port, i * 6 + 4);
  });
  const complete = [...swarm.values()].filter((p) => p.left === 0).length;
  const body = Buffer.concat([
    Buffer.from('d8:completei'), Buffer.from(String(complete)), Buffer.from('e10:incompletei'), Buffer.from(String(swarm.size - complete)),
    Buffer.from(`e8:intervali${INTERVAL}e12:min intervali${INTERVAL}e5:peers`), blen(peers), Buffer.from('e'),
  ]);
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(body);
}).listen(PORT, '0.0.0.0', () => console.log(`tracker listening on :${PORT}`));
