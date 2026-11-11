/**
 * Symlink-safe filesystem helpers for the worker.
 *
 * qBittorrent runs in a separate (compromised-by-assumption) container and owns `incomplete/`: it can plant symlinks,
 * FIFOs, sockets and hardlinks anywhere in a torrent's directory. The worker, which sees the whole downloads volume and
 * `/data`, must never follow such an entry into a user's library. Rules:
 *  - the content root is resolved with realpath and must be a real directory inside the real `incomplete/<infohash>`;
 *  - every entry is lstat'ed; only regular files and directories are delivered, everything else is skipped;
 *  - regular files with nlink > 1 are skipped too (a hardlink may be another file's second name);
 *  - files are opened with O_NOFOLLOW (+ O_NONBLOCK so a FIFO cannot block) and the opened descriptor is checked
 *    (regular, nlink 1, and its real path is exactly the vetted path: no intermediate directory was swapped for a link).
 */
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, mkdir, open, readdir, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';

export interface SourceFile { path: string; size: number }
export interface VettedTree { isDir: boolean; files: SourceFile[]; dirs: string[]; skipped: string[] }

export class UnsafeSourceError extends Error {}

const isInside = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * realpath(candidate), if it is `root` or lies inside it; null otherwise. `root` itself must be a real directory (not a
 * link) whose real path is `<real parent>/<its name>`: a symlinked `incomplete/<infohash>` would otherwise make every
 * target "inside" the root.
 */
export async function realInside(candidate: string, root: string): Promise<string | null> {
  try {
    const rl = await lstat(root);
    if (!rl.isDirectory() || rl.isSymbolicLink()) return null;
    const realRoot = await realpath(root);
    if (realRoot !== join(await realpath(dirname(root)), basename(root))) return null;
    const rc = await realpath(candidate);
    return isInside(rc, realRoot) ? rc : null;
  } catch { return null; }
}

/** Like realInside for an existing real-or-plain path under a root that may legitimately be reached through links (the library). */
export async function realInsideLoose(candidate: string, root: string): Promise<string | null> {
  try {
    const realRoot = await realpath(root);
    const rc = await realpath(candidate);
    return rc !== realRoot && isInside(rc, realRoot) ? rc : null;
  } catch { return null; }
}

/**
 * List what may be delivered under `src` (a REAL path: callers resolve it first). Regular files and directories only;
 * `skipped` collects every symlink, socket, FIFO, device and hardlinked file (relative paths, '/'-separated).
 */
export async function vetTree(src: string, opts: { allowHardlinks?: boolean } = {}): Promise<VettedTree> {
  const top = await lstat(src);
  if (top.isSymbolicLink()) throw new UnsafeSourceError('The content path is a symbolic link');
  if (top.isFile()) {
    if (top.nlink > 1 && !opts.allowHardlinks) throw new UnsafeSourceError('The content file has several hard links');
    return { isDir: false, files: [{ path: basename(src), size: top.size }], dirs: [], skipped: [] };
  }
  if (!top.isDirectory()) throw new UnsafeSourceError('The content path is not a regular file or directory');
  const files: SourceFile[] = [];
  const dirs: string[] = [];
  const skipped: string[] = [];
  const rec = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      const rel = relative(src, p).split(sep).join('/');
      const st = await lstat(p).catch(() => null);
      if (!st) continue;
      if (st.isSymbolicLink()) skipped.push(rel);
      else if (st.isDirectory()) { dirs.push(rel); await rec(p); }
      else if (st.isFile()) {
        if (st.nlink > 1 && !opts.allowHardlinks) skipped.push(rel);
        else files.push({ path: rel, size: st.size });
      } else skipped.push(rel);
    }
  };
  await rec(src);
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  dirs.sort();
  return { isDir: true, files, dirs, skipped };
}

/**
 * Open `path` for reading without following links and prove the descriptor is the vetted regular file. `path` must be a
 * REAL path built from a real root (see vetTree): the descriptor's real path has to be exactly that, so an intermediate
 * directory swapped for a link after vetting is detected.
 */
export async function openVetted(path: string, opts: { allowHardlinks?: boolean } = {}): Promise<FileHandle> {
  const expected = path;
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new UnsafeSourceError('Not a regular file');
    if (st.nlink > 1 && !opts.allowHardlinks) throw new UnsafeSourceError('Hard-linked file');
    const actual = await readlink(`/proc/self/fd/${fh.fd}`).catch(() => null);
    if (actual !== null && actual !== expected) throw new UnsafeSourceError('The file moved while it was being opened');
    if (actual === null && (await realpath(path)) !== expected) throw new UnsafeSourceError('The file moved while it was being opened');
    return fh;
  } catch (e) { await fh.close().catch(() => undefined); throw e; }
}

/** Create `dir` (and parents) refusing a symbolic link anywhere in the part below `base`. */
export async function mkdirPlain(base: string, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const rel = relative(base, dir);
  let cur = base;
  for (const part of rel.split(sep).filter(Boolean)) {
    cur = join(cur, part);
    if ((await lstat(cur)).isSymbolicLink()) throw new UnsafeSourceError('A symbolic link appeared in the delivery path');
  }
}
