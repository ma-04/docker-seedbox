/** Deliver a downloaded torrent's files to a job's destination (rclone for gdrive/s3, filesystem for local). */
import type { Logger } from 'pino';
import { createWriteStream } from 'node:fs';
import { mkdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Config } from '../lib/config.js';
import type { Db } from '../lib/db.js';
import { fullRemotePath, getDestination, jobRemoteDir } from '../lib/destinations.js';
import * as gdriveLib from '../lib/gdrive.js';
import { getSetting } from '../lib/settings.js';
import { now, type DestinationConfig, type GDriveConfig, type JobRow, type TorrentRow, type UserRow } from '../lib/types.js';
import type { Downloader } from '../downloaders/types.js';
import { openVetted, realInside, realInsideLoose, vetTree, type SourceFile, type VettedTree } from './safefs.js';
import { assertPublicEndpoint } from '../lib/netguard.js';
import type { EgressProxy } from './egress-proxy.js';
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
  /**
   * Forward proxy vetting every connection rclone makes for USER-OWNED destinations (redirects, DNS rebinding).
   * The Worker always provides one; shared (admin) destinations never use it.
   */
  egress?: Pick<EgressProxy, 'env'>;
  /** rclone abort/stall tuning (tests). */
  killGraceMs?: number;
  stallMs?: number;
  /** Lets the owner of the upload kill rclone on shutdown. */
  onProc?: (jobId: number, proc: RcloneProc) => void;
}

export type { SourceFile };

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

/**
 * Where the torrent's content lives on disk, as a REAL path. Every candidate is resolved with realpath and must lie inside
 * the real `incomplete/<infohash>` (a hostile torrent name such as `../../library`, or a symlink planted by a compromised
 * qBittorrent, must not make the worker upload, copy or move something else); the library copy recorded by an earlier
 * local job that moved the data is the last resort (also resolved).
 */
async function resolveSource(deps: UploadDeps, torrent: TorrentRow): Promise<string> {
  const st = await deps.downloader.status(torrent.infohash).catch(() => null);
  const root = resolve(deps.config.downloadsDir, 'incomplete', torrent.infohash);
  const candidates = [
    st?.contentPath,
    join(torrent.save_path ?? root, torrent.name ?? ''),
  ].filter((p): p is string => !!p && p !== '');
  for (const c of candidates) {
    const r = await realInside(c, root);
    if (r) return r;
  }
  const lib = resolve(deps.config.downloadsDir, 'library');
  if (torrent.library_path && resolve(torrent.library_path).startsWith(lib + sep)) {
    const r = await realInsideLoose(torrent.library_path, lib);
    if (r) return r;
  }
  throw new Error('Downloaded files not found on disk');
}

/**
 * The recorded library copy of a `downloaded` torrent is gone: forget it, drop the (data-less) engine entry and put the
 * torrent back to `pending` with its jobs back to `queued`, in one transaction, so the normal pipeline downloads it again.
 */
