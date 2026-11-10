import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { deriveKey } from '../lib/crypto.js';
import { sign, signedUrl } from '../lib/signing.js';
import { GW, setup } from './testutil.js';

describe('GET /dl', () => {
  const env = setup();
  const key = deriveKey(env.config.appSecret, 'local-links');
  const path = "/lib/bob/ünï #1 100%/it's a file.txt";
  const url = (p = path, ttl = 3600, now?: number) => {
    const u = new URL(signedUrl('https://files.example.test', key, p, ttl, '/dl', now));
    return u.pathname + u.search;
  };

  it('serves via X-Accel-Redirect with no login', async () => {
    const r = await env.call(null, 'GET', url());
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('');
    expect(r.headers['x-accel-redirect']).toBe('/_protected/lib/bob/' + encodeURIComponent('ünï #1 100%') + '/' + encodeURIComponent("it's a file.txt"));
    expect(r.headers['content-disposition']).toBe("attachment; filename*=UTF-8''it%27s%20a%20file.txt");
  });
  it('supports never-expiring links', async () => {
    expect((await env.call(null, 'GET', url(path, 0))).statusCode).toBe(200);
  });
  it('requires the gateway secret', async () => {
    const r = await env.app.inject({ method: 'GET', url: url() });
    expect(r.statusCode).toBe(401);
  });
  it('410 when expired', async () => {
    expect((await env.call(null, 'GET', url(path, 10, 1000))).statusCode).toBe(410);
  });
  it('403 on tampered signature, path or exp', async () => {
    const good = url();
    expect((await env.call(null, 'GET', good.replace(/sig=./, 'sig=0'))).statusCode).toBe(403);
    expect((await env.call(null, 'GET', good.replace('file', 'fil3'))).statusCode).toBe(403);
    expect((await env.call(null, 'GET', good.replace(/exp=\d+/, 'exp=0'))).statusCode).toBe(403);
    expect((await env.call(null, 'GET', '/dl/lib/x')).statusCode).toBe(403);
  });
  it('404 on traversal and malformed paths, even with a valid signature', async () => {
    // inject() normalises dot segments client-side, so use a real socket to send them verbatim.
    await env.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (env.app.server.address() as AddressInfo).port;
    const raw = (p: string) => new Promise<number>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: { 'x-gateway-secret': GW } }, (res) => { res.resume(); resolve(res.statusCode!); });
      r.on('error', reject); r.end();
    });
    const q = (p: string) => `?exp=0&sig=${sign(key, p, 0)}`;
    expect(await raw('/dl/a/../x' + q('/a/../x'))).toBe(404);
    expect(await raw('/dl/a/%2e%2e/x' + q('/a/../x'))).toBe(404);
    expect(await raw('/dl/a/%2E%2E/x' + q('/a/../x'))).toBe(404);
    expect(await raw('/dl/%2e%2e/x' + q('/../x'))).toBe(404);
    expect(await raw('/dl/a%2Fb' + q('/a/b'))).toBe(404);
    expect(await raw('/dl/a//b' + q('/a//b'))).toBe(404);
    expect([400, 404]).toContain(await raw('/dl/%E0%A4%A?exp=0&sig=x'));
    expect(await raw('/dl/lib/ok.txt' + q('/lib/ok.txt'))).toBe(200);
    await env.app.close();
  });
});
