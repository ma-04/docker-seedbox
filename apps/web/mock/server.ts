/** Dev-only mock API (MOCK=1 npx vite). Not imported by the app bundle. */
import type { IncomingMessage, ServerResponse } from 'node:http';

const t = Math.floor(Date.now() / 1000);
const job = (id: number, o: Record<string, unknown>) => ({
  id, state: 'queued', name: null, infohash: String(id).repeat(40).slice(0, 40), totalSize: 0, downloadProgress: 0, downloadSpeed: 0,
  uploadProgress: 0, uploadSpeed: 0, destination: { id: 1, name: 'Shared Drive', type: 'gdrive' }, error: null, folderUrl: null,
  createdAt: t - id * 300, updatedAt: t, completedAt: null, user: { id: 1, username: 'alice' }, ...o,
});

const engine: Record<string, unknown> = {
  downloadLimitKBps: 0, uploadLimitKBps: 0, maxConnections: 200, maxConnectionsPerTorrent: 100, maxUploads: -1, maxUploadsPerTorrent: -1,
  queueingEnabled: true, maxActiveDownloads: 3, maxActiveUploads: 3, maxActiveTorrents: 5,
  dht: true, pex: true, lsd: true, encryption: 'prefer', anonymousMode: false,
  listenPort: 51413, randomPort: false, addTrackersEnabled: false, addTrackers: '',
};

const db = {
  jobs: [
    job(1, { state: 'downloading', name: 'Big Buck Bunny', totalSize: 276134947, downloadProgress: 0.42, downloadSpeed: 3_400_000 }),
    job(2, { state: 'uploading', name: 'Sintel', totalSize: 129902440, downloadProgress: 1, uploadProgress: 0.7, uploadSpeed: 8_000_000, destination: { id: 2, name: 'My S3', type: 's3' } }),
    job(3, { state: 'completed', name: 'Tears of Steel', totalSize: 571_000_000, downloadProgress: 1, uploadProgress: 1, folderUrl: 'https://example.com/folder' }),
    job(4, { state: 'failed', name: null, error: 'Upload failed: access denied' }),
  ] as Record<string, unknown>[],
  destinations: [
    { id: 1, name: 'Shared Drive', type: 'gdrive', shared: true, enabled: true, isDefault: true, config: { clientId: 'x', clientSecret: '********', refreshToken: '********', rootFolderId: 'abc', sharing: 'anyone', proxyBaseUrl: 'https://drive.example.com', proxySigningKey: '********' }, createdAt: t },
    { id: 2, name: 'My S3', type: 's3', shared: false, enabled: true, isDefault: false, config: { endpoint: 'https://s3.example.com', region: 'us-east-1', bucket: 'b', accessKeyId: 'AK', secretAccessKey: '********', forcePathStyle: true }, createdAt: t },
    { id: 3, name: 'Local', type: 'local', shared: true, enabled: true, isDefault: false, config: {}, createdAt: t },
  ] as Record<string, unknown>[],
  vpn: [
    { id: 1, name: 'vpn-one', endpointHost: 'vpn1.example.com', enabled: true, lastUsedAt: t - 600, lastError: null, active: true, createdAt: t },
    { id: 2, name: 'vpn-two', endpointHost: 'vpn2.example.com', enabled: true, lastUsedAt: null, lastError: 'handshake timeout', active: false, createdAt: t },
  ] as Record<string, unknown>[],
  settings: { 'vpn.mode': 'required', 'vpn.rotation': 'interval', 'vpn.rotationMinutes': 360, 'vpn.activeConfigId': 1, 'limits.maxActiveJobsPerUser': 5, 'limits.maxTorrentBytes': 0, 'limits.minFreeDiskBytes': 2 * 1024 ** 3, 'seeding.ratio': 0, 'google.oauthClientId': '', 'google.oauthClientSecret': '' } as Record<string, unknown>,
  users: [
    { id: 1, username: 'alice', email: 'alice@example.com', displayName: 'Alice', isAdmin: true, disabled: false, maxActiveJobs: null, activeJobs: 2, createdAt: t, lastSeenAt: t - 30 },
    { id: 2, username: 'bob', email: null, displayName: null, isAdmin: false, disabled: false, maxActiveJobs: 2, activeJobs: 0, createdAt: t, lastSeenAt: t - 86400 * 3 },
  ] as Record<string, unknown>[],
};

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString();
  try { return JSON.parse(raw); } catch { return {}; }
}

