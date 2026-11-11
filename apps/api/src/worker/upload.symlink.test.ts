import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setSetting } from '../lib/settings.js';
import { Worker, type WorkerDeps } from './loop.js';
import { openVetted, realInside, vetTree } from './safefs.js';
import { addDest, addJob, addTorrent, addUser, fakeSpawn, FakeDownloader, FakeVpn, files, job, makeEnv, silent, torrent, writeFiles } from './testkit.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const H1 = 'a'.repeat(40);
const SECRET = 'TOP-SECRET-OTHER-USERS-FILE-OR-DB';

function setup(extra: Partial<WorkerDeps> = {}) {
  const env = makeEnv();
  const dl = new FakeDownloader();
  const worker = new Worker({ db: env.db, config: env.config, downloader: dl, vpn: new FakeVpn(), log: silent, vpnEveryMs: 1e9, ...extra });
  const content = (hash: string) => join(env.config.downloadsDir, 'incomplete', hash);
  const outside = join(env.dir, 'outside'); // stands in for /data/*.db or another user's library files
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.db'), SECRET);
  mkdirSync(join(outside, 'dir'), { recursive: true });
  writeFileSync(join(outside, 'dir', 'inner.txt'), SECRET);
  return { ...env, dl, worker, content, outside };
}
type S = ReturnType<typeof setup>;

async function deliver(s: S, name: string, opts: { copy?: boolean } = {}) {
  const u = addUser(s.db, 'alice');
  const d = addDest(s.db, { type: 'local' }, null);
  const t = addTorrent(s.db, H1);
  const j = addJob(s.db, u, t, d);
  if (opts.copy) setSetting(s.db, 'seeding.ratio', 1); // forces copy instead of move
  await s.worker.tick();
  s.dl.set(H1, { state: 'completed', name, totalSize: 10, progress: 1, contentPath: join(s.content(H1), name), savePath: s.content(H1) });
  await s.worker.tick(); await s.worker.idle();
  return { t, j };
}

/** Every regular file under `dir` (following nothing), as relative paths. */
function tree(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? tree(p, base) : [p.slice(base.length + 1) + (e.isSymbolicLink() ? ' (symlink)' : '')];
  });
}
const noSecretInLibrary = (s: S) => {
  const lib = join(s.config.downloadsDir, 'library');
  for (const f of tree(lib)) {
    expect(f).not.toContain('(symlink)');
    expect(readFileSync(join(lib, f.replace(' (symlink)', '')), 'utf8')).not.toContain(SECRET);
  }
};

describe.each([['move (rename fast path)', false], ['copy', true]])('planted entries in incomplete/ are never delivered: %s', (_n, copy) => {
  it('top-level content path is a symlink to a directory outside: nothing is delivered', async () => {
    const s = setup();
    mkdirSync(s.content(H1), { recursive: true });
    symlinkSync(s.outside, join(s.content(H1), 'Pack'));
    const { j } = await deliver(s, 'Pack', { copy });
    expect(job(s.db, j).state).toBe('failed');
    expect(job(s.db, j).error).toMatch(/not found/);
    noSecretInLibrary(s);
    expect(tree(join(s.config.downloadsDir, 'library'))).toEqual([]);
    expect(readFileSync(join(s.outside, 'secret.db'), 'utf8')).toBe(SECRET); // untouched, not moved away
  });

  it('top-level content path is a symlink to a single file outside: nothing is delivered', async () => {
    const s = setup();
    mkdirSync(s.content(H1), { recursive: true });
    symlinkSync(join(s.outside, 'secret.db'), join(s.content(H1), 'x.bin'));
    const { j } = await deliver(s, 'x.bin', { copy });
    expect(job(s.db, j).state).toBe('failed');
    noSecretInLibrary(s);
    expect(existsSync(join(s.outside, 'secret.db'))).toBe(true);
  });

  it('nested symlinks (to a file, to a directory, dangling, relative) are skipped; regular files are delivered', async () => {
    const s = setup();
    writeFiles(join(s.content(H1), 'Pack'), { 'ok.txt': 'fine', 'sub/ok2.txt': 'fine2' });
    symlinkSync(join(s.outside, 'secret.db'), join(s.content(H1), 'Pack', 'leak.db'));
    symlinkSync(s.outside, join(s.content(H1), 'Pack', 'dirlink'));
    symlinkSync(join(s.outside, 'dir', 'inner.txt'), join(s.content(H1), 'Pack', 'sub', 'leak2'));
    symlinkSync('../../../../outside/secret.db', join(s.content(H1), 'Pack', 'rel'));
    symlinkSync(join(s.outside, 'nope'), join(s.content(H1), 'Pack', 'dangling'));
    const { j } = await deliver(s, 'Pack', { copy });
    expect(job(s.db, j).state).toBe('completed');
    expect(files(s.db, j).map((f) => f.path)).toEqual(['ok.txt', 'sub/ok2.txt']);
    const lib = join(s.config.downloadsDir, 'library', 'alice-1', 'Pack [aaaaaaaa]');
    expect(tree(lib).sort()).toEqual(['ok.txt', 'sub/ok2.txt']);
    noSecretInLibrary(s);
  });

  it('a FIFO is skipped (and does not block the worker); hardlinked files are skipped', async () => {
    const s = setup();
    writeFiles(join(s.content(H1), 'Pack'), { 'ok.txt': 'fine' });
    execFileSync('mkfifo', [join(s.content(H1), 'Pack', 'pipe')]);
    linkSync(join(s.outside, 'secret.db'), join(s.content(H1), 'Pack', 'hard.db')); // same filesystem: nlink = 2
    const { j } = await deliver(s, 'Pack', { copy });
    expect(job(s.db, j).state).toBe('completed');
    expect(files(s.db, j).map((f) => f.path)).toEqual(['ok.txt']);
    const lib = join(s.config.downloadsDir, 'library', 'alice-1', 'Pack [aaaaaaaa]');
    expect(tree(lib)).toEqual(['ok.txt']);
    noSecretInLibrary(s);
  });

  it('a symlink to ANOTHER torrent\'s incomplete dir is refused too', async () => {
    const s = setup();
    const other = s.content('b'.repeat(40));
    writeFiles(other, { 'private.txt': SECRET });
    mkdirSync(s.content(H1), { recursive: true });
    symlinkSync(other, join(s.content(H1), 'Pack'));
    const { j } = await deliver(s, 'Pack', { copy });
    expect(job(s.db, j).state).toBe('failed');
    noSecretInLibrary(s);
  });
});

