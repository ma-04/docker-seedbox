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

/** Longest path segment we create, in UTF-8 bytes (filesystems cap a name at 255 bytes; leave headroom). */
export const MAX_SEGMENT_BYTES = 180;

/** Truncate to at most `maxBytes` UTF-8 bytes without splitting a code point (or a surrogate pair). */
export function truncateUtf8(s: string, maxBytes: number): string {
  let bytes = 0;
  let out = '';
  for (const ch of s) { // iterates by code point
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > maxBytes) break;
    bytes += n;
    out += ch;
  }
  return out;
}

/**
 * Make a name safe as a single path segment on every destination: no separators or control characters,
 * no leading dots (hidden/`..`), no trailing dots or spaces (Windows/SMB), at most `maxBytes` UTF-8 bytes.
 */
export function safeSegment(name: string, maxBytes = MAX_SEGMENT_BYTES): string {
  // eslint-disable-next-line no-control-regex
  let s = name.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '_') // lone surrogates
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '_').replace(/[\/\\]/g, '_').replace(/^\.+/, '_').trim();
  s = truncateUtf8(s, maxBytes).replace(/[. ]+$/, '');
  return s === '' ? 'untitled' : s;
}

/** Per-user directory on shared destinations: `<slug>-<userId>`; the id makes `Bob`/`bob` and `a b`/`a_b` distinct. */
export const userDirName = (user: Pick<UserRow, 'id' | 'username'>): string => `${userSlug(user.username)}-${user.id}`;

/** ` [<first 8 hex of the infohash>]`: two different torrents with the same name never share a folder. */
const hashSuffix = (infohash: string): string => ` [${infohash.slice(0, 8).toLowerCase()}]`;

/** Name of the job directory (a single segment): `<torrentName> [<8 hex>]`, ≤ MAX_SEGMENT_BYTES bytes in total. */
export function jobDirName(infohash: string, torrentName: string): string {
  const suffix = hashSuffix(infohash);
  return `${safeSegment(torrentName, MAX_SEGMENT_BYTES - Buffer.byteLength(suffix))}${suffix}`;
}

/**
 * Directory (no leading/trailing slash) a job's files live in, relative to the destination root.
 * Shared destinations: `<slug>-<userId>/<torrentName> [<8 hex>]`; user-owned: `<torrentName> [<8 hex>]`.
 * Stored in jobs.remote_path; job_files.path is relative to it. Destination-level prefixes
 * (S3Config.prefix, LocalConfig.subdir) are NOT included — see fullRemotePath.
 */
export function jobRemoteDir(dest: Pick<DestinationRow, 'owner_user_id'>, user: Pick<UserRow, 'id' | 'username'>, infohash: string, torrentName: string): string {
  const dir = jobDirName(infohash, torrentName);
  return dest.owner_user_id === null ? `${userDirName(user)}/${dir}` : dir;
}

const trimSlashes = (s: string | undefined): string => (s ?? '').replace(/^\/+|\/+$/g, '');

/** Destination-level prefix + remote path, joined with single slashes, no leading slash. */
export function fullRemotePath(config: DestinationConfig, ...parts: string[]): string {
  const prefix = config.type === 's3' ? trimSlashes(config.prefix) : config.type === 'local' ? trimSlashes(config.subdir) : '';
  return [prefix, ...parts.map(trimSlashes)].filter(Boolean).join('/');
}
