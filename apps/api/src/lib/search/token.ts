/**
 * Search result tokens. A token is the only thing the browser gets for "add this result": it is sealed (AES-256-GCM with
 * a key derived from APP_SECRET for this purpose only), so it is opaque (the backend reference inside it is never
 * visible), unforgeable, bound to the user it was issued to, and short-lived. Stateless: tokens survive an API restart
 * and need no server-side storage. The payload is deflated first (magnets with many trackers compress well).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { deriveKey } from '../crypto.js';

export const TOKEN_TTL_SECONDS = 30 * 60;
export const MAX_TOKEN_CHARS = 16 * 1024;
const VERSION = 1;

export interface TokenPayload {
  /** user id the token was issued to */
  u: number;
  /** expiry, unix seconds */
  e: number;
  /** magnet link (preferred), or */
  m?: string;
  /** backend download reference (secret-free) */
  l?: string;
  /** title, for the error message context only */
  t?: string;
}

export class TokenError extends Error {}

const key = (appSecret: string) => deriveKey(appSecret, 'search-result-token');

export function sealToken(appSecret: string, p: TokenPayload): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(appSecret), iv);
  c.setAAD(Buffer.from([VERSION]));
  const ct = Buffer.concat([c.update(deflateRawSync(Buffer.from(JSON.stringify(p), 'utf8'))), c.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), ct]).toString('base64url');
}

/** Throws TokenError (safe message) unless the token is authentic, unexpired and issued to `userId`. */
export function openToken(appSecret: string, token: string, userId: number, nowS: number): TokenPayload {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_CHARS || !/^[A-Za-z0-9_-]+$/.test(token)) throw new TokenError('Invalid search result');
  const raw = Buffer.from(token, 'base64url');
  if (raw.length < 1 + 12 + 16 + 1 || raw[0] !== VERSION) throw new TokenError('Invalid search result');
  let p: TokenPayload;
  try {
    const d = createDecipheriv('aes-256-gcm', key(appSecret), raw.subarray(1, 13));
    d.setAAD(Buffer.from([VERSION]));
    d.setAuthTag(raw.subarray(13, 29));
    const plain = Buffer.concat([d.update(raw.subarray(29)), d.final()]);
    p = JSON.parse(inflateRawSync(plain, { maxOutputLength: 64 * 1024 }).toString('utf8')) as TokenPayload;
  } catch { throw new TokenError('Invalid search result'); }
  if (!p || typeof p.u !== 'number' || typeof p.e !== 'number') throw new TokenError('Invalid search result');
  if (p.u !== userId) throw new TokenError('Invalid search result');
  if (p.e < nowS) throw new TokenError('This search result has expired; search again');
  if (typeof p.m !== 'string' && typeof p.l !== 'string') throw new TokenError('Invalid search result');
  return p;
}
