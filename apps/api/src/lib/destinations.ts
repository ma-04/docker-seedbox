import { decryptJson, encryptJson } from './crypto.js';
import type { Db } from './db.js';
import { MASK, SECRET_FIELDS, userSlug, type DestinationConfig, type DestinationRow, type UserRow } from './types.js';

export interface Destination { row: DestinationRow; config: DestinationConfig }

export function getDestination(db: Db, appSecret: string, id: number): Destination | null {
  const row = db.prepare('SELECT * FROM destinations WHERE id = ?').get(id) as DestinationRow | undefined;
  return row ? { row, config: decryptJson<DestinationConfig>(appSecret, row.config_enc) } : null;
}

export const encryptConfig = (appSecret: string, config: DestinationConfig): string => encryptJson(appSecret, config);

/** Copy of config with secret fields replaced by MASK (empty secrets stay empty). */
export function maskConfig(config: DestinationConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const f of SECRET_FIELDS[config.type]) if (out[f]) out[f] = MASK;
  return out;
}

/** Merge an update into an existing config; MASK or undefined for a secret field keeps the stored value. */
export function mergeConfig<T extends DestinationConfig>(existing: T, patch: Partial<T>): T {
  const out = { ...existing, ...patch } as Record<string, unknown>;
  for (const f of SECRET_FIELDS[existing.type]) {
    const v = (patch as unknown as Record<string, unknown>)[f];
    if (v === MASK || v === undefined) out[f] = (existing as unknown as Record<string, unknown>)[f];
  }
  return out as T;
}

/** Make a torrent name safe as a single path segment on every destination. */
export function safeSegment(name: string): string {
  const s = name.replace(/[\/\\\0]/g, '_').replace(/^\.+/, '_').trim().slice(0, 200);
  return s === '' ? 'untitled' : s;
}

/**
 * Directory (no leading/trailing slash) a job's files live in, relative to the destination root.
 * Shared destinations: `<userSlug>/<torrentName>`; user-owned: `<torrentName>`.
 * Stored in jobs.remote_path; job_files.path is relative to it. Destination-level prefixes
 * (S3Config.prefix, LocalConfig.subdir) are NOT included — see fullRemotePath.
 */
export function jobRemoteDir(dest: DestinationRow, user: Pick<UserRow, 'username'>, torrentName: string): string {
  const name = safeSegment(torrentName);
  return dest.owner_user_id === null ? `${userSlug(user.username)}/${name}` : name;
}

const trimSlashes = (s: string | undefined): string => (s ?? '').replace(/^\/+|\/+$/g, '');

/** Destination-level prefix + remote path, joined with single slashes, no leading slash. */
export function fullRemotePath(config: DestinationConfig, ...parts: string[]): string {
  const prefix = config.type === 's3' ? trimSlashes(config.prefix) : config.type === 'local' ? trimSlashes(config.subdir) : '';
  return [prefix, ...parts.map(trimSlashes)].filter(Boolean).join('/');
}
