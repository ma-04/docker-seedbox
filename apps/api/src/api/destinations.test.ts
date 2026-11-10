import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MASK } from '../lib/types.js';
import { alice, B32, bob, HEX, magnet, makeLocalDest, root, setup } from './testutil.js';

const s3 = { endpoint: 'http://127.0.0.1:9', region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 'SECRETVALUE', bucket: 'b', prefix: 'p' };

describe('destinations', () => {
  it('masks secrets, treats MASK as unchanged, and hides shared config from users', async () => {
    const env = setup();
    const created = await env.call(alice, 'POST', '/api/destinations', { name: 'Mine', type: 's3', config: s3 });
    expect(created.statusCode).toBe(201);
    expect(created.json().config).toMatchObject({ secretAccessKey: MASK, accessKeyId: 'AK' });
    expect(created.body).not.toContain('SECRETVALUE');
    const id = created.json().id;

    const upd = await env.call(alice, 'PATCH', `/api/destinations/${id}`, { config: { secretAccessKey: MASK, bucket: 'b2' } });
    expect(upd.json().config).toMatchObject({ bucket: 'b2', secretAccessKey: MASK });
    // secret still stored unchanged
    const { decryptJson } = await import('../lib/crypto.js');
    const row = env.db.prepare('SELECT config_enc FROM destinations WHERE id = ?').get(id) as { config_enc: string };
    expect(decryptJson<{ secretAccessKey: string }>(env.config.appSecret, row.config_enc).secretAccessKey).toBe('SECRETVALUE');
    await env.call(alice, 'PATCH', `/api/destinations/${id}`, { config: { secretAccessKey: 'NEW' } });
    const row2 = env.db.prepare('SELECT config_enc FROM destinations WHERE id = ?').get(id) as { config_enc: string };
    expect(decryptJson<{ secretAccessKey: string }>(env.config.appSecret, row2.config_enc).secretAccessKey).toBe('NEW');

    const sharedId = await makeLocalDest(env);
    const list = (await env.call(alice, 'GET', '/api/destinations')).json();
    expect(list.find((d: { id: number }) => d.id === sharedId)).toMatchObject({ shared: true, config: {} });
    expect(list.find((d: { id: number }) => d.id === id)).toMatchObject({ shared: false });
    const adminList = (await env.call(root, 'GET', '/api/admin/destinations')).json();
    expect(adminList[0].config).toMatchObject({ subdir: 'lib' });
  });

  it('users can only create s3; validation errors use the envelope', async () => {
    const env = setup();
    expect((await env.call(alice, 'POST', '/api/destinations', { name: 'x', type: 'local', config: {} })).statusCode).toBe(403);
    const bad = await env.call(alice, 'POST', '/api/destinations', { name: 'x', type: 's3', config: { bucket: 'b' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('validation');
  });

  it('isolates users', async () => {
    const env = setup();
    const id = (await env.call(alice, 'POST', '/api/destinations', { name: 'Mine', type: 's3', config: s3 })).json().id;
    expect((await env.call(bob, 'GET', '/api/destinations')).json().some((d: { id: number }) => d.id === id)).toBe(false);
    expect((await env.call(bob, 'PATCH', `/api/destinations/${id}`, { name: 'hax' })).statusCode).toBe(404);
    expect((await env.call(bob, 'DELETE', `/api/destinations/${id}`)).statusCode).toBe(404);
    expect((await env.call(bob, 'POST', `/api/destinations/${id}/test`)).statusCode).toBe(404);
    const job = await env.call(bob, 'POST', '/api/jobs', { magnet: magnet(HEX), destinationId: id });
    expect(job.statusCode).toBe(404);
    // admin routes do not expose user-owned destinations
    expect((await env.call(root, 'PATCH', `/api/admin/destinations/${id}`, { name: 'x' })).statusCode).toBe(404);
    void B32;
  });

  it('keeps a single shared default and blocks deleting with active jobs', async () => {
    const env = setup();
    const a = (await env.call(root, 'POST', '/api/admin/destinations', { name: 'A', type: 'local', config: {}, isDefault: true })).json();
    const b = (await env.call(root, 'POST', '/api/admin/destinations', { name: 'B', type: 'local', config: {}, isDefault: true })).json();
    const list = (await env.call(root, 'GET', '/api/admin/destinations')).json();
    expect(list.filter((d: { isDefault: boolean }) => d.isDefault).map((d: { id: number }) => d.id)).toEqual([b.id]);
    await env.call(alice, 'POST', '/api/jobs', { magnet: magnet(HEX), destinationId: a.id });
    expect((await env.call(root, 'DELETE', `/api/admin/destinations/${a.id}`)).statusCode).toBe(409);
    expect((await env.call(root, 'DELETE', `/api/admin/destinations/${b.id}`)).statusCode).toBe(204);
  });

  it('parses rcloneConfig for drive and s3', async () => {
    const env = setup();
    const drive = await env.call(root, 'POST', '/api/admin/destinations', {
      name: 'D', type: 'gdrive', config: {},
      rcloneConfig: `[gd]\ntype = drive\nclient_id = cid\nclient_secret = csecret\nscope = drive\ntoken = {"access_token":"a","refresh_token":"rtok","expiry":"x"}\nroot_folder_id = root123\n`,
    });
    expect(drive.statusCode).toBe(201);
    expect(drive.json().config).toMatchObject({ clientId: 'cid', clientSecret: MASK, refreshToken: MASK, rootFolderId: 'root123', sharing: 'none' });
    expect(drive.body).not.toContain('rtok');
    const s = await env.call(root, 'POST', '/api/admin/destinations', {
      name: 'S', type: 's3', config: { bucket: 'bk' },
      rcloneConfig: '[s]\ntype = s3\nendpoint = https://s3.example.test\nregion = r1\naccess_key_id = AK\nsecret_access_key = SK\n',
    });
    expect(s.json().config).toMatchObject({ endpoint: 'https://s3.example.test', region: 'r1', accessKeyId: 'AK', bucket: 'bk' });
    const mismatch = await env.call(root, 'POST', '/api/admin/destinations', { name: 'M', type: 'local', config: {}, rcloneConfig: '[s]\ntype = s3\n' });
    expect(mismatch.statusCode).toBe(400);
  });

  it('tests local destinations and reports failures without throwing', async () => {
    const env = setup();
    const id = await makeLocalDest(env);
    const ok = (await env.call(root, 'POST', `/api/admin/destinations/${id}/test`)).json();
    expect(ok.ok).toBe(true);
    expect(existsSync(join(env.downloads, 'library', 'lib'))).toBe(true);
    const s3id = (await env.call(root, 'POST', '/api/admin/destinations', { name: 'S', type: 's3', config: { ...s3, endpoint: 'http://127.0.0.1:1' } })).json().id;
    const bad = await env.call(root, 'POST', `/api/admin/destinations/${s3id}/test`);
    expect(bad.statusCode).toBe(200);
    expect(bad.json().ok).toBe(false);
    expect(bad.body).not.toContain('SECRETVALUE');
  });

  it('tests gdrive via the Google client', async () => {
    const env = setup();
    const gid = (await env.call(root, 'POST', '/api/admin/destinations', {
      name: 'G', type: 'gdrive', config: { clientId: 'c', clientSecret: 's', refreshToken: 'r-unique-1', rootFolderId: 'F1' },
    })).json().id;
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: string) => String(u).includes('/token')
      ? new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }))
      : new Response(JSON.stringify({ id: 'F1', name: 'Shared Root' }))) as typeof fetch;
    try {
      const r = (await env.call(root, 'POST', `/api/admin/destinations/${gid}/test`)).json();
      expect(r).toMatchObject({ ok: true });
      expect(r.message).toContain('Shared Root');
    } finally { globalThis.fetch = real; }
  });
});