async function redownload(deps: UploadDeps, torrent: TorrentRow): Promise<boolean> {
  await deps.downloader.remove(torrent.infohash, true).catch(() => undefined);
  deps.log.warn({ torrentId: torrent.id }, 'the library copy of a downloaded torrent is gone; downloading it again');
  return deps.db.transaction(() => {
    const r = deps.db.prepare(
      `UPDATE torrents SET state = 'pending', progress = 0, dl_speed = 0, error = NULL, completed_at = NULL, started_at = NULL,
         library_path = NULL, cleanup_pending = 0 WHERE id = ? AND state = 'downloaded'`,
    ).run(torrent.id);
    if (r.changes === 0) return false;
    deps.db.prepare(
      "UPDATE jobs SET state = 'queued', upload_progress = 0, upload_speed = 0, updated_at = ? WHERE torrent_id = ? AND state IN ('downloading','uploading')",
    ).run(now(), torrent.id);
    return true;
  }).immediate();
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
      const priorReal = prior ? await realInsideLoose(prior, resolve(deps.config.downloadsDir, 'library')) : null;
      if (!priorReal) {
        // The torrent's data lived only in a library copy that has since been removed (deleted by hand, or by a job delete that
        // raced this job): download it again instead of failing the job.
        if (torrent.library_path && torrent.state === 'downloaded' && (await redownload(deps, torrent))) return;
        throw e;
      }
      source = priorReal;
      delivered = true;
    }
    const remotePath = jobRemoteDir(dest.row, user, torrent.infohash, torrent.name ?? basename(source));
    const userOwned = dest.row.owner_user_id !== null;
    const libReal = torrent.library_path ? await realpath(torrent.library_path).catch(() => null) : null;
    const fromLibrary = libReal !== null && source === libReal;
    db.prepare('UPDATE jobs SET remote_path = ?, upload_progress = 0, upload_speed = 0, folder_url = NULL, error = NULL, updated_at = ? WHERE id = ?')
      .run(remotePath, now(), jobId);

    // Only regular files and directories are ever delivered: symlinks, FIFOs, sockets, devices and hardlinked files planted
    // in the content tree (by a compromised qBittorrent) are skipped, never followed.
    const vet = await vetTree(source, { allowHardlinks: fromLibrary || delivered });
    if (vet.skipped.length) log.warn({ jobId, skipped: vet.skipped.length }, 'skipped non-regular entries (symlinks, FIFOs, sockets, devices, hardlinks) in the torrent content');
    const files = vet.files;
    let folderUrl: string | null = null;
    let listFile: string | undefined;

    if (dest.config.type === 'local') {
      if (!delivered) await uploadLocal(deps, job, torrent, source, fullRemotePath(dest.config, remotePath), signal, fromLibrary, vet);
    } else {
      let gdrive: { userFolder: string | null; jobFolder: string } | undefined;
      if (dest.config.type === 's3') {
        await (deps.endpointGuard ?? defaultEndpointGuard)(dest.config.endpoint, { allowPrivate: !userOwned });
      } else if (dest.config.type === 'gdrive') {
        gdrive = await resolveGDriveFolders(deps, dest.config, dest.row.id, userOwned, remotePath, user);
      }
      const egress = userOwned && deps.egress ? await deps.egress.env() : undefined;
      // rclone gets exactly the vetted file list (never a directory walk of its own), so planted entries cannot be picked up.
      if (vet.isDir) {
        const names = files.map((f) => f.path).filter((n) => !/[\r\n]/.test(n));
        const dir = stagingDir(deps.config.downloadsDir, jobId);
        await mkdir(dir, { recursive: true });
        listFile = join(dir, 'files.txt');
        await writeFile(listFile, names.join('\n') + '\n', { mode: 0o600 });
      }
      const cmd = buildRcloneCommand(dest.config, source, remotePath, { gdriveFolderId: gdrive?.jobFolder, egress, filesFrom: listFile });
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
    }).immediate();
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
  } finally {
    // the file list of a remote upload lives in the job's staging dir (local jobs use it for the copy and clean it themselves)
    await rm(join(stagingDir(deps.config.downloadsDir, jobId), 'files.txt'), { force: true }).catch(() => undefined);
  }
}

