import { describe, expect, it } from 'vitest';
import { encryptConfig } from '../lib/destinations.js';
import { setSetting } from '../lib/settings.js';
import type { DestinationConfig } from '../lib/types.js';
import { alice, root, setup, type Env } from './testutil.js';

const H = 'a'.repeat(40);
const pending = (env: Env) => env.db.prepare('SELECT destination_id, remote_path, kind, full_path, user_owned FROM pending_deletions ORDER BY id').all();

function seedJob(env: Env, cfg: DestinationConfig, opts: { owner?: number | null; state?: string; remote?: string | null; destId?: number } = {}) {
  const u = env.db.prepare("INSERT OR IGNORE INTO users (id, username, created_at, last_seen_at) VALUES (1, 'alice', 1, 1)").run();
  void u;
  const uid = (env.db.prepare("SELECT id FROM users WHERE username = 'alice'").get() as { id: number }).id;
  const destId = opts.destId ?? Number(env.db.prepare('INSERT INTO destinations (owner_user_id, name, type, config_enc, enabled, is_default, created_at) VALUES (?, ?, ?, ?, 1, 0, 1)')
    .run(opts.owner === undefined ? null : opts.owner === 0 ? uid : opts.owner, 'D', cfg.type, encryptConfig(env.config.appSecret, cfg)).lastInsertRowid);
  env.db.prepare("INSERT OR IGNORE INTO torrents (id, infohash, source_enc, state, added_at) VALUES (1, ?, 'x', 'downloaded', 1)").run(H);
  const jobId = Number(env.db.prepare('INSERT INTO jobs (user_id, torrent_id, destination_id, state, remote_path, created_at, updated_at) VALUES (?, 1, ?, ?, ?, 1, 1)')
    .run(uid, destId, opts.state ?? 'completed', opts.remote === undefined ? 'alice-1/Movie [aaaaaaaa]' : opts.remote).lastInsertRowid);
  return { destId, jobId, uid };
}
const s3: DestinationConfig = { type: 's3', endpoint: 'https://s3.example.test', region: 'r', accessKeyId: 'AK', secretAccessKey: 'SK', bucket: 'b', prefix: 'pre' };