export function mockMiddleware() {
  let nextId = 100;
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname.replace(/\/$/, '');
    const m = req.method ?? 'GET';
    const send = (body: unknown, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
    if (m !== 'GET' && m !== 'HEAD' && req.headers['x-requested-with'] !== 'seedbox') return send({ error: { code: 'csrf', message: 'Missing X-Requested-With header' } }, 403);
    const idOf = (re: RegExp) => Number(re.exec(p)?.[1]);
    if (p === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('event: ping\ndata: {}\n\n');
      return;
    }
    if (p === '/me') return send({ user: { id: 1, username: 'alice', email: 'alice@example.com', displayName: 'Alice' }, isAdmin: !url.searchParams.has('user'), limits: { maxActiveJobs: 5, maxTorrentBytes: 0 }, googleConnectAvailable: false, logoutUrl: '/logout' });
    if (p === '/destinations' && m === 'GET') return send(db.destinations);
    if (p === '/jobs' && m === 'GET') return send(db.jobs);
    if (p === '/jobs' && m === 'POST') {
      const j = job(nextId++, { name: null, createdAt: Math.floor(Date.now() / 1000), updatedAt: Math.floor(Date.now() / 1000) });
      db.jobs.unshift(j); await readBody(req); return send(j, 201);
    }
    if (/^\/jobs\/\d+\/files$/.test(p)) return send({ folderUrl: 'https://example.com/folder', files: [{ path: 'Tears of Steel/video.mkv', size: 560_000_000, url: 'https://example.com/dl/video.mkv' }, { path: 'Tears of Steel/notes.txt', size: 1200, url: null }] });
    if (/^\/jobs\/\d+\/retry$/.test(p)) return send({ ...(db.jobs.find((j) => j.id === idOf(/(\d+)/)) ?? job(1, {})), state: 'queued', error: null, updatedAt: Math.floor(Date.now() / 1000) });
    if (/^\/(admin\/)?jobs\/\d+$/.test(p) && m === 'DELETE') { db.jobs = db.jobs.filter((j) => j.id !== idOf(/(\d+)$/)); res.statusCode = 204; return res.end(); }
    if (/^\/(admin\/)?destinations\/\d+\/test$/.test(p)) return send({ ok: true, message: 'Wrote and read a test object' });
    if (/^\/(admin\/)?destinations(\/\d+)?$/.test(p)) {
      if (m === 'GET') return send(db.destinations);
      const body = (await readBody(req)) as Record<string, unknown>;
      if (m === 'POST') { const d = { id: nextId++, shared: p.includes('admin'), enabled: true, isDefault: false, createdAt: t, ...body }; db.destinations.push(d); return send(d, 201); }
      const id = idOf(/(\d+)$/);
      if (m === 'DELETE') { db.destinations = db.destinations.filter((d) => d.id !== id); res.statusCode = 204; return res.end(); }
      const d = db.destinations.find((x) => x.id === id); Object.assign(d ?? {}, body); return send(d);
    }
    if (p === '/admin/vpn/status') return send({ mode: 'required', connected: true, name: 'vpn-one', publicIp: '203.0.113.7', lastHandshakeSec: 42, since: t - 3600, reachable: true, activeConfigId: 1 });
    if (p === '/admin/vpn/rotate') return send({});
    if (p === '/admin/vpn/configs') {
      if (m === 'GET') return send(db.vpn);
      const b = (await readBody(req)) as { name: string }; const c = { id: nextId++, name: b.name, endpointHost: 'new.example.com', enabled: true, lastUsedAt: null, lastError: null, active: false, createdAt: t }; db.vpn.push(c); return send(c, 201);
    }
    if (/^\/admin\/vpn\/configs\/\d+$/.test(p)) {
      const id = idOf(/(\d+)$/);
      if (m === 'DELETE') { db.vpn = db.vpn.filter((c) => c.id !== id); res.statusCode = 204; return res.end(); }
      const c = db.vpn.find((x) => x.id === id); Object.assign(c ?? {}, await readBody(req)); return send(c);
    }
    if (p === '/admin/settings') { if (m === 'PUT') Object.assign(db.settings, await readBody(req)); return send(db.settings); }
    if (p === '/admin/engine/settings') {
      if (url.searchParams.has('down')) return send({ error: { code: 'engine_unavailable', message: 'Torrent engine is not reachable' } }, 502);
      if (m === 'PUT') {
        const b = (await readBody(req)) as Record<string, unknown>;
        const bad = Object.keys(b).find((k) => !(k in engine));
        if (bad) return send({ error: { code: 'validation', message: `Unrecognized key: ${bad}` } }, 400);
        Object.assign(engine, b);
      }
      return send(engine);
    }
    if (p === '/admin/users') return send(db.users);
    if (/^\/admin\/users\/\d+$/.test(p)) { const u = db.users.find((x) => x.id === idOf(/(\d+)$/)); Object.assign(u ?? {}, await readBody(req)); return send(u); }
    if (p === '/admin/jobs') return send(db.jobs);
    send({ error: { code: 'not_found', message: `No mock for ${m} ${p}` } }, 404);
  };
}
