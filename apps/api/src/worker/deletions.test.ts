import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { enqueueDeletion } from '../lib/deletions.js';
import { setSetting } from '../lib/settings.js';
import { now, type JobRow } from '../lib/types.js';
import { processDeletions } from './deletions.js';
import { buildS3PurgeCommand } from './rclone.js';
import { Worker } from './loop.js';
import { addDest, addJob, addTorrent, addUser, FakeDownloader, FakeVpn, fakeSpawn, makeEnv, silent, writeFiles } from './testkit.js';

const H = 'a'.repeat(40);

function setup() {
  const env = makeEnv();
  const lib = join(env.config.downloadsDir, 'library');
  mkdirSync(lib, { recursive: true });
  const fs_ = fakeSpawn((_c, _a, _e, p) => p.finish(0));
  const run = () => processDeletions({ db: env.db, config: env.config, log: silent, spawn: fs_.spawn, rcloneBin: 'rclone', endpointGuard: async () => undefined });
  const queue = (destId: number, remote: string) => enqueueDeletion(env.db, env.config.appSecret, { destination_id: destId, remote_path: remote, state: 'completed' } as JobRow);
  const rows = () => env.db.prepare('SELECT * FROM pending_deletions').all() as { id: number; attempts: number; last_error: string | null; retry_at: number }[];
  return { ...env, lib, fs_, run, queue, rows };
}

