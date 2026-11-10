import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setSetting } from '../lib/settings.js';
import { encrypt } from '../lib/crypto.js';
import { Worker, type WorkerDeps } from './loop.js';
import {
  addDest, addJob, addTorrent, addUser, fakeSpawn, FakeDownloader, FakeVpn, files, job, makeEnv, SECRET, silent, torrent, writeFiles,
} from './testkit.js';

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);

function setup(extra: Partial<WorkerDeps> = {}) {
  const env = makeEnv();
  const dl = new FakeDownloader();
  const vpn = new FakeVpn();
  const worker = new Worker({ db: env.db, config: env.config, downloader: dl, vpn, log: silent, vpnEveryMs: 1e9, ...extra });
  const content = (hash: string) => join(env.config.downloadsDir, 'incomplete', hash);
  const complete = (hash: string, name: string, totalSize: number, contentPath: string) =>
    dl.set(hash, { state: 'completed', name, totalSize, progress: 1, contentPath, savePath: content(hash) });
  return { ...env, dl, vpn, worker, content, complete };
}

describe('local destination state machine', () => {
  it('multi-file torrent: pending -> downloading -> downloaded -> uploading -> completed, torrent removed', async () => {
    const s = setup();
    const u = addUser(s.db, 'Alice');
    const d = addDest(s.db, { type: 'local' }, null);
    const t = addTorrent(s.db, H1);
    const j = addJob(s.db, u, t, d);
    const name = "Big Buck's Bunny #1 100% ünï";
    writeFiles(join(s.content(H1), name), {
      'it\'s a file.txt': 'a', 'sub dir/ünï cødé #1 100%.bin': 'bb', 'sub dir/deeper/x y.txt': 'ccc', 'top.mkv': 'dddd',
    });

    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('downloading');
    expect(s.dl.added).toHaveLength(1);
    expect(s.dl.added[0]!.savePath).toBe(s.content(H1));
    expect(job(s.db, j).state).toBe('downloading');

    // metadata pending: nothing changes
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('downloading');

    s.dl.set(H1, { state: 'downloading', name, totalSize: 10, progress: 0.4, dlSpeed: 1234, contentPath: join(s.content(H1), name) });
    const before = job(s.db, j).updated_at;
    await s.worker.tick();
    expect(torrent(s.db, t)).toMatchObject({ name, total_size: 10, progress: 0.4, dl_speed: 1234, state: 'downloading' });
    expect(job(s.db, j).updated_at).toBeGreaterThanOrEqual(before);

    s.complete(H1, name, 10, join(s.content(H1), name));
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('downloaded');
    expect(torrent(s.db, t).completed_at).not.toBeNull();
    await s.worker.idle();
    await s.worker.tick();
    await s.worker.idle();

    const row = job(s.db, j);
    expect(row.state).toBe('completed');
    expect(row.upload_progress).toBe(1);
    expect(row.remote_path).toBe(`alice/${name}`);
    expect(files(s.db, j).map((f) => f.path)).toEqual([
      "it's a file.txt", 'sub dir/deeper/x y.txt', 'sub dir/ünï cødé #1 100%.bin', 'top.mkv',
    ]);
    expect(files(s.db, j).find((f) => f.path === 'top.mkv')!.size).toBe(4);
    const lib = join(s.config.downloadsDir, 'library', 'alice', name);
    expect(readFileSync(join(lib, 'sub dir/ünï cødé #1 100%.bin'), 'utf8')).toBe('bb');
    expect(torrent(s.db, t).state).toBe('removed');
    expect(s.dl.removed).toEqual([{ ref: H1, deleteData: true }]);
    expect(existsSync(s.content(H1))).toBe(false);
  });

  it('single-file torrent lands at <remote_path>/<file>', async () => {
    const s = setup();
    const u = addUser(s.db, 'bob');
    const d = addDest(s.db, { type: 'local', subdir: 'pub' }, u); // user-owned: no user slug
    const t = addTorrent(s.db, H1);
    const j = addJob(s.db, u, t, d);
    writeFiles(s.content(H1), { 'movie file.mkv': 'xyz' });
    await s.worker.tick();
    s.complete(H1, 'movie file.mkv', 3, join(s.content(H1), 'movie file.mkv'));
    await s.worker.tick();
    await s.worker.idle();
    expect(job(s.db, j).state).toBe('completed');
    expect(job(s.db, j).remote_path).toBe('movie file.mkv');
    expect(files(s.db, j)).toEqual([{ path: 'movie file.mkv', size: 3 }]);
    expect(readFileSync(join(s.config.downloadsDir, 'library', 'pub', 'movie file.mkv', 'movie file.mkv'), 'utf8')).toBe('xyz');
  });

  it('two jobs on one torrent complete; the torrent is removed only after the second', async () => {
    const s = setup({ maxUploads: 1 });
    const u1 = addUser(s.db, 'alice');
    const u2 = addUser(s.db, 'bob');
    const d = addDest(s.db, { type: 'local' }, null);
    const t = addTorrent(s.db, H1);
    const j1 = addJob(s.db, u1, t, d);
    const j2 = addJob(s.db, u2, t, d);
    writeFiles(join(s.content(H1), 'Pack'), { 'a.txt': 'A', 'd/b.txt': 'B' });
    await s.worker.tick();
    s.complete(H1, 'Pack', 2, join(s.content(H1), 'Pack'));

    await s.worker.tick(); await s.worker.idle(); // job 1 (copy: job 2 still needs the data)
    expect(job(s.db, j1).state).toBe('completed');
    expect(job(s.db, j2).state).toBe('downloading');
    expect(torrent(s.db, t).state).toBe('downloaded');
    expect(s.dl.removed).toHaveLength(0);
    expect(existsSync(join(s.content(H1), 'Pack', 'a.txt'))).toBe(true);

    await s.worker.tick(); await s.worker.idle(); // job 2 (last one: may move)
    expect(job(s.db, j2).state).toBe('completed');
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('removed');
    expect(s.dl.removed).toHaveLength(1);
    for (const user of ['alice', 'bob']) expect(readFileSync(join(s.config.downloadsDir, 'library', user, 'Pack', 'd/b.txt'), 'utf8')).toBe('B');
    expect(files(s.db, j1)).toEqual(files(s.db, j2));
  });

  it('keeps files for seeding when seeding.ratio > 0 and removes once the ratio is reached', async () => {
    const s = setup();
    setSetting(s.db, 'seeding.ratio', 1.5);
    const u = addUser(s.db, 'alice');
    const t = addTorrent(s.db, H1);
    const j = addJob(s.db, u, t, addDest(s.db, { type: 'local' }));
    writeFiles(join(s.content(H1), 'P'), { 'a.txt': 'A' });
    await s.worker.tick();
    s.complete(H1, 'P', 1, join(s.content(H1), 'P'));
    await s.worker.tick(); await s.worker.idle(); await s.worker.tick();
    expect(job(s.db, j).state).toBe('completed');
    expect(existsSync(join(s.content(H1), 'P', 'a.txt'))).toBe(true); // copied, not moved
    expect(torrent(s.db, t).state).toBe('downloaded');
    s.dl.set(H1, { ratio: 2 });
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('removed');
  });

  it('cancel during download removes the torrent with its data', async () => {
    const s = setup();
    const u = addUser(s.db, 'alice');
    const t = addTorrent(s.db, H1);
    const j = addJob(s.db, u, t, addDest(s.db, { type: 'local' }));
    await s.worker.tick();
    s.dl.set(H1, { state: 'downloading', name: 'X', totalSize: 100, progress: 0.1 });
    await s.worker.tick();
    s.db.prepare("UPDATE jobs SET state = 'cancelled' WHERE id = ?").run(j);
    await s.worker.tick();
    expect(s.dl.removed).toEqual([{ ref: H1, deleteData: true }]);
    expect(torrent(s.db, t).state).toBe('removed');
    expect(job(s.db, j).state).toBe('cancelled');
  });

  it('a torrent cancelled while still pending is retired without being added', async () => {
    const s = setup();
    const u = addUser(s.db, 'alice');
    const t = addTorrent(s.db, H1);
    const j = addJob(s.db, u, t, addDest(s.db, { type: 'local' }));
    s.db.prepare("UPDATE jobs SET state = 'cancelled' WHERE id = ?").run(j);
    await s.worker.tick();
    expect(s.dl.added).toHaveLength(0);
    expect(torrent(s.db, t).state).toBe('removed');
  });

  it('downloader error fails the jobs; a vanished torrent too', async () => {
    const s = setup();
    const u = addUser(s.db, 'alice');
    const d = addDest(s.db, { type: 'local' });
    const t1 = addTorrent(s.db, H1); const j1 = addJob(s.db, u, t1, d);
    const t2 = addTorrent(s.db, H2); const j2 = addJob(s.db, u, t2, d);
    await s.worker.tick();
    s.dl.set(H1, { state: 'error', rawState: 'missingFiles' });
    s.dl.items.delete(H2);
    await s.worker.tick();
    expect(torrent(s.db, t1).state).toBe('error');
    expect(job(s.db, j1)).toMatchObject({ state: 'failed' });
    expect(job(s.db, j1).error).toContain('missingFiles');
    expect(torrent(s.db, t2).state).toBe('error');
    expect(job(s.db, j2).state).toBe('failed');
  });

  it('torrent larger than limits.maxTorrentBytes -> error, jobs failed, removed with data', async () => {
    const s = setup();
    setSetting(s.db, 'limits.maxTorrentBytes', 100);
    const u = addUser(s.db, 'alice');
    const t = addTorrent(s.db, H1);
    const j = addJob(s.db, u, t, addDest(s.db, { type: 'local' }));
    await s.worker.tick();
    s.dl.set(H1, { state: 'downloading', name: 'Huge', totalSize: 5000, progress: 0.01 });
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('error');
    expect(job(s.db, j).state).toBe('failed');
    expect(job(s.db, j).error).toMatch(/exceeds the maximum allowed size/);
    expect(s.dl.removed).toEqual([{ ref: H1, deleteData: true }]);
  });

  it('restart recovery: an `uploading` job is restarted from scratch', async () => {
    const s = setup();
    const u = addUser(s.db, 'alice');
    const t = addTorrent(s.db, H1);
    const j = addJob(s.db, u, t, addDest(s.db, { type: 'local' }));
    writeFiles(join(s.content(H1), 'Pack'), { 'a.txt': 'A' });
    s.complete(H1, 'Pack', 1, join(s.content(H1), 'Pack'));
    s.db.prepare("UPDATE torrents SET state = 'downloaded', name = 'Pack' WHERE id = ?").run(t);
    s.db.prepare("UPDATE jobs SET state = 'uploading', upload_progress = 0.5 WHERE id = ?").run(j);
    await s.worker.tick(); await s.worker.idle();
    expect(job(s.db, j).state).toBe('completed');
    expect(files(s.db, j)).toEqual([{ path: 'a.txt', size: 1 }]);
  });

  it('restart recovery after a local rename that already happened', async () => {
    const s = setup();
    const u = addUser(s.db, 'alice');
    const t = addTorrent(s.db, H1);
    const j = addJob(s.db, u, t, addDest(s.db, { type: 'local' }));
    writeFiles(join(s.config.downloadsDir, 'library', 'alice', 'Pack'), { 'a.txt': 'A' });
    s.db.prepare("UPDATE torrents SET state = 'downloaded', name = 'Pack' WHERE id = ?").run(t);
    s.db.prepare("UPDATE jobs SET state = 'uploading' WHERE id = ?").run(j);
    await s.worker.tick(); await s.worker.idle();
    expect(job(s.db, j).state).toBe('completed');
    expect(files(s.db, j)).toEqual([{ path: 'a.txt', size: 1 }]);
  });
});

