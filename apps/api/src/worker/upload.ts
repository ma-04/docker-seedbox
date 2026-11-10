/** Deliver a downloaded torrent's files to a job's destination (rclone for gdrive/s3, filesystem for local). */
import type { Logger } from 'pino';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Config } from '../lib/config.js';
import type { Db } from '../lib/db.js';
import { fullRemotePath, getDestination, jobRemoteDir } from '../lib/destinations.js';
import * as gdriveLib from '../lib/gdrive.js';
import { getSetting } from '../lib/settings.js';
import { now, type DestinationConfig, type GDriveConfig, type JobRow, type TorrentRow, type UserRow } from '../lib/types.js';
import type { Downloader } from '../downloaders/types.js';
import { assertPublicEndpoint } from '../lib/netguard.js';
import { buildRcloneCommand, redact, runRclone, RcloneAborted, RcloneError, S3_AUTH_ERROR, s3ProbeCommand, type RcloneCommand, type RcloneProc, type SpawnFn } from './rclone.js';


/** SSRF guard called right before every S3 upload (same call shape as `assertPublicEndpoint`). */
export type EndpointGuard = (url: string, opts: { allowPrivate: boolean }) => Promise<unknown>;

/** rclone treats a scheme-less endpoint as https, so check it as https. */
export const defaultEndpointGuard: EndpointGuard = (url, opts) =>
  assertPublicEndpoint(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`, opts);

export interface GDriveOps {
  ensureFolderPath: typeof gdriveLib.ensureFolderPath;
  shareFolder: typeof gdriveLib.shareFolder;
}
export const realGDrive: GDriveOps = { ensureFolderPath: gdriveLib.ensureFolderPath, shareFolder: gdriveLib.shareFolder };

export interface UploadDeps {
  db: Db;
  config: Config;
  downloader: Downloader;
  spawn: SpawnFn;
  rcloneBin: string;
  log: Logger;
  gdrive: GDriveOps;
  /** SSRF guard for S3 endpoints; user-owned destinations are checked with allowPrivate=false. */
  endpointGuard?: EndpointGuard;
  /** rclone abort/stall tuning (tests). */
  killGraceMs?: number;
  stallMs?: number;
  /** Lets the owner of the upload kill rclone on shutdown. */
  onProc?: (jobId: number, proc: RcloneProc) => void;
}

export interface SourceFile { path: string; size: number }

/** Recursively list files under `root` (or the single file itself) as '/'-separated paths relative to it. */
export async function walkSource(src: string): Promise<{ isDir: boolean; files: SourceFile[] }> {
  const st = await stat(src);
  if (!st.isDirectory()) return { isDir: false, files: [{ path: basename(src), size: st.size }] };
  const files: SourceFile[] = [];
  const rec = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await rec(p);
      else if (e.isFile()) files.push({ path: relative(src, p).split(sep).join('/'), size: (await stat(p)).size });
    }
  };
  await rec(src);
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { isDir: true, files };
}

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

/**
 * Where the torrent's content lives on disk. Every candidate must stay inside `incomplete/<infohash>` (a hostile
 * torrent name such as `../../library` must not make the worker upload or move something else); the library copy
 * recorded by an earlier local job that moved the data is the last resort.
 */
async function resolveSource(deps: UploadDeps, torrent: TorrentRow): Promise<string> {
  const st = await deps.downloader.status(torrent.infohash).catch(() => null);
  const root = resolve(deps.config.downloadsDir, 'incomplete', torrent.infohash);
  const inside = (p: string): boolean => { const r = resolve(p); return r === root || r.startsWith(root + sep); };
  const candidates = [
    st?.contentPath,
    join(torrent.save_path ?? root, torrent.name ?? ''),
  ].filter((p): p is string => !!p && p !== '' && inside(p));
  for (const c of candidates) if (await exists(c)) return c;
  const lib = resolve(deps.config.downloadsDir, 'library');
  if (torrent.library_path && resolve(torrent.library_path).startsWith(lib + sep) && (await exists(torrent.library_path))) return torrent.library_path;
  throw new Error('Downloaded files not found on disk');
}

/** Torrent id -> a local move in progress. Later jobs for the same torrent wait for it, then copy from the library. */
const moving = new Map<number, Promise<void>>();

/** Per destination+user critical section for creating Drive folders (in-process; the worker is the only writer). */
const folderLocks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = folderLocks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  folderLocks.set(key, tail);
  try { return await run; } finally { if (folderLocks.get(key) === tail) folderLocks.delete(key); }
}

/**
 * After a failed S3 copy: ask the bucket root a plain question with the same credentials. If the server rejects
 * them, report that instead of rclone's copy-time message (which can be unrelated, e.g. "is a file not a directory").
 */
async function explainS3Failure(deps: UploadDeps, cfg: { bucket: string }, cmd: RcloneCommand, original: string, secrets: string[], signal: AbortSignal): Promise<string> {
  if (signal.aborted) return original;
  try {
    await runRclone({ spawn: deps.spawn, bin: deps.rcloneBin, cmd: s3ProbeCommand(cmd, cfg.bucket), signal, killGraceMs: deps.killGraceMs, stallMs: 20_000, onStats: () => undefined });
    return original;
  } catch (e) {
    const probe = redact(e instanceof Error ? e.message : String(e), secrets);
    if (S3_AUTH_ERROR.test(probe)) {
      return `The S3 server rejected the credentials (wrong access key or secret key, or no permission on the bucket). Check the destination settings. Detail: ${probe.replace(/^rclone failed \([^)]*\):?\s*/, '').slice(0, 300)}`;
    }
    return original;
  }
}

function failJob(deps: UploadDeps, jobId: number, message: string): void {
  deps.db.prepare("UPDATE jobs SET state = 'failed', error = ?, upload_speed = 0, updated_at = ? WHERE id = ? AND state = 'uploading'")
    .run(message.slice(0, 800), now(), jobId);
}

/** Run one job's upload to completion. Never throws; outcomes are written to the DB. */
export async function runUpload(deps: UploadDeps, jobId: number, signal: AbortSignal): Promise<void> {
  const { db, log } = deps;
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
  if (!job || job.state !== 'uploading') return;
  let secrets: string[] = [];
  let s3Config: Extract<DestinationConfig, { type: 's3' }> | undefined;
  let cmdForProbe: RcloneCommand | undefined;
  try {
    const torrent = db.prepare('SELECT * FROM torrents WHERE id = ?').get(job.torrent_id) as TorrentRow;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(job.user_id) as UserRow;
    const dest = getDestination(db, deps.config.appSecret, job.destination_id);
    if (!dest) throw new Error('Destination no longer exists');
    if (torrent.state !== 'downloaded') throw new Error('Downloaded data is no longer available');
    // A staging dir left by a crashed copy means "not delivered": discard it.
    if (dest.config.type === 'local') await rm(stagingDir(deps.config.downloadsDir, jobId), { recursive: true, force: true });
    await moving.get(torrent.id); // another local job is moving the data right now

    let source: string;
    let delivered = false;
    try {
      source = await resolveSource(deps, torrent);
    } catch (e) {
      // Crash recovery: a previous run may already have moved the files into the library (rename).
      const prior = dest.config.type === 'local' && torrent.name
        ? resolve(deps.config.downloadsDir, 'library', fullRemotePath(dest.config, jobRemoteDir(dest.row, user, torrent.infohash, torrent.name)))
        : null;
      if (!prior || !(await exists(prior))) throw e;
      source = prior;
      delivered = true;
    }
    const remotePath = jobRemoteDir(dest.row, user, torrent.infohash, torrent.name ?? basename(source));
    const userOwned = dest.row.owner_user_id !== null;
    const fromLibrary = !!torrent.library_path && resolve(source) === resolve(torrent.library_path);
    db.prepare('UPDATE jobs SET remote_path = ?, upload_progress = 0, upload_speed = 0, folder_url = NULL, error = NULL, updated_at = ? WHERE id = ?')
      .run(remotePath, now(), jobId);

    const { files } = await walkSource(source);
    let folderUrl: string | null = null;

    if (dest.config.type === 'local') {
      if (!delivered) await uploadLocal(deps, job, torrent, source, fullRemotePath(dest.config, remotePath), signal, fromLibrary);
    } else {
      let gdrive: { userFolder: string | null; jobFolder: string } | undefined;
      if (dest.config.type === 's3') {
        await (deps.endpointGuard ?? defaultEndpointGuard)(dest.config.endpoint, { allowPrivate: !userOwned });
      } else if (dest.config.type === 'gdrive') {
        gdrive = await resolveGDriveFolders(deps, dest.config, dest.row.id, userOwned, remotePath, user);
      }
      const cmd = buildRcloneCommand(dest.config, source, remotePath, { gdriveFolderId: gdrive?.jobFolder });
      secrets = cmd.secrets;
      cmdForProbe = cmd;
      if (dest.config.type === 's3') s3Config = dest.config;
      let last = 0;
      await runRclone({
        spawn: deps.spawn, bin: deps.rcloneBin, cmd, signal, killGraceMs: deps.killGraceMs, stallMs: deps.stallMs,
        onProc: (p) => deps.onProc?.(jobId, p),
        onStats: (s) => {
          const t = Date.now();
          if (t - last < 1000 || s.totalBytes <= 0) return;
          last = t;
          db.prepare("UPDATE jobs SET upload_progress = ?, upload_speed = ?, updated_at = ? WHERE id = ? AND state = 'uploading'")
            .run(Math.min(0.99, s.bytes / s.totalBytes), Math.round(s.speed), now(), jobId);
        },
      });
      if (dest.config.type === 'gdrive' && gdrive) folderUrl = await shareGDrive(deps, dest.config, userOwned, gdrive, user);
    }

    db.transaction(() => {
      const r = db.prepare(
        "UPDATE jobs SET state = 'completed', upload_progress = 1, upload_speed = 0, error = NULL, folder_url = ?, completed_at = ?, updated_at = ? WHERE id = ? AND state = 'uploading'",
      ).run(folderUrl, now(), now(), jobId);
      if (r.changes === 0) return; // cancelled meanwhile
      db.prepare('DELETE FROM job_files WHERE job_id = ?').run(jobId);
      const ins = db.prepare('INSERT INTO job_files (job_id, path, size) VALUES (?, ?, ?)');
      for (const f of files) ins.run(jobId, f.path, f.size);
    })();
    log.info({ jobId, files: files.length }, 'upload completed');
  } catch (err) {
    if (err instanceof RcloneAborted || signal.aborted) {
      log.info({ jobId }, 'upload aborted');
      return;
    }
    let msg = redact(err instanceof Error ? err.message : String(err), secrets);
    if (err instanceof RcloneError && s3Config && !S3_AUTH_ERROR.test(msg)) {
      msg = await explainS3Failure(deps, s3Config, cmdForProbe!, msg, secrets, signal);
    }
    log.warn({ jobId, err: msg }, 'upload failed');
    failJob(deps, jobId, msg);
  }
}

async function uploadLocal(deps: UploadDeps, job: JobRow, torrent: TorrentRow, source: string, relTarget: string, signal: AbortSignal, fromLibrary: boolean): Promise<void> {
  const { db, config } = deps;
  const root = resolve(config.downloadsDir, 'library');
  const target = resolve(root, relTarget);
  if (target === root || !target.startsWith(root + sep)) throw new Error('Refusing to write outside the library folder');
  const isDir = (await stat(source)).isDirectory();
  const dstPath = isDir ? target : join(target, basename(source)); // single files land inside <target>/
  if (signal.aborted) throw new RcloneAborted();
  // The data already sits exactly where this job wants it (crash after the rename, or the same user re-added the
  // same torrent): copying a file onto itself would truncate it.
  if (resolve(source) === dstPath) return;

  const targetExisted = await exists(target);
  const existed = await exists(dstPath);
  await mkdir(isDir ? dirname(target) : target, { recursive: true });

  // Move (rename) only when this job is the last one that needs the data and nothing seeds it. The decision is one
  // conditional UPDATE that also records where the data went, so a job added meanwhile copies from there instead of
  // finding the data gone.
  if (!fromLibrary && !existed && getSetting(db, 'seeding.ratio') <= 0) {
    let release!: () => void;
    moving.set(torrent.id, new Promise<void>((r) => { release = r; }));
    let moved = false;
    try {
      const claimed = db.prepare(
        `UPDATE torrents SET library_path = ? WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM jobs WHERE torrent_id = ? AND id != ? AND state IN ('queued','downloading','uploading'))`,
      ).run(dstPath, torrent.id, torrent.id, job.id).changes === 1;
      if (claimed) {
        try { await rename(source, dstPath); moved = true; return; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e; }
      }
    } finally {
      if (!moved) db.prepare('UPDATE torrents SET library_path = NULL WHERE id = ? AND library_path = ?').run(torrent.id, dstPath);
      moving.delete(torrent.id);
      release();
    }
  }

  // Copy into a staging dir on the same volume and rename into place only when everything is written, so a crash or
  // cancel can never leave a partial target that crash recovery would mistake for a delivered job.
  const staging = stagingDir(config.downloadsDir, job.id);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const staged = join(staging, 'item');
  try {
    await copyTree(source, staged, signal);
    if (signal.aborted) throw new RcloneAborted();
    if (existed) { // an earlier copy by the same user: swap it out, never merge
      await rename(dstPath, join(staging, 'old'));
    }
    await rename(staged, dstPath);
  } catch (e) {
    if (existed) await rename(join(staging, 'old'), dstPath).catch(() => undefined); // put the previous copy back
    if (!targetExisted) await rm(target, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const stagingDir = (downloadsDir: string, jobId: number): string => resolve(downloadsDir, 'library', '.staging', String(jobId));

/** Recursive copy that stops promptly when `signal` aborts (also in the middle of a large file). */
async function copyTree(src: string, dst: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new RcloneAborted();
  const st = await stat(src);
  if (st.isDirectory()) {
    await mkdir(dst, { recursive: true });
    for (const e of await readdir(src, { withFileTypes: true })) {
      if (e.isDirectory() || e.isFile()) await copyTree(join(src, e.name), join(dst, e.name), signal);
    }
    return;
  }
  try {
    if (st.size < 1024 * 1024) await copyFile(src, dst);
    else await pipeline(createReadStream(src), createWriteStream(dst), { signal });
  } catch (e) {
    if (signal.aborted) throw new RcloneAborted();
    throw e;
  }
}

/**
 * Create/resolve the per-user and job folders in Drive BEFORE rclone runs, under a per destination+user mutex, so rclone
 * never creates parents itself (two concurrent uploads for one user would otherwise create duplicate same-named folders).
 */
async function resolveGDriveFolders(deps: UploadDeps, cfg: GDriveConfig, destId: number, userOwned: boolean, remotePath: string, user: UserRow): Promise<{ userFolder: string | null; jobFolder: string }> {
  const creds = { clientId: cfg.clientId, clientSecret: cfg.clientSecret, refreshToken: cfg.refreshToken };
  const segs = remotePath.split('/');
  return withLock(`${destId}:${user.id}`, async () => {
    const userFolder = userOwned ? null : await deps.gdrive.ensureFolderPath(creds, deps.config.google, cfg.rootFolderId, segs.slice(0, 1));
    const jobFolder = await deps.gdrive.ensureFolderPath(creds, deps.config.google, userFolder ?? cfg.rootFolderId, userOwned ? segs : segs.slice(1));
    return { userFolder, jobFolder };
  });
}

/** Share the per-user folder (shared destinations) and return the link. Sharing failures never fail the job. */
async function shareGDrive(deps: UploadDeps, cfg: GDriveConfig, userOwned: boolean, folders: { userFolder: string | null; jobFolder: string }, user: UserRow): Promise<string | null> {
  const creds = { clientId: cfg.clientId, clientSecret: cfg.clientSecret, refreshToken: cfg.refreshToken };
  try {
    if (userOwned || !folders.userFolder) return gdriveLib.folderUrl(folders.jobFolder);
    if (cfg.sharing === 'none') return null;
    if (cfg.sharing === 'anyone') await deps.gdrive.shareFolder(creds, deps.config.google, folders.userFolder, 'anyone');
    else if (user.email) await deps.gdrive.shareFolder(creds, deps.config.google, folders.userFolder, { email: user.email });
    else return null;
    return gdriveLib.folderUrl(folders.userFolder);
  } catch (err) {
    deps.log.warn({ err: redact(err instanceof Error ? err.message : String(err)) }, 'sharing the Drive folder failed');
    return null;
  }
}