describe('local library deletion', () => {
  it('deletes the job folder and prunes the empty <slug>-<id> parent, keeping siblings and the library root', async () => {
    const s = setup();
    const u = addUser(s.db, 'alice');
    const d = addDest(s.db, { type: 'local', subdir: 'lib' });
    writeFiles(s.lib, { 'lib/alice-1/Movie [aaaaaaaa]/a.mkv': 'A', 'lib/alice-1/Movie [aaaaaaaa]/sub/b.srt': 'B', 'lib/alice-1/Other [bbbbbbbb]/c.mkv': 'C', 'lib/bob-2/Z [cccccccc]/z': 'Z' });
    s.queue(d, 'alice-1/Movie [aaaaaaaa]');
    await s.run();
    expect(existsSync(join(s.lib, 'lib/alice-1/Movie [aaaaaaaa]'))).toBe(false);
    expect(existsSync(join(s.lib, 'lib/alice-1/Other [bbbbbbbb]/c.mkv'))).toBe(true); // sibling kept, so the parent stays
    expect(s.rows()).toEqual([]);
    s.queue(d, 'alice-1/Other [bbbbbbbb]');
    await s.run();
    expect(existsSync(join(s.lib, 'lib/alice-1'))).toBe(false); // now empty: pruned
    expect(existsSync(join(s.lib, 'lib/bob-2/Z [cccccccc]/z'))).toBe(true);
    expect(existsSync(s.lib)).toBe(true);
    void u;
  });

  it('deletes only when no other job row references the same destination + remote_path', async () => {
    const s = setup();
    const u = addUser(s.db, 'alice');
    const d = addDest(s.db, { type: 'local' });
    const t = addTorrent(s.db, H);
    const other = addJob(s.db, u, t, d);
    s.db.prepare("UPDATE jobs SET state = 'completed', remote_path = 'alice-1/Movie [aaaaaaaa]' WHERE id = ?").run(other);
    writeFiles(s.lib, { 'alice-1/Movie [aaaaaaaa]/a.mkv': 'A' });
    s.queue(d, 'alice-1/Movie [aaaaaaaa]');
    await s.run();
    expect(existsSync(join(s.lib, 'alice-1/Movie [aaaaaaaa]/a.mkv'))).toBe(true); // still referenced
    expect(s.rows()).toEqual([]); // the request is dropped, not retried forever
    // once the other job is gone, a new request deletes it
    s.db.prepare('DELETE FROM jobs WHERE id = ?').run(other);
    s.queue(d, 'alice-1/Movie [aaaaaaaa]');
    await s.run();
    expect(existsSync(join(s.lib, 'alice-1/Movie [aaaaaaaa]'))).toBe(false);
  });

  it('is not fooled by a different local destination that maps to the same library path', async () => {
    const s = setup();
    const u = addUser(s.db, 'alice');
    const d1 = addDest(s.db, { type: 'local', subdir: 'x' });
    const d2 = addDest(s.db, { type: 'local', subdir: 'x' });
    const t = addTorrent(s.db, H);
    const j = addJob(s.db, u, t, d2);
    s.db.prepare("UPDATE jobs SET state = 'completed', remote_path = 'alice-1/M [aaaaaaaa]' WHERE id = ?").run(j);
    writeFiles(s.lib, { 'x/alice-1/M [aaaaaaaa]/f': 'F' });
    s.queue(d1, 'alice-1/M [aaaaaaaa]');
    await s.run();
    expect(existsSync(join(s.lib, 'x/alice-1/M [aaaaaaaa]/f'))).toBe(true);
  });

  it('refuses paths with .. or that leave the library (nothing outside is touched) and retries with backoff', async () => {
    const s = setup();
    const outside = join(s.dir, 'secret');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'k');
    const d = addDest(s.db, { type: 'local' });
    for (const full of ['../secret', 'a/../../secret', '/etc', '', 'a//b', '.staging/5', 'a\\b']) {
      s.db.prepare("INSERT INTO pending_deletions (destination_id, remote_path, kind, full_path, created_at) VALUES (?, 'x', 'local', ?, ?)").run(d, full, now());
    }
    await s.run();
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    const rows = s.rows();
    expect(rows.map((r) => r.attempts)).toEqual(rows.map(() => 1)); // every one failed validation, none deleted
    expect(rows.every((r) => /Refusing|unsafe/i.test(r.last_error ?? ''))).toBe(true);
    expect(rows.every((r) => r.retry_at > now())).toBe(true);
    await s.run(); // not due yet
    expect(s.rows().map((r) => r.attempts)).toEqual(rows.map(() => 1));
  });

  it('waits while the same torrent was added again for the destination (delete + immediate re-add), then deletes', async () => {
    const s = setup();
    const u = addUser(s.db, 'alice');
    const d = addDest(s.db, { type: 'local' });
    const t = addTorrent(s.db, H);
    writeFiles(s.lib, { 'alice-1/Movie [aaaaaaaa]/a.mkv': 'A' });
    s.db.prepare("INSERT INTO pending_deletions (destination_id, remote_path, torrent_id, kind, full_path, created_at) VALUES (?, 'alice-1/Movie [aaaaaaaa]', ?, 'local', 'alice-1/Movie [aaaaaaaa]', ?)").run(d, t, now());
    const again = addJob(s.db, u, t, d); // queued: its remote_path is not known yet, so only the torrent link protects the files
    await s.run();
    expect(existsSync(join(s.lib, 'alice-1/Movie [aaaaaaaa]/a.mkv'))).toBe(true);
    expect(s.rows()[0]!.attempts).toBe(0);
    s.db.prepare("UPDATE jobs SET state = 'completed', remote_path = 'alice-1/Other [bbbbbbbb]' WHERE id = ?").run(again);
    s.db.prepare('UPDATE pending_deletions SET retry_at = 0').run();
    await s.run();
    expect(existsSync(join(s.lib, 'alice-1/Movie [aaaaaaaa]'))).toBe(false);
  });

  it('does not follow a symlinked parent out of the library', async () => {
    const s = setup();
    const outside = join(s.dir, 'outside');
    writeFiles(outside, { 'victim/f.txt': 'x' });
    symlinkSync(outside, join(s.lib, 'escape'));
    const d = addDest(s.db, { type: 'local' });
    s.queue(d, 'escape/victim');
    await s.run();
    expect(existsSync(join(outside, 'victim/f.txt'))).toBe(true);
    expect(s.rows()).toHaveLength(1);
  });

  it('waits while an active job still needs the library copy, then deletes and forgets the library path', async () => {
    const s = setup();
    const u = addUser(s.db, 'alice');
    const u2 = addUser(s.db, 'bob');
    const d = addDest(s.db, { type: 'local' });
    const t = addTorrent(s.db, H);
    const target = join(s.lib, 'alice-1/Movie [aaaaaaaa]');
    writeFiles(s.lib, { 'alice-1/Movie [aaaaaaaa]/a.mkv': 'A' });
    s.db.prepare('UPDATE torrents SET library_path = ?, state = ? WHERE id = ?').run(target, 'downloaded', t);
    const active = addJob(s.db, u2, t, d); // bob's queued job will copy from the library
    s.queue(d, 'alice-1/Movie [aaaaaaaa]');
    await s.run();
    expect(existsSync(target)).toBe(true);
    expect(s.rows()[0]!.attempts).toBe(0); // deferred, not failed
    s.db.prepare("UPDATE pending_deletions SET retry_at = 0").run();
    s.db.prepare("UPDATE jobs SET state = 'completed' WHERE id = ?").run(active);
    await s.run();
    expect(existsSync(target)).toBe(false);
    expect((s.db.prepare('SELECT library_path FROM torrents WHERE id = ?').get(t) as { library_path: string | null }).library_path).toBeNull();
    void u;
  });
});

