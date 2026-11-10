import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF guard for user-supplied outbound URLs (S3 endpoint / publicBaseUrl).
 *
 * `assertPublicEndpoint` is async and throws `NetGuardError` whose message is safe to show to
 * any user (it never contains the resolved address or upstream text). The worker must call it
 * again immediately before every upload for user-owned destinations.
 *
 * Known limitation (DNS rebinding / TOCTOU): we resolve the name here, but the HTTP client
 * resolves it again when it connects, so a hostile resolver can answer "public" to us and
 * "private" to the client. The API only checks (create/update/test/presign); the real network
 * use happens in the worker, which must re-check right before connecting and should not reuse
 * an earlier verdict. Shared (admin-created) destinations are trusted and may use private hosts.
 */
export class NetGuardError extends Error {}

export interface GuardOptions {
  /** Admin-created / shared destinations: http and private addresses are allowed. */
  allowPrivate: boolean;
  /** Test seam; defaults to dns.lookup({ all: true }). */
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
}

const defaultLookup = (host: string) => dnsLookup(host, { all: true, verbatim: true });

/** Syntax-only check: http(s), parseable, no credentials. Used by the zod schemas for every URL. */
export function parseHttpUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new NetGuardError('Invalid URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new NetGuardError('URL must use http or https');
  if (u.username || u.password) throw new NetGuardError('URL must not contain credentials');
  return u;
}

function v4Parts(ip: string): number[] | null {
  const p = ip.split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null;
}

export function isBlockedV4(ip: string): boolean {
  const p = v4Parts(ip);
  if (!p) return true;
  const [a, b, c] = p as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 0)
    || (a === 198 && (b === 18 || b === 19));
}

/** Expand an IPv6 literal to 8 16-bit groups (handles `::` and an embedded dotted quad). */
function expandV6(ip: string): number[] | null {
  let s = ip.split('%')[0]!.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const p = v4Parts(dotted[1]!);
    if (!p) return null;
    s = s.slice(0, -dotted[1]!.length) + ((p[0]! << 8) | p[1]!).toString(16) + ':' + ((p[2]! << 8) | p[3]!).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const v4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

export function isBlockedV6(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return true;
  if (g.slice(0, 5).every((x) => x === 0)) {
    // ::/96 (unspecified, loopback, v4-compatible) is blocked; ::ffff:a.b.c.d is judged by the embedded v4.
    return g[5] === 0xffff ? isBlockedV4(v4Of(g[6]!, g[7]!)) : g[5] === 0;
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return true;            // 64:ff9b::/96 NAT64 (embeds a v4 address)
  if (g[0] === 0x2002) return isBlockedV4(v4Of(g[1]!, g[2]!));  // 6to4
  return (g[0]! & 0xffc0) === 0xfe80   // fe80::/10 link-local
    || (g[0]! & 0xfe00) === 0xfc00     // fc00::/7 ULA
    || (g[0]! & 0xff00) === 0xff00;    // ff00::/8 multicast
}

export function isBlockedAddress(ip: string): boolean {
  const f = isIP(ip);
  return f === 4 ? isBlockedV4(ip) : f === 6 ? isBlockedV6(ip) : true;
}

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.localdomain'];

export async function assertPublicEndpoint(rawUrl: string, opts: GuardOptions): Promise<URL> {
  const u = parseHttpUrl(rawUrl);
  if (opts.allowPrivate) return u;
  if (u.protocol !== 'https:') throw new NetGuardError('Endpoint must use https');

  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const notPublic = new NetGuardError('Endpoint host is not publicly routable');
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw notPublic;
    return u;
  }
  // Bare single-label names (compose service names such as "api", "vpn", "localhost").
  if (!host.includes('.') || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) throw notPublic;
  let addrs: { address: string }[];
  try { addrs = await (opts.lookup ?? defaultLookup)(host); } catch { throw new NetGuardError('Endpoint host could not be resolved'); }
  if (addrs.length === 0) throw new NetGuardError('Endpoint host could not be resolved');
  if (addrs.some((a) => isBlockedAddress(a.address))) throw notPublic;
  return u;
}