describe('deleting jobs queues file removal in the same transaction', () => {
  it('user deletes a completed local job: the library path (with subdir) is queued', async () => {
    const env = setup();
    const { jobId } = seedJob(env, { type: 'local', subdir: 'lib' });
    expect((await env.call(alice, 'DELETE', `/api/jobs/${jobId}`)).statusCode).toBe(204);
    expect(env.db.prepare('SELECT COUNT(*) n FROM jobs').get()).toEqual({ n: 0 });
    expect(pending(env)).toEqual([{ destination_id: expect.any(Number), remote_path: 'alice-1/Movie [aaaaaaaa]', kind: 'local', full_path: 'lib/alice-1/Movie [aaaaaaaa]', user_owned: 0 }]);
  });

  it('admin deletes someone else\'s completed local job', async () => {
    const env = setup();
    const { jobId } = seedJob(env, { type: 'local' });
    expect((await env.call(root, 'DELETE', `/api/admin/jobs/${jobId}`)).statusCode).toBe(204);
    expect(pending(env)).toHaveLength(1);
  });

  it('does not queue anything for active jobs (cancel) or jobs that never chose a remote path', async () => {
    const env = setup();
    const a = seedJob(env, { type: 'local' }, { state: 'failed', remote: null });
    const c = seedJob(env, { type: 'local' }, { state: 'completed', remote: null, destId: a.destId });
    const d = seedJob(env, { type: 'local' }, { state: 'uploading', destId: a.destId });
    for (const j of [a, c, d]) expect((await env.call(alice, 'DELETE', `/api/jobs/${j.jobId}`)).statusCode).toBe(204);
    expect(pending(env)).toEqual([]);
  });

  it('a failed/cancelled job that reached an upload also queues its path (the worker keeps it while a sibling references it), so a sibling cannot leak the files', async () => {
    const env = setup();
    const a = seedJob(env, { type: 'local', subdir: 'lib' }, { state: 'failed' });
    expect((await env.call(alice, 'DELETE', `/api/jobs/${a.jobId}`)).statusCode).toBe(204);
    expect(pending(env)).toHaveLength(1);
    // the queue row remembers the torrent so a delete + immediate re-add is noticed by the worker
    expect(env.db.prepare('SELECT torrent_id FROM pending_deletions').get()).toEqual({ torrent_id: 1 });
  });

  it('S3 and Drive data is kept by default; S3 is queued only with cleanup.deleteRemoteOnJobDelete', async () => {
    const env = setup();
    const a = seedJob(env, s3, { owner: 0 });
    const g = seedJob(env, { type: 'gdrive', clientId: 'c', clientSecret: 's', refreshToken: 'r', rootFolderId: 'f', sharing: 'none' }, { remote: 'Movie [aaaaaaaa]' });
    await env.call(alice, 'DELETE', `/api/jobs/${a.jobId}`);
    await env.call(root, 'DELETE', `/api/admin/jobs/${g.jobId}`);
    expect(pending(env)).toEqual([]);

    setSetting(env.db, 'cleanup.deleteRemoteOnJobDelete', true);
    const a2 = seedJob(env, s3, { owner: 0, remote: 'Movie [aaaaaaaa]' });
    const g2 = seedJob(env, { type: 'gdrive', clientId: 'c', clientSecret: 's', refreshToken: 'r', rootFolderId: 'f', sharing: 'none' }, { remote: 'Movie [bbbbbbbb]' });
    await env.call(alice, 'DELETE', `/api/jobs/${a2.jobId}`);
    await env.call(root, 'DELETE', `/api/admin/jobs/${g2.jobId}`);
    expect(pending(env)).toEqual([{ destination_id: a2.destId, remote_path: 'Movie [aaaaaaaa]', kind: 's3', full_path: 'pre/Movie [aaaaaaaa]', user_owned: 1 }]);
  });

  it('deleting a destination queues the files of its completed jobs, de-duplicated', async () => {
    const env = setup();
    const a = seedJob(env, { type: 'local', subdir: 'lib' });
    seedJob(env, { type: 'local', subdir: 'lib' }, { destId: a.destId, remote: 'alice-1/Other [bbbbbbbb]' });
    seedJob(env, { type: 'local', subdir: 'lib' }, { destId: a.destId, remote: 'alice-1/Movie [aaaaaaaa]' });
    seedJob(env, { type: 'local' }, { destId: a.destId, state: 'failed', remote: 'alice-1/Failed [cccccccc]' });
    expect((await env.call(root, 'DELETE', `/api/admin/destinations/${a.destId}`)).statusCode).toBe(204);
    expect(env.db.prepare('SELECT COUNT(*) n FROM destinations').get()).toEqual({ n: 0 });
    expect((pending(env) as { full_path: string }[]).map((r) => r.full_path).sort()).toEqual(['lib/alice-1/Failed [cccccccc]', 'lib/alice-1/Movie [aaaaaaaa]', 'lib/alice-1/Other [bbbbbbbb]']);
  });

  it('deleting an S3 destination never purges remote data, even with cleanup.deleteRemoteOnJobDelete on', async () => {
    const env = setup();
    setSetting(env.db, 'cleanup.deleteRemoteOnJobDelete', true);
    const a = seedJob(env, s3, { owner: 0, remote: 'Movie [aaaaaaaa]' });
    expect((await env.call(alice, 'DELETE', `/api/destinations/${a.destId}`)).statusCode).toBe(204);
    expect(pending(env)).toEqual([]);
  });

  it('GET /api/me exposes what deleting does to remote files', async () => {
    const env = setup();
    expect((await env.call(alice, 'GET', '/api/me')).json().cleanup).toEqual({ deleteRemoteOnJobDelete: false });
    await env.call(root, 'PUT', '/api/admin/settings', { 'cleanup.deleteRemoteOnJobDelete': true });
    expect((await env.call(alice, 'GET', '/api/me')).json().cleanup).toEqual({ deleteRemoteOnJobDelete: true });
  });
});
