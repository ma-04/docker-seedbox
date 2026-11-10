import { describe, expect, it } from 'vitest';
import { errorCategory } from './routes/destinations.js';
import { alice, root, setup } from './testutil.js';

const s3 = { endpoint: 'https://s3.example.test', region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 'SECRETVALUE', bucket: 'b' };
const mk = (env: ReturnType<typeof setup>, config: Record<string, unknown>) => env.call(alice, 'POST', '/api/destinations', { name: 'Mine', type: 's3', config });

describe('SSRF guard on user S3 destinations', () => {
  it.each([
    ['loopback literal', 'https://127.0.0.1:9000'], ['metadata', 'https://169.254.169.254'], ['private', 'https://10.0.0.5'],
    ['cgnat', 'https://100.64.1.1'], ['ula', 'https://[fd00::1]'], ['mapped', 'https://[::ffff:192.168.0.1]'],
    ['bare service name', 'https://minio'], ['http', 'http://s3.example.test'], ['credentials', 'https://u:p@s3.example.test'],
    ['javascript', 'javascript:alert(1)'],
  ])('create rejects %s endpoint', async (_n, endpoint) => {
    const env = setup();
    const r = await mk(env, { ...s3, endpoint });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation');
    expect(r.body).not.toContain('SECRETVALUE');
  });

  it('create rejects hostnames that resolve to any private address', async () => {
    const env = setup(undefined, undefined, { lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.9', family: 4 }] });
    const r = await mk(env, s3);
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain('10.0.0.9');
  });

  it('publicBaseUrl must be http(s) (no javascript: hrefs) and is guarded for users', async () => {
    const env = setup();
    for (const publicBaseUrl of ['javascript:alert(document.cookie)', 'data:text/html,x', 'https://127.0.0.1/x', 'http://cdn.example.test']) {
      expect((await mk(env, { ...s3, publicBaseUrl })).statusCode, publicBaseUrl).toBe(400);
    }
    expect((await mk(env, { ...s3, publicBaseUrl: 'https://cdn.example.test/base' })).statusCode).toBe(201);
    // admin (shared) destinations: still http(s) only
    const a = await env.call(root, 'POST', '/api/admin/destinations', { name: 'A', type: 'local', config: { publicBaseUrl: 'javascript:alert(1)' } });
    expect(a.statusCode).toBe(400);
    const g = await env.call(root, 'POST', '/api/admin/destinations', {
      name: 'G', type: 'gdrive', config: { clientId: 'c', clientSecret: 's', refreshToken: 'r', rootFolderId: 'F', proxyBaseUrl: 'javascript:alert(1)' },
    });
    expect(g.statusCode).toBe(400);
  });

  it('update re-checks the endpoint', async () => {
    const env = setup();
    const id = (await mk(env, s3)).json().id;
    const bad = await env.call(alice, 'PATCH', `/api/destinations/${id}`, { config: { endpoint: 'https://192.168.1.1' } });
    expect(bad.statusCode).toBe(400);
    expect((await env.call(alice, 'PATCH', `/api/destinations/${id}`, { config: { endpoint: 'https://s3.other.test' } })).statusCode).toBe(200);
  });

  it('test re-resolves right before connecting (DNS changed after creation) and is generic', async () => {
    let answer = '93.184.216.34';
    const env = setup(undefined, undefined, { lookup: async () => [{ address: answer, family: 4 }] });
    const id = (await mk(env, s3)).json().id;
    answer = '127.0.0.1';
    const r = await env.call(alice, 'POST', `/api/destinations/${id}/test`);
    expect(r.statusCode).toBe(200);
    expect(r.json().ok).toBe(false);
    expect(r.body).not.toContain('127.0.0.1');
  });

  it('presign/publicBaseUrl links are withheld if the host now resolves privately', async () => {
    let answer = '93.184.216.34';
    const env = setup(undefined, undefined, { lookup: async () => [{ address: answer, family: 4 }] });
    const id = (await mk(env, { ...s3, publicBaseUrl: 'https://cdn.example.test' })).json().id;
    const uid = (env.db.prepare("SELECT id FROM users WHERE username = 'alice'").get() as { id: number }).id;
    env.db.prepare("INSERT INTO torrents (id, infohash, source_enc, state, added_at) VALUES (1, ?, 'x', 'downloaded', 1)").run('b'.repeat(40));
    env.db.prepare("INSERT INTO jobs (id, user_id, torrent_id, destination_id, state, remote_path, created_at, updated_at) VALUES (1, ?, 1, ?, 'completed', 'T', 1, 1)").run(uid, id);
    env.db.prepare("INSERT INTO job_files (job_id, path, size) VALUES (1, 'a.bin', 1)").run();
    expect((await env.call(alice, 'GET', '/api/jobs/1/files')).json().files[0].url).toMatch(/^https:\/\/cdn\.example\.test\//);
    answer = '10.0.0.1';
    expect((await env.call(alice, 'GET', '/api/jobs/1/files')).json().files[0].url).toBeNull();
  });
});

describe('admin (shared) destinations may use private addresses', () => {
  it('accepts http + private endpoints, test works against them', async () => {
    const env = setup();
    const r = await env.call(root, 'POST', '/api/admin/destinations', { name: 'MinIO', type: 's3', config: { ...s3, endpoint: 'http://minio:9000' } });
    expect(r.statusCode).toBe(201);
    const t = await env.call(root, 'POST', `/api/admin/destinations/${r.json().id}/test`);
    expect(t.json().ok).toBe(false); // nothing listens, but it was attempted, not blocked by the guard
    expect(t.json().message).not.toMatch(/publicly routable/);
  });
  it('still refuses credentials in the URL', async () => {
    const env = setup();
    const r = await env.call(root, 'POST', '/api/admin/destinations', { name: 'x', type: 's3', config: { ...s3, endpoint: 'http://u:p@minio:9000' } });
    expect(r.statusCode).toBe(400);
  });
});

describe('destination test errors', () => {
  it('give non-admins only a short category, admins the detail', async () => {
    const env = setup();
    // A user-owned destination row pointing at a public-looking host that refuses connections.
    const u = await mk(env, { ...s3, endpoint: 'https://s3.example.test' });
    expect(u.statusCode).toBe(201);
    const cat = errorCategory(Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:9000'), { code: 'ECONNREFUSED' }));
    expect(cat).toBe('unreachable');
    expect(errorCategory(Object.assign(new Error('The specified bucket does not exist'), { name: 'NoSuchBucket' }))).toBe('bucket not found');
    expect(errorCategory(Object.assign(new Error('x'), { name: 'InvalidAccessKeyId' }))).toBe('auth failed');
    expect(errorCategory(Object.assign(new Error('x'), { $metadata: { httpStatusCode: 403 } }))).toBe('auth failed');
    expect(errorCategory(Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }))).toBe('tls error');
    expect(errorCategory(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))).toBe('timeout');
  });

  it('endpoint test as a user never echoes internal address or upstream text; admin sees detail', async () => {
    const env = setup();
    const { testDestination } = await import('./routes/destinations.js');
    const ctx = { config: env.config, db: env.db, lookup: undefined } as never;
    const cfg = { type: 's3' as const, ...s3, forcePathStyle: true };
    const blocked = await testDestination(ctx, 's3', { ...cfg, endpoint: 'https://127.0.0.1:1' }, { shared: false, detailed: false });
    expect(blocked.message).toBe('s3 test failed: Endpoint host is not publicly routable');
    // Shared endpoint nothing listens on: the connection is refused, only the category leaks to non-admins.
    const shared = { ...cfg, endpoint: 'http://127.0.0.1:1' };
    const nonAdmin = await testDestination(ctx, 's3', shared, { shared: true, detailed: false });
    expect(nonAdmin.message).toBe('s3 test failed: unreachable');
    const admin = await testDestination(ctx, 's3', shared, { shared: true, detailed: true });
    expect(admin.message.length).toBeGreaterThan('s3 test failed: unreachable'.length);
  }, 20_000);
});
