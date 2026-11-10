import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed download links. Contract (docs/architecture.md § Links), shared with apps/drive-proxy:
 *   sig = hex(HMAC-SHA256(key, path + "\n" + exp))
 * `path` is the decoded path with a leading "/" and no "." / ".." / empty segments; exp "0" = never.
 */
export function normalizePath(path: string): string | null {
  if (!path.startsWith('/')) return null;
  const segs = path.split('/').slice(1);
  if (segs.length === 0 || segs.some((s) => s === '' || s === '.' || s === '..' || s.includes('\0'))) return null;
  return '/' + segs.join('/');
}

export function sign(key: string | Buffer, path: string, exp: number): string {
  return createHmac('sha256', key).update(`${path}\n${exp}`).digest('hex');
}

export type VerifyResult = 'ok' | 'bad-signature' | 'expired';

export function verify(key: string | Buffer, path: string, exp: string, sig: string, nowSec = Math.floor(Date.now() / 1000)): VerifyResult {
  if (!/^\d{1,12}$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig) || normalizePath(path) !== path) return 'bad-signature';
  const expected = Buffer.from(sign(key, path, Number(exp)), 'hex');
  if (!timingSafeEqual(expected, Buffer.from(sig, 'hex'))) return 'bad-signature';
  if (exp !== '0' && Number(exp) < nowSec) return 'expired';
  return 'ok';
}

/** Build `${baseUrl}${prefix}/<encoded path>?exp=&sig=`; ttlSeconds 0/undefined = never expires. */
export function signedUrl(baseUrl: string, key: string | Buffer, path: string, ttlSeconds?: number, prefix = '', nowSec = Math.floor(Date.now() / 1000)): string {
  const exp = ttlSeconds && ttlSeconds > 0 ? nowSec + ttlSeconds : 0;
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `${baseUrl.replace(/\/+$/, '')}${prefix}${encoded}?exp=${exp}&sig=${sign(key, path, exp)}`;
}