describe('S3 purge (cleanup.deleteRemoteOnJobDelete)', () => {
  const cfg = { type: 's3' as const, endpoint: 'https://s3.example.test', region: 'r', accessKeyId: 'AKIAEXAMPLE0000', secretAccessKey: 'secretsecret', bucket: 'bkt', prefix: 'pre' };

  it('runs exactly `rclone purge DST:bkt/pre/<jobDir>` for a user-owned destination, through the egress proxy', async () => {
    const s = setup();
    const u = addUser(s.db, 'alice');
    setSetting(s.db, 'cleanup.deleteRemoteOnJobDelete', true);
    const d = addDest(s.db, cfg, u);
    s.queue(d, 'Movie [aaaaaaaa]');
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const spawn = fakeSpawn((_c, a, e, p) => { calls.push({ args: a, env: e }); p.finish(0); }).spawn;
    await processDeletions({ db: s.db, config: s.config, log: silent, spawn, rcloneBin: 'rclone', endpointGuard: async () => undefined, egress: { env: async () => ({ env: { HTTPS_PROXY: 'http://p' }, secrets: [] }) } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(0, 2)).toEqual(['purge', 'DST:bkt/pre/Movie [aaaaaaaa]']);
    expect(calls[0]!.args).not.toContain('copy');
    expect(calls[0]!.env.HTTPS_PROXY).toBe('http://p');
    expect(calls[0]!.env.RCLONE_CONFIG_DST_ENDPOINT).toBe('https://s3.example.test');
    expect(s.rows()).toEqual([]);
  });

  it('a hanging purge does not block the worker tick, and stop() aborts it', async () => {
    const env = makeEnv();
    setSetting(env.db, 'cleanup.deleteRemoteOnJobDelete', true);
    const d = addDest(env.db, cfg);
    enqueueDeletion(env.db, env.config.appSecret, { destination_id: d, remote_path: 'alice-1/Movie [aaaaaaaa]', state: 'completed', torrent_id: null });
    const hang = fakeSpawn(); // never exits on its own
    const w = new Worker({ db: env.db, config: env.config, downloader: new FakeDownloader(), vpn: new FakeVpn(), log: silent, vpnEveryMs: 1e9, spawn: hang.spawn, tickMs: 1e9 });
    const t0 = Date.now();
    await w.tick();
    expect(Date.now() - t0).toBeLessThan(1000);
    await new Promise((r) => setTimeout(r, 50));
    expect(hang.procs).toHaveLength(1);
    expect(hang.procs[0]!.killed).toBe(false);
    await w.stop();
    expect(hang.procs[0]!.killed).toBe(true);
  });

  it('treats "directory not found" as done and keeps retrying real failures', async () => {
    const s = setup();
    setSetting(s.db, 'cleanup.deleteRemoteOnJobDelete', true);
    const d = addDest(s.db, cfg);
    s.queue(d, 'alice-1/Movie [aaaaaaaa]');
    const gone = fakeSpawn((_c, _a, _e, p) => p.finish(3, [JSON.stringify({ level: 'error', msg: 'directory not found' })]));
    await processDeletions({ db: s.db, config: s.config, log: silent, spawn: gone.spawn, rcloneBin: 'rclone' });
    expect(s.rows()).toEqual([]);
    s.queue(d, 'alice-1/Movie [aaaaaaaa]');
    const bad = fakeSpawn((_c, _a, _e, p) => p.finish(1, [JSON.stringify({ level: 'error', msg: 'boom AKIAEXAMPLE0000 secretsecret' })]));
    await processDeletions({ db: s.db, config: s.config, log: silent, spawn: bad.spawn, rcloneBin: 'rclone' });
    const [row] = s.rows();
    expect(row!.attempts).toBe(1);
    expect(row!.last_error).not.toContain('secretsecret');
  });

  it('keeps the data when another job still uses the same job folder', async () => {
    const s = setup();
    const u = addUser(s.db, 'alice');
    setSetting(s.db, 'cleanup.deleteRemoteOnJobDelete', true);
    const d = addDest(s.db, cfg);
    const j = addJob(s.db, u, addTorrent(s.db, H), d);
    s.db.prepare("UPDATE jobs SET remote_path = 'alice-1/Movie [aaaaaaaa]' WHERE id = ?").run(j);
    s.queue(d, 'alice-1/Movie [aaaaaaaa]');
    await s.run();
    expect(s.fs_.calls).toHaveLength(0);
  });

  it.each([
    ['', true], ['..', true], ['../x [aaaaaaaa]', true], ['a/b [aaaaaaaa]', true] /* user-owned has one segment */, ['Movie', true], ['Movie [zzzzzzzz]', true],
    ['a/../b [aaaaaaaa]', false], ['a/b/c [aaaaaaaa]', false], ['/b [aaaaaaaa]', false], ['a\\b [aaaaaaaa]', false], ['a/b', false], ['', false],
  ])('buildS3PurgeCommand refuses the unexpected remote path %j (userOwned=%s)', (path, userOwned) => {
    expect(() => buildS3PurgeCommand(cfg, path, userOwned)).toThrow(/Refusing/);
  });
  it('buildS3PurgeCommand accepts the two real shapes and nothing deeper than the prefix', () => {
    expect(buildS3PurgeCommand(cfg, 'Movie [aaaaaaaa]', true).args.slice(0, 2)).toEqual(['purge', 'DST:bkt/pre/Movie [aaaaaaaa]']);
    expect(buildS3PurgeCommand({ ...cfg, prefix: '' }, 'alice-1/Movie [aaaaaaaa]', false).args.slice(0, 2)).toEqual(['purge', 'DST:bkt/alice-1/Movie [aaaaaaaa]']);
  });
});
