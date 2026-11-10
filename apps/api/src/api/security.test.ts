import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { alice, GW, HEX, magnet, makeLocalDest, multipartBody, root, setup, torrentFile } from './testutil.js';

/** Send a request path verbatim (inject() would normalise some of these). */
async function rawGet(env: ReturnType<typeof setup>, path: string, headers: Record<string, string>, method = 'GET'): Promise<{ status: number; body: string }> {
  if (!env.app.server.listening) await env.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (env.app.server.address() as AddressInfo).port;
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, method, headers: { 'x-gateway-secret': GW, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

describe('admin gate cannot be bypassed by URL tricks', () => {
  const tricks = [
    '/api/%61dmin/users', '/api/admin%2Fusers', '/api/admin%2fusers', '/API/admin/users', '//api/admin/users',
    '/api/admin/users/', '/api/./admin/users', '/api/x/../admin/users', '/api/admin/%75sers', '/%61pi/admin/users', '/api/admin%5Cusers',
    '/api/admin/users%00', '/api/%2e/admin/users', '/Api/Admin/Users',
  ];
  it.each(tricks)('non-admin never reaches admin data via %s', async (p) => {
    const env = setup();
    const r = await rawGet(env, p, { 'remote-user': 'alice' });
    expect([400, 403, 404]).toContain(r.status);
    expect(r.body).not.toContain('"username"');
    await env.app.close();
  });

  it('percent-encoded admin path is still matched to the admin plugin (403, not 200)', async () => {
    const env = setup();
    expect((await rawGet(env, '/api/%61dmin/users', { 'remote-user': 'alice' })).status).toBe(403);
    expect((await env.call(alice, 'GET', '/api/%61dmin/users')).statusCode).toBe(403);
    expect((await env.call(alice, 'GET', '/api/admin/users')).statusCode).toBe(403);
    expect((await env.call(root, 'GET', '/api/%61dmin/users')).statusCode).toBe(200);
    await env.app.close();
  });

  it('encoded separators / dots / NUL and wrong-case /api are rejected with 400', async () => {
    const env = setup();
    for (const p of ['/api/admin%2Fusers', '/api/admin%5cusers', '/api/%2e%2e/me', '/api/me%00', '/API/me', '//api/me', '/api/./me']) {
      expect((await rawGet(env, p, { 'remote-user': 'alice' })).status, p).toBe(400);
    }
    await env.app.close();
  });

  it('unmatched routes 404 without provisioning a user', async () => {
    const env = setup();
    expect((await env.call({ name: 'ghost' }, 'GET', '/api/nope')).statusCode).toBe(404);
    expect((await env.call({ name: 'ghost' }, 'GET', '/%61pi/me/../zzz')).statusCode).toBe(404);
    expect((env.db.prepare('SELECT COUNT(*) n FROM users').get() as { n: number }).n).toBe(0);
  });

  it('every admin route (enumerated from the route table) is guarded and rejects non-admins', async () => {
    const env = setup();
    await env.app.ready();
    const table = env.app.routeTable.filter((r) => r.method !== 'HEAD' && !(Array.isArray(r.method) && r.method.every((m) => m === 'HEAD')));
    expect(table.length).toBeGreaterThan(25);
    const routes = table.flatMap((r) => (Array.isArray(r.method) ? r.method : [r.method]).filter((m) => m !== 'HEAD').map((m) => ({ method: m, url: r.url, guard: r.config?.guard })));

    const isPublic = (u: string) => u === '/api/health' || u.startsWith('/dl/');
    for (const r of routes) {
      // Nothing may exist outside a guarded plugin except the public routes...
      if (!isPublic(r.url)) expect(['user', 'admin'], `${r.method} ${r.url} is registered outside the guarded plugins`).toContain(r.guard);
      else expect(r.guard).toBe('public');
      // ...and anything that smells like admin must be in the admin plugin.
      if (/admin/i.test(r.url)) expect(r.guard, `${r.method} ${r.url}`).toBe('admin');
    }

    const admin = routes.filter((r) => r.guard === 'admin');
    expect(admin.length).toBeGreaterThan(15);
    for (const r of admin) {
      const url = r.url.replace(/:\w+/g, '1');
      const res = await env.call(alice, r.method as 'GET', url, r.method === 'GET' ? undefined : {});
      expect(res.statusCode, `${r.method} ${url} as non-admin`).toBe(403);
    }
    // Authenticated routes need a user; unauthenticated callers get 401 from every non-public route.
    for (const r of routes.filter((x) => !isPublic(x.url))) {
      const res = await env.call(null, r.method as 'GET', r.url.replace(/:\w+/g, '1'), r.method === 'GET' ? undefined : {});
      expect(res.statusCode, `${r.method} ${r.url} without user`).toBe(401);
    }
  });
});

describe('CSRF header', () => {
  it('rejects non-GET /api requests without X-Requested-With (403 csrf), including multipart', async () => {
    const env = setup();
    const dest = await makeLocalDest(env);
    const noHdr = { 'x-requested-with': '' };
    const r = await env.call(alice, 'POST', '/api/jobs', { magnet: magnet(HEX), destinationId: dest }, { headers: noHdr });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('csrf');
    const mp = multipartBody({ destinationId: String(dest) }, { name: 'a.torrent', data: torrentFile() });
    const m = await env.call(alice, 'POST', '/api/jobs', mp.payload, { headers: { ...mp.headers, ...noHdr } });
    expect(m.statusCode).toBe(403);
    expect((await env.call(alice, 'DELETE', '/api/jobs/1', undefined, { headers: noHdr })).statusCode).toBe(403);
    expect((await env.call(alice, 'POST', '/api/jobs', { magnet: magnet(HEX), destinationId: dest }, { headers: { 'x-requested-with': 'other' } })).statusCode).toBe(403);
    // with the header, it works; GET never needs it
    expect((await env.call(alice, 'POST', '/api/jobs', { magnet: magnet(HEX), destinationId: dest })).statusCode).toBe(201);
    expect((await env.call(alice, 'GET', '/api/jobs', undefined, { headers: noHdr })).statusCode).toBe(200);
    const mp2 = multipartBody({ destinationId: String(dest) }, { name: 'a.torrent', data: torrentFile() });
    expect((await env.call(alice, 'POST', '/api/jobs', mp2.payload, { headers: mp2.headers })).statusCode).toBeLessThan(300);
  });
});

describe('rate limits on expensive mutations', () => {
  const s3 = { endpoint: 'https://s3.example.test', region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 'SK', bucket: 'b' };
  it('limits destination create (20/min) and test (10/min) with Retry-After', async () => {
    const env = setup();
    for (let i = 0; i < 20; i++) expect((await env.call(alice, 'POST', '/api/destinations', { name: `d${i}`, type: 's3', config: s3 })).statusCode).toBe(201);
    const over = await env.call(alice, 'POST', '/api/destinations', { name: 'x', type: 's3', config: s3 });
    expect(over.statusCode).toBe(429);
    expect(Number(over.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // another user is unaffected
    expect((await env.call({ name: 'bob' }, 'POST', '/api/destinations', { name: 'x', type: 's3', config: s3 })).statusCode).toBe(201);
    const id = await makeLocalDest(env);
    const hits: number[] = [];
    for (let i = 0; i < 11; i++) hits.push((await env.call(root, 'POST', `/api/admin/destinations/${id}/test`)).statusCode);
    expect(hits.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(hits[10]).toBe(429);
  });

  it('limits job creation (30/min)', async () => {
    const env = setup();
    const dest = await makeLocalDest(env);
    env.db.prepare("INSERT INTO settings (key, value_json) VALUES ('limits.maxActiveJobsPerUser', '1000')").run();
    let last = 0;
    for (let i = 0; i < 31; i++) {
      const hash = i.toString(16).padStart(40, '0');
      last = (await env.call(alice, 'POST', '/api/jobs', { magnet: magnet(hash), destinationId: dest })).statusCode;
      if (i < 30) expect(last).toBe(201);
    }
    expect(last).toBe(429);
  });
});