async function uploadLocal(deps: UploadDeps, job: JobRow, torrent: TorrentRow, source: string, relTarget: string, signal: AbortSignal, fromLibrary: boolean, vet: VettedTree): Promise<void> {
  const { db, config } = deps;
  const root = resolve(config.downloadsDir, 'library');
  const target = resolve(root, relTarget);
  if (target === root || !target.startsWith(root + sep)) throw new Error('Refusing to write outside the library folder');
  const isDir = vet.isDir;
  const dstPath = isDir ? target : join(target, basename(source)); // single files land inside <target>/
  if (signal.aborted) throw new RcloneAborted();
  // The data already sits exactly where this job wants it (crash after the rename, or the same user re-added the
  // same torrent): copying a file onto itself would truncate it.
  if (resolve(source) === dstPath || (await sameFile(source, dstPath))) return;

  const targetExisted = await exists(target);
  const existed = await exists(dstPath);
  await mkdir(isDir ? dirname(target) : target, { recursive: true });
  const staging = stagingDir(config.downloadsDir, job.id);

  // Move (rename) only when this job is the last one that needs the data and nothing seeds it. The decision is one
  // conditional UPDATE that also records where the data went, so a job added meanwhile copies from there instead of
  // finding the data gone. The content is first renamed into the worker-only staging dir (qBittorrent cannot see it, so
  // nothing can be planted any more), re-vetted there and only then published into the library.
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
        await rm(staging, { recursive: true, force: true });
        await mkdir(staging, { recursive: true });
        const parked = join(staging, 'move');
        let parkedOk = false;
        try { await rename(source, parked); parkedOk = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e; }
        if (parkedOk) {
          try {
            const again = await vetTree(parked); // regular files and directories only: drop whatever was planted meanwhile
            for (const rel of again.skipped) await rm(join(parked, ...rel.split('/')), { recursive: true, force: true });
            await renameInto(parked, dstPath);
            moved = true;
            return;
          } catch (e) {
            await rename(parked, source).catch(() => undefined); // put the data back where qBittorrent expects it
            throw e;
          } finally {
            await rm(staging, { recursive: true, force: true }).catch(() => undefined);
          }
        }
      }
    } finally {
      if (!moved) db.prepare('UPDATE torrents SET library_path = NULL WHERE id = ? AND library_path = ?').run(torrent.id, dstPath);
      moving.delete(torrent.id);
      release();
    }
  }

  // Copy into a staging dir on the same volume and rename into place only when everything is written, so a crash or
  // cancel can never leave a partial target that crash recovery would mistake for a delivered job.
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const staged = join(staging, 'item');
  try {
    await copyVetted(source, staged, vet, signal, fromLibrary);
    if (signal.aborted) throw new RcloneAborted();
    if (existed) { // an earlier copy by the same user: swap it out, never merge
      await rename(dstPath, join(staging, 'old'));
    }
    await renameInto(staged, dstPath);
  } catch (e) {
    if (existed) await rename(join(staging, 'old'), dstPath).catch(() => undefined); // put the previous copy back
    if (!targetExisted) await rm(target, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Both paths exist and are the same real file/directory. */
async function sameFile(a: string, b: string): Promise<boolean> {
  try { return (await realpath(a)) === (await realpath(b)); } catch { return false; }
}

/**
 * rename() into a directory that was created earlier: the worker's deletion step prunes empty `<slug>-<id>` parents, which
 * can race with a copy in flight (the parent was empty while the staging copy ran). Recreate it and retry once.
 */
async function renameInto(from: string, to: string): Promise<void> {
  try { await rename(from, to); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
  }
}

export const stagingDir = (downloadsDir: string, jobId: number): string => resolve(downloadsDir, 'library', '.staging', String(jobId));

/**
 * Copy exactly the vetted entries of `src` (a real path) to `dst`. Every file is opened with O_NOFOLLOW and checked on
 * the descriptor (regular, not hardlinked, real path as vetted), so a link swapped in after vetting is refused. Stops
 * promptly when `signal` aborts (also in the middle of a large file).
 */
async function copyVetted(src: string, dst: string, vet: VettedTree, signal: AbortSignal, allowHardlinks: boolean): Promise<void> {
  if (signal.aborted) throw new RcloneAborted();
  const one = async (from: string, to: string): Promise<void> => {
    if (signal.aborted) throw new RcloneAborted();
    const fh = await openVetted(from, { allowHardlinks });
    try {
      await pipeline(fh.createReadStream({ autoClose: false }), createWriteStream(to, { flags: 'wx', mode: 0o644 }), { signal });
    } catch (e) {
      if (signal.aborted) throw new RcloneAborted();
      throw e;
    } finally {
      await fh.close().catch(() => undefined);
    }
  };
  if (!vet.isDir) { await mkdir(dirname(dst), { recursive: true }); return one(src, dst); }
  await mkdir(dst, { recursive: true });
  for (const d of vet.dirs) await mkdir(join(dst, ...d.split('/')), { recursive: true });
  for (const f of vet.files) await one(join(src, ...f.path.split('/')), join(dst, ...f.path.split('/')));
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
