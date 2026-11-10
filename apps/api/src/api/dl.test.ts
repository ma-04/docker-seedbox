import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { deriveKey } from '../lib/crypto.js';
import { sign, signedUrl } from '../lib/signing.js';
import { encryptConfig } from '../lib/destinations.js';
import { GW, setup, type Env } from './testutil.js';

describe('GET /dl', () => {
  const env = setup();
  const key = deriveKey(env.config.appSecret, 'local-links');
  const path = "/lib/bob/ünï #1 100%/it's a file.txt";
  // Links only work for files of a completed job owned by an enabled user (see 'revocation' below).
  const seed = (e: Env, state = 'completed') => {
    e.db.prepare("INSERT OR IGNORE INTO users (id, username, created_at, last_seen_at) VALUES (7, 'bob', 1, 1)").run();
    e.db.prepare("INSERT OR IGNORE INTO destinations (id, owner_user_id, name, type, config_enc, enabled, is_default, created_at) VALUES (1, NULL, 'L', 'local', ?, 1, 0, 1)")
      .run(encryptConfig(e.config.appSecret, { type: 'local', subdir: 'lib' }));
    e.db.prepare("INSERT OR IGNORE INTO torrents (id, infohash, source_enc, state, added_at) VALUES (1, ?, 'x', 'downloaded', 1)").run('a'.repeat(40));
    e.db.prepare('INSERT INTO jobs (id, user_id, torrent_id, destination_id, state, remote_path, created_at, updated_at) VALUES (9, 7, 1, 1, ?, ?, 1, 1)').run(state, 'bob/ünï #1 100%');
    e.db.prepare('INSERT INTO job_files (job_id, path, size) VALUES (9, ?, 1)').run("it's a file.txt");
    e.db.prepare('INSERT INTO job_files (job_id, path, size) VALUES (9, ?, 1)').run('ok.txt');
  };
  seed(env);
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
  it('sends download-only, sandboxing headers (they survive X-Accel-Redirect)', async () => {
    const r = await env.call(null, 'GET', url());
    expect(r.headers['content-disposition']).toMatch(/^attachment;/);
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
  });
  it('revocation: 404 once the job is deleted, not completed, or its owner is disabled', async () => {
    const e = setup();
    seed(e);
    const k = deriveKey(e.config.appSecret, 'local-links');
    const u = new URL(signedUrl('https://files.example.test', k, path, 3600, '/dl'));
    const get = () => e.call(null, 'GET', u.pathname + u.search).then((r) => r.statusCode);
    expect(await get()).toBe(200);
    e.db.prepare('UPDATE users SET disabled = 1 WHERE id = 7').run();
    expect(await get()).toBe(404);
    e.db.prepare('UPDATE users SET disabled = 0 WHERE id = 7').run();
    expect(await get()).toBe(200);
    e.db.prepare("UPDATE jobs SET state = 'failed' WHERE id = 9").run();
    expect(await get()).toBe(404);
    e.db.prepare("UPDATE jobs SET state = 'completed' WHERE id = 9").run();
    expect(await get()).toBe(200);
    e.db.prepare('DELETE FROM jobs WHERE id = 9').run();
    expect(await get()).toBe(404);
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
    expect(await raw('/dl/lib/bob/' + encodeURIComponent('ünï #1 100%') + '/ok.txt' + q('/lib/bob/ünï #1 100%/ok.txt'))).toBe(200);
    await env.app.close();
  });
});
