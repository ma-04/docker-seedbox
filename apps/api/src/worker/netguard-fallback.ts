/**
 * Minimal SSRF guard for the worker, used until the shared apps/api/src/lib/netguard.ts is wired in.
 * Same call shape as that module's `assertPublicEndpoint(url, { allowPrivate })`: resolves the host and throws
 * when any address is loopback/private/link-local/CGNAT/multicast/metadata, unless `allowPrivate` (admin-managed
 * shared destinations may legitimately point at a MinIO on the LAN). Always requires http(s).
 *
 * Limitation: rclone resolves the name again when it connects (DNS rebinding); the shared guard should pin or
 * re-validate. This is a best-effort check.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type EndpointGuard = (url: string, opts: { allowPrivate: boolean }) => Promise<void>;

/** True for addresses an outside user must not make the server connect to. */
export function isPrivateAddress(addr: string): boolean {
  const ip = addr.replace(/^\[|\]$/g, '').split('%')[0]!;
  const v = isIP(ip);
  if (v === 4) return isPrivateV4(ip);
  if (v === 6) {
    const l = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l); // IPv4-mapped
    if (mapped) return isPrivateV4(mapped[1]!);
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(l);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1]!, 16), lo = parseInt(mappedHex[2]!, 16);
      return isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return l === '::' || l === '::1' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || /^ff/.test(l) || /^(64:ff9b|2001:db8)/.test(l);
  }
  return true; // not an IP literal: unresolvable names are refused by the caller
}

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) // CGNAT
    || (a === 169 && b === 254) // link-local, cloud metadata
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0)
    || (a === 198 && (b === 18 || b === 19));
}

export const fallbackEndpointGuard: EndpointGuard = async (url, { allowPrivate }) => {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error('Invalid endpoint URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Endpoint must be an http(s) URL');
  if (allowPrivate) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host.toLowerCase() === 'localhost' || host.toLowerCase().endsWith('.localhost')) throw new Error('Endpoint resolves to a private address');
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => { throw new Error('Endpoint host could not be resolved'); })).map((a) => a.address);
  if (!addrs.length || addrs.some(isPrivateAddress)) throw new Error('Endpoint resolves to a private address');
};
