import { describe, expect, it } from 'vitest';
import { decryptJson } from '../lib/crypto.js';
import { setSetting } from '../lib/settings.js';
import { alice, B32, bob, HEX, magnet, makeLocalDest, multipartBody, root, setup, torrentFile } from './testutil.js';

describe('jobs', () => {
  it('dedupes hex and base32 infohashes into one torrent; same user gets same job', async () => {
    const env = setup();
    const dest = await makeLocalDest(env);
    const a = await env.call(alice, 'POST', '/api/jobs', { magnet: magnet(HEX), destinationId: dest });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ state: 'queued', infohash: HEX, name: 'Sample', destination: { id: dest, type: 'local' } });
    const b = await env.call(bob, 'POST', '/api/jobs', { magnet: magnet(B32), destinationId: dest });
    expect(b.statusCode).toBe(201);
    expect(b.json().infohash).toBe(HEX);
    expect((env.db.prepare('SELECT COUNT(*) n FROM torrents').get() as { n: number }).n).toBe(1);
    const again = await env.call(alice, 'POST', '/api/jobs', { magnet: magnet(HEX.toUpperCase()), destinationId: dest });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(a.json().id);
    const row = env.db.prepare('SELECT source_enc FROM torrents').get() as { source_enc: string };
    expect(decryptJson<{ magnet: string }>(env.config.appSecret, row.source_enc).magnet).toContain(HEX);
  });

  it('rejects bad magnets, unknown destinations and disabled destinations', async () => {
    const env = setup();
    const dest = await makeLocalDest(env);
    expect((await env.call(alice, 'POST', '/api/jobs', { magnet: 'http://x', destinationId: dest })).statusCode).toBe(400);
    expect((await env.call(alice, 'POST', '/api/jobs', { magnet: 'magnet:?dn=x', destinationId: dest })).statusCode).toBe(400);
    expect((await env.call(alice, 'POST', '/api/jobs', { magnet: magnet(HEX), destinationId: 999 })).statusCode).toBe(404);
    await env.call(root, 'PATCH', `/api/admin/destinations/${dest}`, { enabled: false });
    expect((await env.call(alice, 'POST', '/api/jobs', { magnet: magnet(HEX), destinationId: dest })).statusCode).toBe(404);
  });

  it('creates jobs from multipart .torrent uploads and enforces size limits', async () => {
    const env = setup();
    const dest = await makeLocalDest(env);
    const m = multipartBody({ destinationId: String(dest) }, { name: 'a.torrent', data: torrentFile('movie.bin', 5000) });
    const r = await env.call(alice, 'POST', '/api/jobs', m.payload, { headers: m.headers });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ name: 'movie.bin', totalSize: 5000 });
    expect(r.json().infohash).toMatch(/^[0-9a-f]{40}$/);

    setSetting(env.db, 'limits.maxTorrentBytes', 1000);
    const m2 = multipartBody({ destinationId: String(dest) }, { name: 'b.torrent', data: torrentFile('other.bin', 5000) });
    expect((await env.call(alice, 'POST', '/api/jobs', m2.payload, { headers: m2.headers })).json().error.code).toBe('limit_exceeded');

    const big = multipartBody({ destinationId: String(dest) }, { name: 'c.torrent', data: Buffer.alloc(6 * 1024 * 1024, 1) });
    const rb = await env.call(alice, 'POST', '/api/jobs', big.payload, { headers: big.headers });
    expect(rb.statusCode).toBe(413);
    const junk = multipartBody({ destinationId: String(dest) }, { name: 'd.torrent', data: Buffer.from('not a torrent') });
    expect((await env.call(alice, 'POST', '/api/jobs', junk.payload, { headers: junk.headers })).statusCode).toBe(400);
  });

  it('enforces the per-user active job limit (setting and per-user override)', async () => {
    const env = setup();
    const dest = await makeLocalDest(env);
    setSetting(env.db, 'limits.maxActiveJobsPerUser', 1);
    const h = (n: number) => n.toString(16).padStart(40, '0');
    expect((await env.call(alice, 'POST', '/api/jobs', { magnet: magnet(h(1)), destinationId: dest })).statusCode).toBe(201);
    const over = await env.call(alice, 'POST', '/api/jobs', { magnet: magnet(h(2)), destinationId: dest });
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe('limit_exceeded');
    // existing duplicate still returns 200 at the limit
    expect((await env.call(alice, 'POST', '/api/jobs', { magnet: magnet(h(1)), destinationId: dest })).statusCode).toBe(200);
    expect((await env.call(bob, 'POST', '/api/jobs', { magnet: magnet(h(2)), destinationId: dest })).statusCode).toBe(201);
    const aliceId = (env.db.prepare("SELECT id FROM users WHERE username='alice'").get() as { id: number }).id;
    await env.call(root, 'PATCH', `/api/admin/users/${aliceId}`, { maxActiveJobs: 3 });
    expect((await env.call(alice, 'POST', '/api/jobs', { magnet: magnet(h(2)), destinationId: dest })).statusCode).toBe(201);
    expect((await env.call(alice, 'GET', '/api/me')).json().limits.maxActiveJobs).toBe(3);
    expect((await env.call(root, 'GET', '/api/admin/users')).json().find((u: { username: string }) => u.username === 'alice').activeJobs).toBe(2);
  });

  it('cancels, retries, and deletes terminal jobs; resets dead torrents', async () => {
    const env = setup();
    const dest = await makeLocalDest(env);
    const id = (await env.call(alice, 'POST', '/api/jobs', { magnet: magnet(HEX), destinationId: dest })).json().id;
    expect((await env.call(alice, 'POST', `/api/jobs/${id}/retry`)).statusCode).toBe(409);
    expect((await env.call(alice, 'DELETE', `/api/jobs/${id}`)).statusCode).toBe(204);
    expect((await env.call(alice, 'GET', `/api/jobs/${id}`)).json().state).toBe('cancelled');
    env.db.prepare("UPDATE torrents SET state = 'removed', error = 'gone'").run();
    const retried = await env.call(alice, 'POST', `/api/jobs/${id}/retry`);
    expect(retried.json()).toMatchObject({ state: 'queued', error: null });
    expect((env.db.prepare('SELECT state FROM torrents').get() as { state: string }).state).toBe('pending');
    env.db.prepare("UPDATE jobs SET state = 'failed', error = 'boom'").run();
    expect((await env.call(alice, 'POST', `/api/jobs/${id}/retry`)).json().error).toBeNull();
    // re-adding after a failure while torrent errored refreshes it and creates a new job
    env.db.prepare("UPDATE jobs SET state = 'failed'").run();
    env.db.prepare("UPDATE torrents SET state = 'error'").run();
    const again = await env.call(alice, 'POST', '/api/jobs', { magnet: magnet(HEX), destinationId: dest });
    expect(again.statusCode).toBe(201);
    expect((env.db.prepare('SELECT state FROM torrents').get() as { state: string }).state).toBe('pending');
    env.db.prepare("UPDATE jobs SET state = 'completed'").run();
    expect((await env.call(alice, 'DELETE', `/api/jobs/${id}`)).statusCode).toBe(204);
    expect((await env.call(alice, 'GET', `/api/jobs/${id}`)).statusCode).toBe(404);
  });

  it('isolates jobs between users and exposes all to admin', async () => {
    const env = setup();
    const dest = await makeLocalDest(env);
    const id = (await env.call(alice, 'POST', '/api/jobs', { magnet: magnet(HEX), destinationId: dest })).json().id;
    for (const [m, u] of [['GET', `/api/jobs/${id}`], ['DELETE', `/api/jobs/${id}`], ['POST', `/api/jobs/${id}/retry`], ['GET', `/api/jobs/${id}/files`]] as const) {
      expect((await env.call(bob, m, u)).statusCode).toBe(404);
    }
    expect((await env.call(bob, 'GET', '/api/jobs')).json()).toEqual([]);
    expect((await env.call(alice, 'GET', '/api/jobs?state=queued')).json()).toHaveLength(1);
    expect((await env.call(alice, 'GET', '/api/jobs?state=bogus')).statusCode).toBe(400);
    const adminJobs = (await env.call(root, 'GET', '/api/admin/jobs')).json();
    expect(adminJobs[0].user.username).toBe('alice');
    expect((await env.call(alice, 'GET', '/api/admin/jobs')).statusCode).toBe(403);
    expect((await env.call(root, 'DELETE', `/api/admin/jobs/${id}`)).statusCode).toBe(204);
  });

  it('builds verifiable signed links for completed local jobs', async () => {
    const env = setup();
    const dest = await makeLocalDest(env);
    const id = (await env.call(alice, 'POST', '/api/jobs', { magnet: magnet(HEX), destinationId: dest })).json().id;
    expect((await env.call(alice, 'GET', `/api/jobs/${id}/files`)).json()).toEqual({ folderUrl: null, files: [] });
    const tpath = "Sample #1/sub dir/it's 100%.txt";
    env.db.prepare("UPDATE jobs SET state='completed', remote_path = 'alice/Sample #1' WHERE id = ?").run(id);
    env.db.prepare('INSERT INTO job_files (job_id, path, size) VALUES (?, ?, 5)').run(id, 'sub dir/it\'s 100%.txt');
    const out = (await env.call(alice, 'GET', `/api/jobs/${id}/files`)).json();
    expect(out.files).toHaveLength(1);
    const u = new URL(out.files[0].url);
    expect(u.origin).toBe('https://files.example.test');
    expect(u.pathname.startsWith('/dl/lib/alice/Sample%20%231/sub%20dir/')).toBe(true);
    const { deriveKey } = await import('../lib/crypto.js');
    const { verify } = await import('../lib/signing.js');
    const decoded = decodeURIComponent(u.pathname.slice('/dl'.length));
    expect(decoded).toBe('/lib/alice/Sample #1/sub dir/it\'s 100%.txt');
    expect(verify(deriveKey(env.config.appSecret, 'local-links'), decoded, u.searchParams.get('exp')!, u.searchParams.get('sig')!)).toBe('ok');
    void tpath;
    // and the api accepts it
    const dl = await env.call(null, 'GET', u.pathname + u.search);
    expect(dl.statusCode).toBe(200);
  });

  it('builds s3 links (presigned and public base) and gdrive proxy links', async () => {
    const env = setup();
    const s3 = (await env.call(root, 'POST', '/api/admin/destinations', {
      name: 'S3', type: 's3', config: { endpoint: 'https://s3.example.test', region: 'r', accessKeyId: 'AK', secretAccessKey: 'SK', bucket: 'bk', prefix: 'pre' },
    })).json().id;
    const id = (await env.call(alice, 'POST', '/api/jobs', { magnet: magnet(HEX), destinationId: s3 })).json().id;
    env.db.prepare("UPDATE jobs SET state='completed', remote_path='alice/T' WHERE id = ?").run(id);
    env.db.prepare('INSERT INTO job_files (job_id, path, size) VALUES (?, ?, 5)').run(id, 'a b.txt');
    const url = (await env.call(alice, 'GET', `/api/jobs/${id}/files`)).json().files[0].url as string;
    expect(url).toContain('https://s3.example.test/bk/pre/alice/T/a%20b.txt');
    expect(url).toContain('X-Amz-Signature=');
    await env.call(root, 'PATCH', `/api/admin/destinations/${s3}`, { config: { publicBaseUrl: 'https://cdn.example.test/' } });
    expect((await env.call(alice, 'GET', `/api/jobs/${id}/files`)).json().files[0].url).toBe('https://cdn.example.test/pre/alice/T/a%20b.txt');

    const g = (await env.call(root, 'POST', '/api/admin/destinations', {
      name: 'G', type: 'gdrive', config: { clientId: 'c', clientSecret: 's', refreshToken: 'r', rootFolderId: 'F', proxyBaseUrl: 'https://drive.example.test', proxySigningKey: 'k' },
    })).json().id;
    const g2 = (await env.call(root, 'POST', '/api/admin/destinations', {
      name: 'G2', type: 'gdrive', config: { clientId: 'c', clientSecret: 's', refreshToken: 'r', rootFolderId: 'F' },
    })).json().id;
    for (const [d, h] of [[g, 2], [g2, 3]] as const) {
      const jid = (await env.call(alice, 'POST', '/api/jobs', { magnet: magnet(h.toString(16).padStart(40, '0')), destinationId: d })).json().id;
      env.db.prepare("UPDATE jobs SET state='completed', remote_path='alice/T', folder_url='https://drive.example.test/f' WHERE id = ?").run(jid);
      env.db.prepare('INSERT INTO job_files (job_id, path, size) VALUES (?, ?, 5)').run(jid, 'x.bin');
      const out = (await env.call(alice, 'GET', `/api/jobs/${jid}/files`)).json();
      expect(out.folderUrl).toBe('https://drive.example.test/f');
      if (d === g) expect(out.files[0].url).toMatch(/^https:\/\/drive\.example\.test\/alice\/T\/x\.bin\?exp=\d+&sig=[0-9a-f]{64}$/);
      else expect(out.files[0].url).toBeNull();
    }
  });
});
