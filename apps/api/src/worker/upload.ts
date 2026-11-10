/** Deliver a downloaded torrent's files to a job's destination (rclone for gdrive/s3, filesystem for local). */
import type { Logger } from 'pino';
import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { Config } from '../lib/config.js';
import type { Db } from '../lib/db.js';
import { fullRemotePath, getDestination, jobRemoteDir } from '../lib/destinations.js';
import * as gdriveLib from '../lib/gdrive.js';
import { getSetting } from '../lib/settings.js';
import { now, type GDriveConfig, type JobRow, type TorrentRow, type UserRow } from '../lib/types.js';
import type { Downloader } from '../downloaders/types.js';
import { buildRcloneCommand, redact, runRclone, RcloneAborted, type RcloneProc, type SpawnFn } from './rclone.js';

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

/** Where the torrent's content lives on disk. */
async function resolveSource(deps: UploadDeps, torrent: TorrentRow): Promise<string> {
  const st = await deps.downloader.status(torrent.infohash).catch(() => null);
  const candidates = [
    st?.contentPath,
    join(torrent.save_path ?? join(deps.config.downloadsDir, 'incomplete', torrent.infohash), torrent.name ?? ''),
  ].filter((p): p is string => !!p && p !== '');
  for (const c of candidates) if (await exists(c)) return c;
  throw new Error('Downloaded files not found on disk');
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
  try {
    const torrent = db.prepare('SELECT * FROM torrents WHERE id = ?').get(job.torrent_id) as TorrentRow;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(job.user_id) as UserRow;
    const dest = getDestination(db, deps.config.appSecret, job.destination_id);
    if (!dest) throw new Error('Destination no longer exists');
    if (torrent.state !== 'downloaded') throw new Error('Downloaded data is no longer available');

    let source: string;
    let delivered = false;
    try {
      source = await resolveSource(deps, torrent);
    } catch (e) {
      // Crash recovery: a previous run may already have moved the files into the library (rename).
      const prior = dest.config.type === 'local' && torrent.name
        ? resolve(deps.config.downloadsDir, 'library', fullRemotePath(dest.config, jobRemoteDir(dest.row, user, torrent.name)))
        : null;
      if (!prior || !(await exists(prior))) throw e;
      source = prior;
      delivered = true;
    }
    const remotePath = jobRemoteDir(dest.row, user, torrent.name ?? basename(source));
    db.prepare('UPDATE jobs SET remote_path = ?, upload_progress = 0, upload_speed = 0, folder_url = NULL, error = NULL, updated_at = ? WHERE id = ?')
      .run(remotePath, now(), jobId);

    const { files } = await walkSource(source);
    let folderUrl: string | null = null;

    if (dest.config.type === 'local') {
      if (!delivered) await uploadLocal(deps, job, torrent, source, fullRemotePath(dest.config, remotePath), signal);
    } else {
      const cmd = buildRcloneCommand(dest.config, source, remotePath);
      secrets = cmd.secrets;
      let last = 0;
      await runRclone({
        spawn: deps.spawn, bin: deps.rcloneBin, cmd, signal,
        onProc: (p) => deps.onProc?.(jobId, p),
        onStats: (s) => {
          const t = Date.now();
          if (t - last < 1000 || s.totalBytes <= 0) return;
          last = t;
          db.prepare("UPDATE jobs SET upload_progress = ?, upload_speed = ?, updated_at = ? WHERE id = ? AND state = 'uploading'")
            .run(Math.min(0.99, s.bytes / s.totalBytes), Math.round(s.speed), now(), jobId);
        },
      });
      if (dest.config.type === 'gdrive') folderUrl = await shareGDrive(deps, dest.config, dest.row.owner_user_id !== null, remotePath, user);
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
    const msg = redact(err instanceof Error ? err.message : String(err), secrets);
    log.warn({ jobId, err: msg }, 'upload failed');
    failJob(deps, jobId, msg);
  }
}

async function uploadLocal(deps: UploadDeps, job: JobRow, torrent: TorrentRow, source: string, relTarget: string, signal: AbortSignal): Promise<void> {
  const { db, config } = deps;
  const root = resolve(config.downloadsDir, 'library');
  const target = resolve(root, relTarget);
  if (target === root || !target.startsWith(root + sep)) throw new Error('Refusing to write outside the library folder');
  const isDir = (await stat(source)).isDirectory();
  const dstDir = target; // single files land inside <target>/
  if (signal.aborted) throw new RcloneAborted();

  const others = (db.prepare(
    "SELECT COUNT(*) AS n FROM jobs WHERE torrent_id = ? AND id != ? AND state IN ('queued','downloading','uploading')",
  ).get(torrent.id, job.id) as { n: number }).n;
  const canMove = others === 0 && getSetting(db, 'seeding.ratio') <= 0;

  await mkdir(isDir ? dirname(target) : target, { recursive: true });
  if (isDir) {
    if (canMove && !(await exists(dstDir))) {
      try { await rename(source, dstDir); return; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e; }
    }
    await cp(source, dstDir, { recursive: true, force: true });
  } else {
    const file = join(target, basename(source));
    if (canMove && !(await exists(file))) {
      try { await rename(source, file); return; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e; }
    }
    await cp(source, file, { force: true });
  }
}

/** Resolve the Drive folder and (optionally) share the per-user folder. Sharing failures never fail the job. */
async function shareGDrive(deps: UploadDeps, cfg: GDriveConfig, userOwned: boolean, remotePath: string, user: UserRow): Promise<string | null> {
  const creds = { clientId: cfg.clientId, clientSecret: cfg.clientSecret, refreshToken: cfg.refreshToken };
  const segs = remotePath.split('/');
  try {
    if (userOwned) {
      return gdriveLib.folderUrl(await deps.gdrive.ensureFolderPath(creds, deps.config.google, cfg.rootFolderId, segs));
    }
    if (cfg.sharing === 'none') return null;
    const userFolder = await deps.gdrive.ensureFolderPath(creds, deps.config.google, cfg.rootFolderId, segs.slice(0, 1));
    if (cfg.sharing === 'anyone') await deps.gdrive.shareFolder(creds, deps.config.google, userFolder, 'anyone');
    else if (user.email) await deps.gdrive.shareFolder(creds, deps.config.google, userFolder, { email: user.email });
    else return null;
    return gdriveLib.folderUrl(userFolder);
  } catch (err) {
    deps.log.warn({ err: redact(err instanceof Error ? err.message : String(err)) }, 'sharing the Drive folder failed');
    return null;
  }
}