describe('a symlink planted between vetting and the move is dropped (the content is re-vetted in the worker-only staging dir)', () => {
  it('rename path: entries added after vetting never reach the library', async () => {
    const s = setup();
    writeFiles(join(s.content(H1), 'Pack'), { 'ok.txt': 'fine' });
    const orig = s.dl.status.bind(s.dl);
    // the "attacker" plants a link right after the worker looked at the tree (status() is called while resolving the source)
    s.dl.status = async (ref: string) => {
      const r = await orig(ref);
      const link = join(s.content(H1), 'Pack', 'late-leak');
      if (r && !existsSync(link)) { try { symlinkSync(join(s.outside, 'secret.db'), link); } catch { /* exists */ } }
      return r;
    };
    const { j } = await deliver(s, 'Pack');
    expect(job(s.db, j).state).toBe('completed');
    noSecretInLibrary(s);
    expect(tree(join(s.config.downloadsDir, 'library', 'alice-1', 'Pack [aaaaaaaa]'))).toEqual(['ok.txt']);
  });
});

describe('remote destinations get exactly the vetted file list', () => {
  it('rclone is started with --files-from-raw listing only regular files', async () => {
    let listed = '';
    let args: string[] = [];
    const fs_ = fakeSpawn((_c, a, _e, p) => {
      args = a;
      const i = a.indexOf('--files-from-raw');
      if (i >= 0) listed = readFileSync(a[i + 1]!, 'utf8');
      p.finish(0);
    });
    const s = setup({ spawn: fs_.spawn });
    writeFiles(join(s.content(H1), 'Pack'), { 'ok.txt': 'fine', 'sub/two.txt': 'x' });
    symlinkSync(join(s.outside, 'secret.db'), join(s.content(H1), 'Pack', 'leak.db'));
    execFileSync('mkfifo', [join(s.content(H1), 'Pack', 'pipe')]);
    const u = addUser(s.db, 'alice');
    const d = addDest(s.db, { type: 's3', endpoint: 'https://s3.example.test', region: 'r', accessKeyId: 'k', secretAccessKey: 's', bucket: 'b', forcePathStyle: true }, null);
    const t = addTorrent(s.db, H1);
    const j = addJob(s.db, u, t, d);
    await s.worker.tick();
    s.dl.set(H1, { state: 'completed', name: 'Pack', totalSize: 10, progress: 1, contentPath: join(s.content(H1), 'Pack'), savePath: s.content(H1) });
    await s.worker.tick(); await s.worker.idle();
    expect(args[0]).toBe('copy');
    expect(listed.trim().split('\n').sort()).toEqual(['ok.txt', 'sub/two.txt']);
    expect(files(s.db, j).map((f) => f.path)).toEqual(['ok.txt', 'sub/two.txt']);
    expect(job(s.db, j).state).toBe('completed');
    expect(torrent(s.db, t).state).toBeDefined();
  });

  it('a symlinked content root is refused before rclone is started', async () => {
    const fs_ = fakeSpawn((_c, _a, _e, p) => p.finish(0));
    const s = setup({ spawn: fs_.spawn });
    mkdirSync(s.content(H1), { recursive: true });
    symlinkSync(s.outside, join(s.content(H1), 'Pack'));
    const u = addUser(s.db, 'alice');
    const d = addDest(s.db, { type: 's3', endpoint: 'https://s3.example.test', region: 'r', accessKeyId: 'k', secretAccessKey: 's', bucket: 'b', forcePathStyle: true }, null);
    const t = addTorrent(s.db, H1);
    const j = addJob(s.db, u, t, d);
    await s.worker.tick();
    s.dl.set(H1, { state: 'completed', name: 'Pack', totalSize: 10, progress: 1, contentPath: join(s.content(H1), 'Pack'), savePath: s.content(H1) });
    await s.worker.tick(); await s.worker.idle();
    expect(job(s.db, j).state).toBe('failed');
    expect(fs_.calls).toHaveLength(0);
  });
});

