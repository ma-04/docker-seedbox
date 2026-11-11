/**
 * Worker side of deferred file removal (docs/architecture.md § Deleting jobs): consumes `pending_deletions`.
 * Local: `rm -rf library/<fullRemotePath>` confined to the library root, then prune empty parent dirs.
 * S3 (only queued when `cleanup.deleteRemoteOnJobDelete` was on): `rclone purge DST:<exact job dir>`.
 * Nothing is removed while another job still points at the same destination + remote_path.
 */
import { lstat, realpath, rm, rmdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Logger } from 'pino';
import type { Config } from '../lib/config.js';
import type { Db } from '../lib/db.js';
import { isSafeRelPath, reAddedActive, s3ConfigOf, stillReferenced, type PendingDeletionRow } from '../lib/deletions.js';
import { now, type TorrentRow } from '../lib/types.js';
import type { EgressProxy } from './egress-proxy.js';
import { buildS3PurgeCommand, redact, runRclone, type SpawnFn } from './rclone.js';
import { defaultEndpointGuard, type EndpointGuard } from './upload.js';

export interface DeletionDeps {
  db: Db; config: Config; log: Logger; spawn: SpawnFn; rcloneBin: string;
  egress?: Pick<EgressProxy, 'env'>; endpointGuard?: EndpointGuard; signal?: AbortSignal;
  /** Rows handled per call. */
  batch?: number;
  /** Give up (and drop the row) after this many failed attempts. Default 12. */
  maxAttempts?: number;
}

/** Not an error: the files are still needed right now; look again later without counting an attempt. */
class Defer extends Error {}

const ACTIVE = "('queued','downloading','uploading')";
const within = (root: string, p: string): boolean => p.startsWith(root + sep);

async function deleteLocal(d: DeletionDeps, row: PendingDeletionRow): Promise<void> {
  const root = resolve(d.config.downloadsDir, 'library');
  if (!isSafeRelPath(row.full_path)) throw new Error('Refusing to delete: unsafe path');
  const target = resolve(root, row.full_path);
  if (!within(root, target) || within(join(root, '.staging'), target) || target === join(root, '.staging')) throw new Error('Refusing to delete outside the library folder');

  // Resolve symlinked parents: the real parent must still be inside the real library root.
  let realRoot: string;
  try { realRoot = await realpath(root); } catch { return; } // no library at all: nothing to delete
  try {
    const realParent = await realpath(dirname(target));
    if (realParent !== realRoot && !within(realRoot, realParent)) throw new Error('Refusing to delete outside the library folder');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return; // parent directory does not exist, so neither does the target
  }

  // A torrent whose library copy is (inside) this directory and that still has active jobs would lose its source.
  // The decision and the torrent's state change are ONE immediate transaction taken BEFORE the files go: a job the API
  // adds afterwards sees a removed torrent (and downloads again) instead of a `downloaded` one whose data is gone, and
  // a job that already exists defers the deletion until it has finished.
  d.db.transaction(() => {
    const holders = (d.db.prepare('SELECT * FROM torrents WHERE library_path IS NOT NULL').all() as TorrentRow[])
      .filter((t) => { const p = resolve(t.library_path!); return p === target || within(target, p); });
    for (const t of holders) {
      if (d.db.prepare(`SELECT 1 FROM jobs WHERE torrent_id = ? AND state IN ${ACTIVE} LIMIT 1`).get(t.id)) throw new Defer('library copy still needed by an active job');
    }
    for (const t of holders) {
      // `cleanup_pending`: a torrent the engine may still hold (moved-but-not-yet-released) is removed by the worker's sweep.
      d.db.prepare("UPDATE torrents SET library_path = NULL, state = 'removed', dl_speed = 0, cleanup_pending = CASE WHEN state IN ('downloading','downloaded') THEN 1 ELSE cleanup_pending END WHERE id = ?").run(t.id);
    }
  }).immediate();

  const st = await lstat(target).catch(() => null);
  if (st) await rm(target, { recursive: true, force: true });

  // Prune now-empty `<slug>-<id>` (and subdir) parents, never the library root itself.
  let dir = dirname(target);
  while (within(root, dir)) {
    try { await rmdir(dir); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') { dir = dirname(dir); continue; }
      break; // ENOTEMPTY / EACCES: stop
    }
    dir = dirname(dir);
  }
}

async function purgeS3(d: DeletionDeps, row: PendingDeletionRow): Promise<void> {
  if (!row.config_enc) throw new Error('Missing destination snapshot');
  const cfg = s3ConfigOf(d.config.appSecret, row.config_enc);
  const userOwned = row.user_owned === 1;
  const cmd0 = buildS3PurgeCommand(cfg, row.remote_path, userOwned); // assertions first (throws on a bad path)
  if (userOwned) await (d.endpointGuard ?? defaultEndpointGuard)(cfg.endpoint, { allowPrivate: false });
  const egress = userOwned && d.egress ? await d.egress.env() : undefined;
  const cmd = egress ? buildS3PurgeCommand(cfg, row.remote_path, userOwned, egress) : cmd0;
  try {
    await runRclone({ spawn: d.spawn, bin: d.rcloneBin, cmd, signal: d.signal, stallMs: 5 * 60_000, onStats: () => undefined });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/directory not found|not found/i.test(msg)) return; // already gone
    throw new Error(redact(msg, cmd.secrets));
  }
}

/** One pass over the due rows. Never throws. */
export async function processDeletions(d: DeletionDeps): Promise<void> {
  const rows = d.db.prepare('SELECT * FROM pending_deletions WHERE retry_at <= ? ORDER BY id LIMIT ?').all(now(), d.batch ?? 20) as PendingDeletionRow[];
  for (const row of rows) {
    if (d.signal?.aborted) return;
    try {
      if (reAddedActive(d.db, row)) throw new Defer('the same torrent was added again for this destination');
      if (stillReferenced(d.db, d.config.appSecret, row)) {
        d.log.info({ deletionId: row.id }, 'files are still referenced by another job; keeping them');
      } else if (row.kind === 'local') await deleteLocal(d, row);
      else await purgeS3(d, row);
      d.db.prepare('DELETE FROM pending_deletions WHERE id = ?').run(row.id);
    } catch (err) {
      if (err instanceof Defer) { d.db.prepare('UPDATE pending_deletions SET retry_at = ? WHERE id = ?').run(now() + 30, row.id); continue; }
      const attempts = row.attempts + 1;
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      if (attempts >= (d.maxAttempts ?? 12)) {
        d.log.warn({ deletionId: row.id, kind: row.kind, err: message }, 'giving up deleting files of a removed job');
        d.db.prepare('DELETE FROM pending_deletions WHERE id = ?').run(row.id);
      } else {
        d.db.prepare('UPDATE pending_deletions SET attempts = ?, last_error = ?, retry_at = ? WHERE id = ?')
          .run(attempts, message, now() + Math.min(3600, 30 * 2 ** attempts), row.id);
        d.log.warn({ deletionId: row.id, attempt: attempts, err: message }, 'deleting files of a removed job failed; will retry');
      }
    }
  }
}
