/**
 * Deferred file removal for deleted jobs and destinations (docs/architecture.md § Deleting jobs).
 * The API calls `enqueueDeletion` inside the same transaction that deletes the job/destination rows; the worker consumes
 * `pending_deletions` (worker/deletions.ts) with retries.
 */
import { decryptJson } from './crypto.js';
import type { Db } from './db.js';
import { fullRemotePath, getDestination } from './destinations.js';
import { getSetting } from './settings.js';
import { now, type JobRow, type LocalConfig, type S3Config } from './types.js';

export interface PendingDeletionRow {
  id: number; destination_id: number; remote_path: string; torrent_id: number | null; kind: 'local' | 's3'; full_path: string;
  config_enc: string | null; user_owned: number; attempts: number; retry_at: number; last_error: string | null; created_at: number;
}

/** True when `p` is a plain relative path of safe segments (no empty, `.`/`..`, backslash, NUL). */
export function isSafeRelPath(p: string): boolean {
  if (!p || p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/**
 * Queue removal of the delivered files of a job that is being deleted (any finished job that got as far as choosing a
 * remote_path; the worker's reference check keeps files another job still uses, so a failed sibling can never cause a loss).
 * local: always. s3: only when `cleanup.deleteRemoteOnJobDelete` is on AND `opts.remote` (job deletes, not destination
 * deletes). Google Drive: never (data is kept). Must run in the caller's transaction. Idempotent per (destination, remote_path, kind).
 */
export function enqueueDeletion(db: Db, appSecret: string, job: Pick<JobRow, 'destination_id' | 'remote_path' | 'state' | 'torrent_id'>, opts: { remote?: boolean } = {}): void {
  if (!['completed', 'failed', 'cancelled'].includes(job.state) || !job.remote_path || !isSafeRelPath(job.remote_path)) return;
  const dest = getDestination(db, appSecret, job.destination_id);
  if (!dest) return;
  const cfg = dest.config;
  let kind: 'local' | 's3';
  if (cfg.type === 'local') kind = 'local';
  else if (cfg.type === 's3' && opts.remote !== false && getSetting(db, 'cleanup.deleteRemoteOnJobDelete')) kind = 's3';
  else return;
  if (db.prepare('SELECT 1 FROM pending_deletions WHERE destination_id = ? AND remote_path = ? AND kind = ?').get(job.destination_id, job.remote_path, kind)) return;
  db.prepare(
    'INSERT INTO pending_deletions (destination_id, remote_path, torrent_id, kind, full_path, config_enc, user_owned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(job.destination_id, job.remote_path, job.torrent_id ?? null, kind, fullRemotePath(cfg, job.remote_path), kind === 's3' ? dest.row.config_enc : null,
    dest.row.owner_user_id === null ? 0 : 1, now());
}

/** Does any remaining job deliver to the same place? (same destination + remote_path, or another local destination mapping to the same library path). */
export function stillReferenced(db: Db, appSecret: string, row: Pick<PendingDeletionRow, 'destination_id' | 'remote_path' | 'kind' | 'full_path'>): boolean {
  if (db.prepare('SELECT 1 FROM jobs WHERE destination_id = ? AND remote_path = ? LIMIT 1').get(row.destination_id, row.remote_path)) return true;
  if (row.kind !== 'local') return false;
  const others = db.prepare(
    "SELECT DISTINCT j.destination_id AS id FROM jobs j JOIN destinations d ON d.id = j.destination_id WHERE j.remote_path = ? AND d.type = 'local'",
  ).all(row.remote_path) as { id: number }[];
  return others.some((o) => {
    const d = getDestination(db, appSecret, o.id);
    return d?.config.type === 'local' && fullRemotePath(d.config as LocalConfig, row.remote_path) === row.full_path;
  });
}

/** A job for the same torrent and destination is queued/running (e.g. the user deleted and immediately re-added it): its remote_path is not known yet. */
export function reAddedActive(db: Db, row: Pick<PendingDeletionRow, 'destination_id' | 'torrent_id'>): boolean {
  if (row.torrent_id === null) return false;
  return !!db.prepare("SELECT 1 FROM jobs WHERE torrent_id = ? AND destination_id = ? AND state IN ('queued','downloading','uploading') LIMIT 1").get(row.torrent_id, row.destination_id);
}

export const s3ConfigOf = (appSecret: string, enc: string): S3Config => {
  const c = decryptJson<S3Config>(appSecret, enc);
  if (c.type !== 's3') throw new Error('Snapshot is not an S3 destination');
  return c;
};