describe('safefs primitives', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'safefs-'));

  it('realInside refuses a symlinked root and anything resolving outside', async () => {
    const d = tmp();
    mkdirSync(join(d, 'real'));
    writeFileSync(join(d, 'real', 'f'), 'x');
    symlinkSync(join(d, 'real'), join(d, 'incomplete-link'));
    expect(await realInside(join(d, 'real', 'f'), join(d, 'real'))).toBe(join(readlinkSyncSafe(d), 'real', 'f'));
    expect(await realInside(join(d, 'incomplete-link', 'f'), join(d, 'incomplete-link'))).toBeNull(); // root itself is a link
    expect(await realInside(join(d, 'real', '..', 'x'), join(d, 'real'))).toBeNull();
    rmSync(d, { recursive: true, force: true });
  });

  it('openVetted refuses symlinks, FIFOs and hardlinked files, accepts a plain file', async () => {
    const d = tmp();
    const real = join(await (await import('node:fs/promises')).realpath(d));
    writeFileSync(join(real, 'f'), 'hello');
    symlinkSync(join(real, 'f'), join(real, 'l'));
    execFileSync('mkfifo', [join(real, 'p')]);
    writeFileSync(join(real, 'h1'), 'x');
    linkSync(join(real, 'h1'), join(real, 'h2'));
    const fh = await openVetted(join(real, 'f'));
    expect((await fh.readFile()).toString()).toBe('hello');
    await fh.close();
    await expect(openVetted(join(real, 'l'))).rejects.toThrow();
    await expect(openVetted(join(real, 'p'))).rejects.toThrow();
    await expect(openVetted(join(real, 'h1'))).rejects.toThrow(/Hard-linked/);
    await expect(openVetted(join(real, 'h1'), { allowHardlinks: true })).resolves.toBeDefined();
    rmSync(real, { recursive: true, force: true });
  });

  it('openVetted detects a directory swapped for a link after vetting', async () => {
    const d = await (await import('node:fs/promises')).realpath(tmp());
    mkdirSync(join(d, 'Pack'));
    writeFileSync(join(d, 'Pack', 'f'), 'mine');
    mkdirSync(join(d, 'evil'));
    writeFileSync(join(d, 'evil', 'f'), SECRET);
    const vetted = join(d, 'Pack', 'f'); // vetted as a plain file ...
    rmSync(join(d, 'Pack'), { recursive: true });
    symlinkSync(join(d, 'evil'), join(d, 'Pack')); // ... then the directory is swapped for a link
    await expect(openVetted(vetted)).rejects.toThrow(/moved while/);
    rmSync(d, { recursive: true, force: true });
  });

  it('vetTree lists regular files and directories only', async () => {
    const d = await (await import('node:fs/promises')).realpath(tmp());
    writeFiles(d, { 'a.txt': 'a', 'sub/b.txt': 'b' });
    mkdirSync(join(d, 'empty'));
    symlinkSync(join(d, 'a.txt'), join(d, 'ln'));
    execFileSync('mkfifo', [join(d, 'fifo')]);
    const v = await vetTree(d);
    expect(v.files.map((f) => f.path)).toEqual(['a.txt', 'sub/b.txt']);
    expect(v.dirs.sort()).toEqual(['empty', 'sub']);
    expect(v.skipped.sort()).toEqual(['fifo', 'ln']);
    expect(readlinkSync(join(d, 'ln'))).toBe(join(d, 'a.txt')); // untouched
    rmSync(d, { recursive: true, force: true });
  });
});

function readlinkSyncSafe(p: string): string { return execFileSync('sh', ['-c', `cd "${p}" && pwd -P`]).toString().trim(); }