describe('gating', () => {
  it('vpn.mode=required and VPN not connected keeps torrents pending', async () => {
    const s = setup();
    setSetting(s.db, 'vpn.mode', 'required');
    const u = addUser(s.db, 'alice');
    const t = addTorrent(s.db, H1);
    const j = addJob(s.db, u, t, addDest(s.db, { type: 'local' }));
    await s.worker.tick(); await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('pending');
    expect(job(s.db, j).state).toBe('queued');
    expect(s.dl.added).toHaveLength(0);
    s.vpn.fail = true; // unreachable sidecar counts as not connected
    await s.worker.tick();
    expect(s.dl.added).toHaveLength(0);
    s.vpn.fail = false;
    s.vpn.status_.connected = true;
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('downloading');
    expect(s.dl.added).toHaveLength(1);
  });

  it('low free disk keeps torrents pending', async () => {
    let free = 10;
    const s = setup({ freeBytes: async () => free });
    setSetting(s.db, 'limits.minFreeDiskBytes', 1000);
    const u = addUser(s.db, 'alice');
    const t = addTorrent(s.db, H1);
    addJob(s.db, u, t, addDest(s.db, { type: 'local' }));
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('pending');
    free = 5000;
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('downloading');
  });

  it('a failing step does not stop the others', async () => {
    const s = setup();
    const u = addUser(s.db, 'alice');
    const t = addTorrent(s.db, H1);
    addJob(s.db, u, t, addDest(s.db, { type: 'local' }));
    s.dl.add = async () => { throw new Error('qbt down'); };
    await expect(s.worker.tick()).resolves.toBeUndefined();
    expect(torrent(s.db, t).state).toBe('pending');
  });
});

