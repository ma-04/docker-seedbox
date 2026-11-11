import { execFile } from 'node:child_process';
import http from 'node:http';

const PROJECT = process.env.COMPOSE_PROJECT_NAME ?? 'sbe2e';
const TOKEN = process.env.E2E_CTL_TOKEN ?? '';
const RESTARTABLE = new Set(['api', 'worker', 'vpn', 'qbittorrent', 'gateway', 'web', 'authelia']);

const sh = (args, opts = {}) => new Promise((resolve) => {
  execFile('docker', args, { timeout: 90_000, maxBuffer: 4 << 20, ...opts }, (err, stdout, stderr) => resolve({ ok: !err, stdout, stderr, code: err?.code ?? 0 }));
});
const container = async (service, all = false) => {
  const r = await sh(['ps', all ? '-aq' : '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`, '--filter', `label=com.docker.compose.service=${service}`]);
  const id = r.stdout.trim().split('\n')[0];
  if (!id) throw new Error(`no container for service ${service}`);
  return id;
};
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); });

http.createServer(async (req, res) => {
  const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') return send(200, { ok: true });
    if (!TOKEN || req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });

    // POST /restart {"services": ["worker","api"]} : `docker restart`, in order, waiting for each.
    if (req.method === 'POST' && url.pathname === '/restart') {
      const { services } = JSON.parse((await readBody(req)) || '{}');
      if (!Array.isArray(services) || !services.length || !services.every((s) => RESTARTABLE.has(s))) return send(400, { error: 'bad services' });
      for (const s of services) {
        const r = await sh(['restart', '-t', '3', await container(s)]);
        if (!r.ok) return send(500, { error: r.stderr });
      }
      return send(200, { ok: true });
    }
    // POST /stop | /start {"services": ["worker"]} : pause the worker so a test can observe the sidecar before it reconciles.
    if (req.method === 'POST' && (url.pathname === '/stop' || url.pathname === '/start')) {
      const { services } = JSON.parse((await readBody(req)) || '{}');
      if (!Array.isArray(services) || !services.length || !services.every((s) => s === 'worker')) return send(400, { error: 'bad services' });
      for (const s of services) {
        const r = await sh([url.pathname.slice(1), await container(s, true)]);
        if (!r.ok) return send(500, { error: r.stderr });
      }
      return send(200, { ok: true });
    }
    // GET /webui : qBittorrent's WebUI API as seen by an ordinary container on the compose network (this one is
    // neither api nor worker, so it is not in QBT_TRUSTED_IPS). Fixed paths only.
    if (req.method === 'GET' && url.pathname === '/webui') {
      const path = url.searchParams.get('path') ?? '';
      if (!['/api/v2/app/version', '/api/v2/torrents/info', '/api/v2/app/preferences'].includes(path)) return send(400, { error: 'bad path' });
      const r = await new Promise((resolve) => {
        const q = http.get({ host: 'vpn', port: 8080, path, timeout: 8000 }, (res) => {
          let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ reachable: true, status: res.statusCode, body: b.slice(0, 200) }));
        });
        q.on('timeout', () => q.destroy(new Error('timeout')));
        q.on('error', (e) => resolve({ reachable: false, status: 0, body: '', error: String(e.message) }));
      });
      return send(200, r);
    }
    // GET /probe?url=http://host/ : curl from inside the qbittorrent container (uid 1000, the vpn namespace).
    if (req.method === 'GET' && url.pathname === '/probe') {
      const target = url.searchParams.get('url') ?? '';
      if (!/^http:\/\/[0-9a-z.\-]+(:\d+)?\/[\w./?=&%-]*$/i.test(target)) return send(400, { error: 'bad url' });
      const r = await sh(['exec', '-u', '1000', await container('qbittorrent'), 'curl', '-sS', '-m', '5', '-o', '-', '-w', '\n%{http_code}', target]);
      const out = r.stdout;
      const i = out.lastIndexOf('\n');
      return send(200, { reachable: r.ok, status: r.ok ? Number(out.slice(i + 1)) : 0, body: r.ok ? out.slice(0, i) : '', error: r.ok ? '' : r.stderr.trim().slice(0, 200) });
    }
    // GET /resolv : the namespace's resolv.conf as seen by qbittorrent.
    if (req.method === 'GET' && url.pathname === '/resolv') {
      const r = await sh(['exec', await container('qbittorrent'), 'cat', '/etc/resolv.conf']);
      return send(200, { text: r.stdout });
    }
    // GET /library : directory listing of the local library as seen by the gateway container (uid 101).
    if (req.method === 'GET' && url.pathname === '/library') {
      const r = await sh(['exec', await container('gateway'), 'sh', '-c', 'find /downloads/library -type f | head -100']);
      return send(200, { files: r.stdout.split('\n').filter(Boolean) });
    }
    return send(404, { error: 'not found' });
  } catch (e) {
    return send(500, { error: String(e?.message ?? e) });
  }
}).listen(9000, '0.0.0.0', () => console.log('ctl listening on :9000'));
