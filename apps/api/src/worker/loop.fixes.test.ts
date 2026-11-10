/** Regression tests for the review findings in the worker (races, transient downloader loss, disk limits, local moves, Drive folders, SSRF). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DownloaderUnavailableError } from '../downloaders/types.js';
import { setSetting } from '../lib/settings.js';
import { now } from '../lib/types.js';
import { Worker, type WorkerDeps } from './loop.js';
import {
  addDest, addJob, addTorrent, addUser, fakeSpawn, FakeDownloader, FakeVpn, files, job, makeEnv, silent, torrent, writeFiles,
} from './testkit.js';

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);

function setup(extra: Partial<WorkerDeps> = {}) {
  const env = makeEnv();
  const dl = new FakeDownloader();
  const vpn = new FakeVpn();
  const clock = { ms: Date.now() };
  const worker = new Worker({ db: env.db, config: env.config, downloader: dl, vpn, log: silent, vpnEveryMs: 1e9, nowMs: () => clock.ms, ...extra });
  const content = (hash: string) => join(env.config.downloadsDir, 'incomplete', hash);
  const complete = (hash: string, name: string, totalSize: number, contentPath: string) =>
    dl.set(hash, { state: 'completed', name, totalSize, progress: 1, contentPath, savePath: content(hash) });
  return { ...env, dl, vpn, worker, clock, content, complete };
}
type S = ReturnType<typeof setup>;
const active = (s: S, t: number) => (s.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE torrent_id = ? AND state IN ('queued','downloading','uploading')").get(t) as { n: number }).n;

describe('races that used to strand jobs', () => {
  it('a job inserted while cleanup is removing the torrent is not left queued with the data gone', async () => {
    let inject: (() => void) | null = null;
    const s = setup({ hooks: { afterCleanupRemove: () => inject?.() } });
    const u = addUser(s.db, 'alice');
    const d = addDest(s.db, { type: 'local' });
    const t = addTorrent(s.db, H1);
    const j1 = addJob(s.db, u, t, d);
    writeFiles(join(s.content(H1), 'Pack'), { 'a.txt': 'A' });
    await s.worker.tick();
    s.complete(H1, 'Pack', 1, join(s.content(H1), 'Pack'));
    s.db.prepare("UPDATE jobs SET state = 'cancelled' WHERE id = ?").run(j1); // the only job goes away -> cleanup runs
    let j2 = 0;
    inject = () => { j2 = addJob(s.db, u, t, d); inject = null; }; // the API adds a job during the slow removal
    await s.worker.tick();
    expect(j2).toBeGreaterThan(0);
    expect(torrent(s.db, t).state).not.toBe('removed');
    // it goes back to pending, is re-added and the job proceeds (nothing sits in `queued` forever)
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('downloading');
    expect(s.dl.added.length).toBeGreaterThanOrEqual(2);
    expect(job(s.db, j2).state).toBe('downloading');
  });

  it('self-heal: a removed or errored torrent with an active job is reset to pending and re-downloaded', async () => {
    const s = setup();
    const u = addUser(s.db, 'alice');
    const d = addDest(s.db, { type: 'local' });
    for (const state of ['removed', 'error']) {
      const h = state === 'removed' ? H1 : H2;
      const t = addTorrent(s.db, h);
      s.db.prepare('UPDATE torrents SET state = ? WHERE id = ?').run(state, t);
      const j = addJob(s.db, u, t, d);
      await s.worker.tick();
      expect(torrent(s.db, t).state).toBe('downloading');
      expect(job(s.db, j).state).toBe('downloading');
    }
  });

  it('a pending torrent whose only job was cancelled is retired with one conditional statement (a new job keeps it)', async () => {
    const s = setup();
    const u = addUser(s.db, 'alice');
    const d = addDest(s.db, { type: 'local' });
    const t = addTorrent(s.db, H1);
    const j = addJob(s.db, u, t, d);
    s.db.prepare("UPDATE jobs SET state = 'cancelled' WHERE id = ?").run(j);
    addJob(s.db, u, t, d); // retry arrives before the worker looks
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('downloading');
  });

  it('failed torrents are removed by a sweep that retries until the downloader accepts the removal', async () => {
    const s = setup();
    const u = addUser(s.db, 'alice');
    const t = addTorrent(s.db, H1);
    addJob(s.db, u, t, addDest(s.db, { type: 'local' }));
    await s.worker.tick();
    s.dl.set(H1, { state: 'error', rawState: 'error' });
    let failRemove = true;
    const realRemove = s.dl.remove.bind(s.dl);
    s.dl.remove = async (ref, del) => { if (failRemove) throw new Error('qbt restarting'); return realRemove(ref, del); };
    await s.worker.tick();
    expect(torrent(s.db, t)).toMatchObject({ state: 'error', cleanup_pending: 1 });
    failRemove = false;
    await s.worker.tick();
    expect(s.dl.removed).toEqual([{ ref: H1, deleteData: true }]);
    expect(torrent(s.db, t).cleanup_pending).toBe(0);
  });

  it('the sweep does not delete a torrent a retry re-added in the meantime', async () => {
    const s = setup();
    const u = addUser(s.db, 'alice');
    const t = addTorrent(s.db, H1);
    const j = addJob(s.db, u, t, addDest(s.db, { type: 'local' }));
    await s.worker.tick();
    s.dl.set(H1, { state: 'error', rawState: 'error' });
    const realRemove = s.dl.remove.bind(s.dl);
    s.dl.remove = async () => { throw new Error('down'); };
    await s.worker.tick(); // failed, removal pending
    s.dl.remove = realRemove;
    // user presses Retry: job queued again, torrent reset to pending (what the API does)
    s.db.prepare("UPDATE jobs SET state = 'queued', error = NULL WHERE id = ?").run(j);
    s.db.prepare("UPDATE torrents SET state = 'pending', error = NULL WHERE id = ?").run(t);
    s.dl.items.delete(H1);
    await s.worker.tick();
    expect(s.dl.removed).toHaveLength(0);
    expect(s.dl.items.has(H1)).toBe(true);
    expect(torrent(s.db, t)).toMatchObject({ state: 'downloading', cleanup_pending: 0 });
  });
});

describe('a missing torrent is transient (qBittorrent restart)', () => {
  async function downloading(s: S) {
    const u = addUser(s.db, 'alice');
    const t = addTorrent(s.db, H1);
    const j = addJob(s.db, u, t, addDest(s.db, { type: 'local' }));
    await s.worker.tick();
    s.dl.set(H1, { state: 'downloading', name: 'X', totalSize: 100, progress: 0.5 });
    await s.worker.tick();
    return { t, j };
  }

  it('an empty list re-adds the torrent instead of failing it', async () => {
    const s = setup();
    const { t, j } = await downloading(s);
    s.dl.items.delete(H1);
    await s.worker.tick();
    expect(s.dl.added.length).toBe(2);
    expect(torrent(s.db, t).state).toBe('downloading');
    expect(job(s.db, j).state).toBe('downloading');
    expect(s.dl.removed).toHaveLength(0);
  });

  it('fails only after > 120 s missing AND a definitive re-add failure', async () => {
    const s = setup();
    const { t, j } = await downloading(s);
    s.dl.items.delete(H1);
    s.dl.add = async () => { throw new Error('qBittorrent rejected the torrent'); };
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('downloading'); // rejected, but not yet 120 s
    s.clock.ms += 119_000;
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('downloading');
    s.clock.ms += 2_000;
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('error');
    expect(job(s.db, j).state).toBe('failed');
  });

  it('an unreachable downloader never fails jobs, however long it lasts', async () => {
    const s = setup();
    const { t, j } = await downloading(s);
    s.dl.status = async () => { throw new DownloaderUnavailableError('ECONNREFUSED'); };
    for (let i = 0; i < 5; i++) { s.clock.ms += 60_000; await s.worker.tick(); }
    expect(torrent(s.db, t).state).toBe('downloading');
    expect(job(s.db, j).state).toBe('downloading');
    // and a missing torrent whose re-add hits an unreachable downloader is not failed either
    s.dl.status = async () => null;
    s.dl.add = async () => { throw new DownloaderUnavailableError('ECONNREFUSED'); };
    for (let i = 0; i < 5; i++) { s.clock.ms += 60_000; await s.worker.tick(); }
    expect(torrent(s.db, t).state).toBe('downloading');
  });
});

describe('failed uploads keep their data for a grace period', () => {
  it('keeps the downloaded data after a failed upload; Retry re-uploads without re-downloading; removal after the grace', async () => {
    const fs_ = fakeSpawn();
    const s = setup({ spawn: fs_.spawn, gdrive: { ensureFolderPath: async () => 'F', shareFolder: async () => undefined } });
    const u = addUser(s.db, 'alice');
    const t = addTorrent(s.db, H1);
    const d = addDest(s.db, { type: 'gdrive', clientId: 'c', clientSecret: 'cs-cs-cs', refreshToken: 'rt-rt-rt-rt', rootFolderId: 'R', sharing: 'none' });
    const j = addJob(s.db, u, t, d);
    writeFiles(join(s.content(H1), 'Pack'), { 'a.txt': 'A' });
    await s.worker.tick();
    s.complete(H1, 'Pack', 1, join(s.content(H1), 'Pack'));
    await s.worker.tick();
    await new Promise((r) => setTimeout(r, 20));
    fs_.procs[0]!.finish(1, [JSON.stringify({ level: 'error', msg: 'boom' })]);
    await s.worker.idle();
    expect(job(s.db, j).state).toBe('failed');
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('downloaded');
    expect(s.dl.removed).toHaveLength(0);
    expect(existsSync(join(s.content(H1), 'Pack', 'a.txt'))).toBe(true);

    // Retry (what the API does): job -> queued; no re-download, goes straight back to uploading
    s.db.prepare("UPDATE jobs SET state = 'queued', error = NULL WHERE id = ?").run(j);
    const addedBefore = s.dl.added.length;
    await s.worker.tick();
    expect(s.dl.added.length).toBe(addedBefore);
    expect(job(s.db, j).state).toBe('uploading');
    await new Promise((r) => setTimeout(r, 20));
    fs_.procs[1]!.finish(1, [JSON.stringify({ level: 'error', msg: 'boom again' })]);
    await s.worker.idle();

    // grace over -> removed
    s.clock.ms += 61 * 60_000;
    s.db.prepare("UPDATE jobs SET updated_at = ? WHERE id = ?").run(Math.floor(s.clock.ms / 1000) - 61 * 60, j);
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('removed');
    expect(existsSync(s.content(H1))).toBe(false);
  });
});

describe('disk limits and metadata timeout', () => {
  async function started(s: S, h = H1) {
    const u = addUser(s.db, `u${h[0]}`);
    const t = addTorrent(s.db, h);
    const j = addJob(s.db, u, t, addDest(s.db, { type: 'local' }));
    await s.worker.tick();
    return { u, t, j };
  }

  it('fails with a clear message when the torrent does not fit above minFreeDiskBytes', async () => {
    const s = setup({ freeBytes: async () => 1000 });
    setSetting(s.db, 'limits.minFreeDiskBytes', 100);
    const { t, j } = await started(s);
    s.dl.set(H1, { state: 'downloading', name: 'Big', totalSize: 950, progress: 0 });
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('error');
    expect(job(s.db, j).error).toMatch(/not enough free disk space/i);
    expect(s.dl.removed).toEqual([{ ref: H1, deleteData: true }]);
  });

  it('counts the extra library copy when seeding forces copy instead of move', async () => {
    const s = setup({ freeBytes: async () => 1500 });
    setSetting(s.db, 'limits.minFreeDiskBytes', 100);
    setSetting(s.db, 'seeding.ratio', 1);
    const { t } = await started(s);
    s.dl.set(H1, { state: 'downloading', name: 'Big', totalSize: 800, progress: 0 }); // 800 + 800 copy > 1400
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('error');
  });

  it('fits: stays downloading; later free space below the floor fails it', async () => {
    let free = 5000;
    const s = setup({ freeBytes: async () => free, diskCheckEveryMs: 1000 });
    setSetting(s.db, 'limits.minFreeDiskBytes', 100);
    const { t, j } = await started(s);
    s.dl.set(H1, { state: 'downloading', name: 'Big', totalSize: 950, progress: 0.1 });
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('downloading');
    free = 50;
    await s.worker.tick(); // inside the check interval: not re-checked yet
    expect(torrent(s.db, t).state).toBe('downloading');
    s.clock.ms += 2000;
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('error');
    expect(job(s.db, j).error).toMatch(/below the .* reserve/);
  });

  it('a magnet without metadata fails after limits.metadataTimeoutMinutes and frees the job slot', async () => {
    const s = setup();
    setSetting(s.db, 'limits.metadataTimeoutMinutes', 30);
    const { t, j } = await started(s);
    await s.worker.tick(); // metadata-pending
    expect(torrent(s.db, t).state).toBe('downloading');
    s.clock.ms += 29 * 60_000;
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('downloading');
    s.clock.ms += 2 * 60_000;
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('error');
    expect(job(s.db, j)).toMatchObject({ state: 'failed' });
    expect(job(s.db, j).error).toMatch(/no peers \/ metadata timeout/);
    expect(active(s, t)).toBe(0);
  });
});

describe('seeding time cap', () => {
  it('stops seeding after seeding.maxMinutes even if the ratio is not reached', async () => {
    const s = setup();
    setSetting(s.db, 'seeding.ratio', 5);
    setSetting(s.db, 'seeding.maxMinutes', 60);
    const u = addUser(s.db, 'alice');
    const t = addTorrent(s.db, H1);
    addJob(s.db, u, t, addDest(s.db, { type: 'local' }));
    writeFiles(join(s.content(H1), 'P'), { 'a.txt': 'A' });
    await s.worker.tick();
    s.complete(H1, 'P', 1, join(s.content(H1), 'P'));
    await s.worker.tick(); await s.worker.idle(); await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('downloaded'); // seeding
    s.db.prepare('UPDATE torrents SET completed_at = ? WHERE id = ?').run(Math.floor(s.clock.ms / 1000) - 61 * 60, t);
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('removed');
  });
});

describe('local destination: a second job for the same torrent', () => {
  it('a job added after the first one moved the data copies from the library (no re-download)', async () => {
    const s = setup();
    const u1 = addUser(s.db, 'alice');
    const u2 = addUser(s.db, 'bob');
    const d = addDest(s.db, { type: 'local' });
    const t = addTorrent(s.db, H1);
    const j1 = addJob(s.db, u1, t, d);
    writeFiles(join(s.content(H1), 'Pack'), { 'a.txt': 'A', 'd/b.txt': 'B' });
    await s.worker.tick();
    s.complete(H1, 'Pack', 2, join(s.content(H1), 'Pack'));
    await s.worker.tick(); await s.worker.idle();
    expect(job(s.db, j1).state).toBe('completed');
    const lib1 = join(s.config.downloadsDir, 'library', 'alice-1', 'Pack [aaaaaaaa]');
    expect(torrent(s.db, t).library_path).toBe(lib1);
    expect(existsSync(join(s.content(H1), 'Pack'))).toBe(false); // moved

    // torrent is removed by cleanup, then bob adds the same torrent (API resets it to pending)
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('removed');
    const j2 = addJob(s.db, u2, t, d);
    s.db.prepare("UPDATE torrents SET state = 'pending' WHERE id = ?").run(t);
    const addedBefore = s.dl.added.length;
    await s.worker.tick(); await s.worker.idle();
    await s.worker.tick(); await s.worker.idle();
    expect(s.dl.added.length).toBe(addedBefore); // not downloaded again
    expect(job(s.db, j2).state).toBe('completed');
    expect(files(s.db, j2)).toEqual(files(s.db, j1));
    expect(readFileSync(join(s.config.downloadsDir, 'library', 'bob-2', 'Pack [aaaaaaaa]', 'd/b.txt'), 'utf8')).toBe('B');
    expect(existsSync(lib1)).toBe(true); // alice's files untouched (copy, not move)
  });

  it('a job that arrives while the first one is moving does not find the data gone', async () => {
    const s = setup({ maxUploads: 2 });
    const u1 = addUser(s.db, 'alice');
    const u2 = addUser(s.db, 'bob');
    const d = addDest(s.db, { type: 'local' });
    const t = addTorrent(s.db, H1);
    const j1 = addJob(s.db, u1, t, d);
    writeFiles(join(s.content(H1), 'Pack'), { 'a.txt': 'A' });
    await s.worker.tick();
    s.complete(H1, 'Pack', 1, join(s.content(H1), 'Pack'));
    // job 2 appears right when job 1 is about to start its upload
    await s.worker.tick();
    const j2 = addJob(s.db, u2, t, d);
    await s.worker.idle();
    await s.worker.tick(); await s.worker.idle();
    await s.worker.tick(); await s.worker.idle();
    expect(job(s.db, j1).state).toBe('completed');
    expect(job(s.db, j2).state).toBe('completed');
    expect(existsSync(join(s.config.downloadsDir, 'library', 'bob-2', 'Pack [aaaaaaaa]', 'a.txt'))).toBe(true);
  });

  it('a job whose data already sits at its own target (library_path = target) is not copied onto itself', async () => {
    const s = setup();
    const u = addUser(s.db, 'alice');
    const t = addTorrent(s.db, H1);
    const j = addJob(s.db, u, t, addDest(s.db, { type: 'local' }));
    const dir = join(s.config.downloadsDir, 'library', 'alice-1', 'Pack [aaaaaaaa]');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'big.bin'), Buffer.alloc(2 * 1024 * 1024, 7)); // >= 1 MiB: would take the truncating stream branch
    s.db.prepare("UPDATE torrents SET state = 'downloaded', name = 'Pack', library_path = ? WHERE id = ?").run(dir, t);
    s.db.prepare("UPDATE jobs SET state = 'uploading' WHERE id = ?").run(j);
    await s.worker.tick(); await s.worker.idle();
    expect(job(s.db, j).state).toBe('completed');
    expect(files(s.db, j)).toEqual([{ path: 'big.bin', size: 2 * 1024 * 1024 }]);
    expect(readFileSync(join(dir, 'big.bin')).length).toBe(2 * 1024 * 1024);
  });

  it('a crash mid-copy (staging dir left, source gone) is NOT treated as delivered', async () => {
    const s = setup();
    const u = addUser(s.db, 'alice');
    const t = addTorrent(s.db, H1);
    const j = addJob(s.db, u, t, addDest(s.db, { type: 'local' }));
    writeFiles(join(s.config.downloadsDir, 'library', '.staging', String(j), 'item'), { 'half.bin': 'partial' });
    s.db.prepare("UPDATE torrents SET state = 'downloaded', name = 'Pack' WHERE id = ?").run(t);
    s.db.prepare("UPDATE jobs SET state = 'uploading' WHERE id = ?").run(j);
    await s.worker.tick(); await s.worker.idle();
    expect(job(s.db, j).state).toBe('failed');
    expect(existsSync(join(s.config.downloadsDir, 'library', '.staging', String(j)))).toBe(false);
    expect(existsSync(join(s.config.downloadsDir, 'library', 'alice-1'))).toBe(false);
  });

  it('copy lands atomically: nothing at the target until complete, staging removed afterwards', async () => {
    const s = setup();
    setSetting(s.db, 'seeding.ratio', 1); // force copy
    const u = addUser(s.db, 'alice');
    const t = addTorrent(s.db, H1);
    const j = addJob(s.db, u, t, addDest(s.db, { type: 'local' }));
    writeFiles(join(s.content(H1), 'Pack'), { 'a.txt': 'A', 'd/b.txt': 'B' });
    await s.worker.tick();
    s.complete(H1, 'Pack', 2, join(s.content(H1), 'Pack'));
    await s.worker.tick(); await s.worker.idle();
    expect(job(s.db, j).state).toBe('completed');
    expect(readFileSync(join(s.config.downloadsDir, 'library', 'alice-1', 'Pack [aaaaaaaa]', 'd/b.txt'), 'utf8')).toBe('B');
    expect(existsSync(join(s.config.downloadsDir, 'library', '.staging', String(j)))).toBe(false);
  });

  it('cancelling a running local copy aborts it and removes the partial target', async () => {
    const s = setup({ maxUploads: 2 });
    setSetting(s.db, 'seeding.ratio', 1); // force copy
    const u = addUser(s.db, 'alice');
    const t = addTorrent(s.db, H1);
    const j = addJob(s.db, u, t, addDest(s.db, { type: 'local' }));
    const big = Buffer.alloc(40 * 1024 * 1024, 1);
    mkdirSync(join(s.content(H1), 'Pack'), { recursive: true });
    for (let i = 0; i < 4; i++) writeFileSync(join(s.content(H1), 'Pack', `f${i}.bin`), big);
    await s.worker.tick();
    s.complete(H1, 'Pack', big.length * 4, join(s.content(H1), 'Pack'));
    await s.worker.tick(); // upload starts
    s.db.prepare("UPDATE jobs SET state = 'cancelled' WHERE id = ?").run(j);
    await s.worker.tick(); await s.worker.idle();
    expect(job(s.db, j).state).toBe('cancelled');
    expect(existsSync(join(s.config.downloadsDir, 'library', 'alice-1', 'Pack [aaaaaaaa]'))).toBe(false);
  });
});

describe('source resolution hardening', () => {
  it('rejects a torrent name that escapes incomplete/<infohash>', async () => {
    const s = setup();
    const u = addUser(s.db, 'alice');
    const t = addTorrent(s.db, H1);
    const j = addJob(s.db, u, t, addDest(s.db, { type: 'local' }));
    writeFiles(join(s.config.downloadsDir, 'library'), { 'secret.txt': 'x' });
    s.db.prepare("UPDATE torrents SET state = 'downloaded', name = ?, save_path = ? WHERE id = ?").run('../../library', join(s.content(H1)), t);
    s.db.prepare("UPDATE jobs SET state = 'uploading' WHERE id = ?").run(j);
    await s.worker.tick(); await s.worker.idle();
    expect(job(s.db, j).state).toBe('failed');
    expect(job(s.db, j).error).toMatch(/not found/);
    expect(existsSync(join(s.config.downloadsDir, 'library', 'secret.txt'))).toBe(true);
  });
});

describe('rclone destinations: Drive folders and SSRF guard', () => {
  const gdrive = { type: 'gdrive', clientId: 'cid', clientSecret: 'super-secret-value-xyz', refreshToken: '1//refresh-token-value-123456', rootFolderId: 'ROOT', sharing: 'anyone' } as const;

  it('two concurrent uploads for one user create the user folder once and each job folder once (mutex)', async () => {
    const folders = new Map<string, string>();
    let creates = 0;
    const ensure = async (_c: unknown, _g: unknown, root: string, segs: string[]): Promise<string> => {
      let id = root;
      for (const sg of segs) {
        const key = `${id}/${sg}`;
        if (!folders.has(key)) { await new Promise((r) => setTimeout(r, 15)); if (!folders.has(key)) { creates++; folders.set(key, key); } }
        id = folders.get(key)!;
      }
      return id;
    };
    const fs_ = fakeSpawn();
    const s = setup({ spawn: fs_.spawn, maxUploads: 2, gdrive: { ensureFolderPath: ensure, shareFolder: async () => undefined } });
    const u = addUser(s.db, 'alice');
    const d = addDest(s.db, gdrive);
    for (const h of [H1, H2]) {
      const t = addTorrent(s.db, h);
      addJob(s.db, u, t, d);
      writeFiles(join(s.content(h), 'Pack'), { 'a.txt': 'A' });
    }
    await s.worker.tick();
    for (const h of [H1, H2]) s.complete(h, 'Pack', 1, join(s.content(h), 'Pack'));
    await s.worker.tick();
    await new Promise((r) => setTimeout(r, 150));
    expect(fs_.procs).toHaveLength(2);
    expect(creates).toBe(3); // alice-1 once + two job folders
    expect(fs_.calls.map((c) => c.args[2])).toEqual(['DST:', 'DST:']);
    expect(fs_.calls.map((c) => c.env.RCLONE_CONFIG_DST_ROOT_FOLDER_ID).sort()).toEqual(['ROOT/alice-1/Pack [aaaaaaaa]', 'ROOT/alice-1/Pack [bbbbbbbb]']);
    for (const p of fs_.procs) p.finish(0);
    await s.worker.idle();
  });

  it('user-owned gdrive: rclone targets the job folder directly under the destination root', async () => {
    const fs_ = fakeSpawn((_c, _a, _e, p) => p.finish(0));
    const s = setup({ spawn: fs_.spawn, gdrive: { ensureFolderPath: async (_c, _g, root, segs) => [root, ...segs].join('/'), shareFolder: async () => undefined } });
    const u = addUser(s.db, 'alice');
    const t = addTorrent(s.db, H1);
    const j = addJob(s.db, u, t, addDest(s.db, gdrive, u));
    writeFiles(join(s.content(H1), 'Pack'), { 'a.txt': 'A' });
    await s.worker.tick();
    s.complete(H1, 'Pack', 1, join(s.content(H1), 'Pack'));
    await s.worker.tick(); await s.worker.idle();
    expect(job(s.db, j)).toMatchObject({ state: 'completed', folder_url: 'https://drive.google.com/drive/folders/ROOT/Pack [aaaaaaaa]' });
  });

  const s3 = { type: 's3', endpoint: 'http://169.254.169.254', region: 'r', accessKeyId: 'AKIAEXAMPLE0000', secretAccessKey: 's3-secret-key', bucket: 'b' } as const;
  async function s3Upload(owner: 'user' | 'shared', guard: WorkerDeps['endpointGuard']) {
    const fs_ = fakeSpawn((_c, _a, _e, p) => p.finish(0));
    const calls: [string, boolean][] = [];
    const s = setup({ spawn: fs_.spawn, endpointGuard: async (url, o) => { calls.push([url, o.allowPrivate]); await guard!(url, o); } });
    const u = addUser(s.db, 'alice');
    const t = addTorrent(s.db, H1);
    const j = addJob(s.db, u, t, addDest(s.db, s3, owner === 'user' ? u : null));
    writeFiles(join(s.content(H1), 'Pack'), { 'a.txt': 'A' });
    await s.worker.tick();
    s.complete(H1, 'Pack', 1, join(s.content(H1), 'Pack'));
    await s.worker.tick(); await s.worker.idle();
    return { s, j, calls, spawned: fs_.calls.length };
  }

  it('user-owned S3 endpoints go through the guard with allowPrivate=false; a rejection fails the job without running rclone', async () => {
    const r = await s3Upload('user', async () => { throw new Error('Endpoint resolves to a private address'); });
    expect(r.calls).toEqual([['http://169.254.169.254', false]]);
    expect(job(r.s.db, r.j)).toMatchObject({ state: 'failed' });
    expect(job(r.s.db, r.j).error).toMatch(/private address/);
    expect(r.spawned).toBe(0);
  });

  it('shared (admin) S3 destinations are guarded with allowPrivate=true', async () => {
    const r = await s3Upload('shared', async () => undefined);
    expect(r.calls).toEqual([['http://169.254.169.254', true]]);
    expect(job(r.s.db, r.j).state).toBe('completed');
  });
});

describe('worker start', () => {
  it('retries the first VPN reconcile soon when the sidecar is not up yet', async () => {
    const env = makeEnv();
    const vpn = new FakeVpn();
    vpn.fail = true;
    setSetting(env.db, 'vpn.mode', 'off');
    const w = new Worker({ db: env.db, config: env.config, downloader: new FakeDownloader(), vpn, log: silent, vpnEveryMs: 15_000, tickMs: 5 });
    w.start();
    await w.idle();
    vpn.fail = false;
    vpn.status_ = { ...vpn.status_, mode: 'required' };
    await new Promise((r) => setTimeout(r, 3300));
    await w.idle();
    await w.stop();
    expect(vpn.modes).toEqual(['off']);
    expect(now()).toBeGreaterThan(0);
  });
});