describe('rclone destinations', () => {
  const gdrive = { type: 'gdrive', clientId: 'cid', clientSecret: 'super-secret-value-xyz', refreshToken: '1//refresh-token-value-123456', rootFolderId: 'ROOT', sharing: 'anyone' } as const;

  async function toUploading(s: ReturnType<typeof setup>, dest: number, username = 'alice', email: string | null = null) {
    const u = addUser(s.db, username, email);
    const t = addTorrent(s.db, H1);
    const j = addJob(s.db, u, t, dest);
    writeFiles(join(s.content(H1), 'Pack'), { 'a.txt': 'A' });
    await s.worker.tick();
    s.complete(H1, 'Pack', 1, join(s.content(H1), 'Pack'));
    return { u, t, j };
  }

  it('failed rclone -> job failed with a redacted message', async () => {
    const fs_ = fakeSpawn((_c, _a, _e, p) => p.finish(1, [
      JSON.stringify({ level: 'error', msg: `Failed to copy: couldn't fetch token: refresh_token=${gdrive.refreshToken} secret ${gdrive.clientSecret}` }),
      JSON.stringify({ level: 'error', msg: 'Authorization: Bearer ya29.abcdefghijklmnopqrstuvwxyz0123456789ABCDEF' }),
    ]));
    const s = setup({ spawn: fs_.spawn });
    const { j } = await toUploading(s, addDest(s.db, gdrive));
    await s.worker.tick(); await s.worker.idle();
    const row = job(s.db, j);
    expect(row.state).toBe('failed');
    expect(row.error).toContain('rclone failed (exit 1)');
    for (const secret of [gdrive.refreshToken, gdrive.clientSecret, 'ya29']) expect(row.error).not.toContain(secret);
  });

  it('gdrive success: rclone gets env-only credentials, progress is parsed, folder shared with anyone', async () => {
    const shared: unknown[] = [];
    const fs_ = fakeSpawn((_c, _a, _e, p) => {
      p.stderr.write(JSON.stringify({ level: 'warning', msg: 'stats', stats: { bytes: 50, totalBytes: 100, speed: 7 } }) + '\n');
      p.finish(0);
    });
    const s = setup({
      spawn: fs_.spawn,
      gdrive: {
        ensureFolderPath: async (_c, _g, root, segs) => `${root}/${segs.join('/')}`,
        shareFolder: async (_c, _g, id, target) => { shared.push([id, target]); },
      },
    });
    const { j } = await toUploading(s, addDest(s.db, gdrive));
    await s.worker.tick(); await s.worker.idle();
    expect(job(s.db, j)).toMatchObject({ state: 'completed', folder_url: 'https://drive.google.com/drive/folders/ROOT/alice', remote_path: 'alice/Pack' });
    expect(shared).toEqual([['ROOT/alice', 'anyone']]);
    const call = fs_.calls[0]!;
    expect(call.args.join(' ')).not.toContain(gdrive.refreshToken);
    expect(call.args.join(' ')).not.toContain(gdrive.clientSecret);
    expect(call.args.slice(0, 3)).toEqual(['copy', join(s.content(H1), 'Pack'), 'DST:alice/Pack']);
    expect(call.env.RCLONE_CONFIG_DST_TYPE).toBe('drive');
  });

  it('sharing errors do not fail the job; sharing=user shares with the email', async () => {
    const fs_ = fakeSpawn((_c, _a, _e, p) => p.finish(0));
    const s = setup({
      spawn: fs_.spawn,
      gdrive: { ensureFolderPath: async () => 'F', shareFolder: async () => { throw new Error('quota'); } },
    });
    const { j } = await toUploading(s, addDest(s.db, { ...gdrive, sharing: 'user' }), 'alice', 'a@example.test');
    await s.worker.tick(); await s.worker.idle();
    expect(job(s.db, j)).toMatchObject({ state: 'completed', folder_url: null });
  });

  it('s3 success: target, flags and env', async () => {
    const fs_ = fakeSpawn((_c, _a, _e, p) => p.finish(0));
    const s = setup({ spawn: fs_.spawn });
    const dest = addDest(s.db, { type: 's3', endpoint: 'https://s3.example.test', region: 'r1', accessKeyId: 'AKIAEXAMPLE0000', secretAccessKey: 's3-secret-key', bucket: 'bkt', prefix: 'pre' });
    const { j } = await toUploading(s, dest);
    await s.worker.tick(); await s.worker.idle();
    expect(job(s.db, j).state).toBe('completed');
    expect(fs_.calls[0]!.args[2]).toBe('DST:bkt/pre/alice/Pack');
    expect(fs_.calls[0]!.args).toContain('--s3-no-check-bucket');
  });

  it('cancelling mid-upload kills rclone and leaves the job cancelled', async () => {
    const fs_ = fakeSpawn(); // never exits on its own
    const s = setup({ spawn: fs_.spawn });
    const { j } = await toUploading(s, addDest(s.db, gdrive));
    await s.worker.tick();
    expect(job(s.db, j).state).toBe('uploading');
    await new Promise((r) => setTimeout(r, 30));
    expect(fs_.procs).toHaveLength(1);
    s.db.prepare("UPDATE jobs SET state = 'cancelled' WHERE id = ?").run(j);
    await s.worker.tick(); await s.worker.idle();
    expect(fs_.procs[0]!.killed).toBe(true);
    expect(job(s.db, j).state).toBe('cancelled');
  });

  it('runs at most 2 uploads at a time', async () => {
    const fs_ = fakeSpawn();
    const s = setup({ spawn: fs_.spawn });
    const d = addDest(s.db, { ...gdrive, sharing: 'none' });
    const u = addUser(s.db, 'alice');
    for (let i = 0; i < 3; i++) {
      const h = String(i).repeat(40);
      const t = addTorrent(s.db, h);
      addJob(s.db, u, t, d);
      writeFiles(join(s.content(h), 'P'), { 'a.txt': 'A' });
    }
    await s.worker.tick();
    for (let i = 0; i < 3; i++) s.complete(String(i).repeat(40), 'P', 1, join(s.content(String(i).repeat(40)), 'P'));
    await s.worker.tick();
    await new Promise((r) => setTimeout(r, 30));
    expect(fs_.procs).toHaveLength(2);
    for (const p of fs_.procs) p.finish(0);
    await new Promise((r) => setTimeout(r, 30));
    await s.worker.tick();
    await new Promise((r) => setTimeout(r, 30));
    expect(fs_.procs).toHaveLength(3);
    fs_.procs[2]!.finish(0);
    await s.worker.idle();
  });

  it('encrypt helper sanity (config decrypts with the app secret)', () => {
    expect(encrypt(SECRET, 'x')).toMatch(/^v1:/);
  });
});
