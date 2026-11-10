// WebCrypto port of apps/api/src/lib/signing.ts. Contract: sig = hex(HMAC-SHA256(key, path + "\n" + exp)).
const enc = new TextEncoder();

export function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function hmacKey(key: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

export async function sign(key: string, path: string, exp: number | string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(key, 'sign'), enc.encode(`${path}\n${exp}`));
  return toHex(mac);
}

export type VerifyResult = 'ok' | 'bad-signature' | 'expired';

export async function verify(
  key: string,
  path: string,
  exp: string | null,
  sig: string | null,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<VerifyResult> {
  if (exp === null || sig === null || !/^\d{1,12}$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) return 'bad-signature';
  // subtle.verify compares in constant time.
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(key, 'verify'), fromHex(sig), enc.encode(`${path}\n${Number(exp)}`));
  if (!ok) return 'bad-signature';
  if (exp !== '0' && Number(exp) < nowSec) return 'expired';
  return 'ok';
}

/**
 * Decode a raw URL pathname into the canonical decoded path ("/a/b/c") or null when invalid:
 * malformed percent-encoding, empty / "." / ".." segments, NUL, backslash, or an encoded "/" in a segment.
 */
export function canonicalPath(pathname: string): string | null {
  if (!pathname.startsWith('/')) return null;
  const raw = pathname.split('/').slice(1);
  const segs: string[] = [];
  for (const r of raw) {
    let s: string;
    try {
      s = decodeURIComponent(r);
    } catch {
      return null;
    }
    if (s === '' || s === '.' || s === '..' || s.includes('\0') || s.includes('\\') || s.includes('/')) return null;
    segs.push(s);
  }
  return segs.length ? '/' + segs.join('/') : null;
}
