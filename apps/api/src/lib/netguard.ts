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
  return a === 0                                         // 0.0.0.0/8 "this network"
    || a === 10 || a === 127 || a >= 224                 // RFC 1918, loopback, multicast + reserved (224/3 incl. 240/4)
    || (a === 100 && b >= 64 && b <= 127)                // 100.64/10 CGNAT
    || (a === 169 && b === 254)                          // link-local
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))    // 192.0.0.0/24 IETF protocol, 192.0.2.0/24 TEST-NET-1
    || (a === 192 && b === 88 && c === 99)               // 192.88.99.0/24 deprecated 6to4 relay
    || (a === 198 && (b === 18 || b === 19))             // 198.18/15 benchmarking
    || (a === 198 && b === 51 && c === 100)              // TEST-NET-2
    || (a === 203 && b === 0 && c === 113);              // TEST-NET-3
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
  // ::ffff:0:a.b.c.d (::ffff:0:0/96) IPv4-translated (SIIT): never a public destination.
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return true;
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return isBlockedV4(v4Of(g[6]!, g[7]!)); // 64:ff9b::/96 NAT64
    if (g[2] === 1) return true;                               // 64:ff9b:1::/48 local-use NAT64 (embedding offset varies)
    return true;                                               // the rest of 64:ff9b::/32 is not a valid NAT64 prefix
  }
  if (g[0] === 0x2002) return isBlockedV4(v4Of(g[1]!, g[2]!));  // 2002::/16 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true;               // 2001::/32 Teredo
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true;           // 2001:db8::/32 documentation
  if (g[0] === 0x2001 && g[1] === 2 && g[2] === 0) return true; // 2001:2::/48 benchmarking
  if (g[0] === 0x2001 && g[1]! >= 0x10 && g[1]! <= 0x2f) return true; // 2001:10::/28 ORCHID, 2001:20::/28 ORCHIDv2
  if (g[0] === 0x3fff && (g[1]! & 0xf000) === 0) return true;   // 3fff::/20 documentation
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // 100::/64 discard-only
  if (g[0] === 0x5f00) return true;                             // 5f00::/16 SRv6 SIDs
  return (g[0]! & 0xffc0) === 0xfe80   // fe80::/10 link-local
    || (g[0]! & 0xffc0) === 0xfec0     // fec0::/10 deprecated site-local
    || (g[0]! & 0xfe00) === 0xfc00     // fc00::/7 ULA
    || (g[0]! & 0xff00) === 0xff00;    // ff00::/8 multicast
}

export function isBlockedAddress(ip: string): boolean {
  const f = isIP(ip);
  return f === 4 ? isBlockedV4(ip) : f === 6 ? isBlockedV6(ip) : true;
}

export const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.localdomain'];

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

/**
 * Synchronous, DNS-free host policy used for tracker URLs: false for IP literals in non-public ranges, bare single-label
 * names, internal suffixes and numeric-looking names such as `2130706433` or `0x7f.1` (resolvers accept those as IPv4).
 * A name that passes may still resolve to a private address; only the egress proxy / sidecar firewall can close that.
 */
export function isPublicHostSync(rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) return false;
  if (isIP(host)) return !isBlockedAddress(host);
  if (host.includes(':')) return false; // an IPv6-looking string isIP rejected
  if (!host.includes('.') || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) return false;
  const last = host.split('.').pop()!;
  if (/^(0x[0-9a-f]*|\d+)$/i.test(last)) return false; // "ends in a number": inet_aton forms
  return true;
}
