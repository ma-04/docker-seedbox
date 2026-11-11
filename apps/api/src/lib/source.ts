/**
 * Torrent source policy. A magnet link is NEVER stored or forwarded as the user typed it: it is parsed and a canonical
 * magnet is rebuilt from the few fields we understand (`xt` v1 infohash, `dn`, filtered `tr`). Everything else
 * (`ws` webseeds, `xs`, `as`, `x.pe`, `so`, `kt`, unknown keys, raw bytes) is dropped.
 *
 * Why: the stored string is later posted to qBittorrent's `urls` form field, which splits on `\n`. A newline inside `dn`
 * used to smuggle in extra URLs that qBittorrent then fetched from inside its own network namespace.
 *
 * The web app carries a copy of the whitespace/length rules in apps/web/src/lib/magnet.ts (`magnet.test.ts` there
 * and `source.test.ts` here pin the same cases). Keep them in sync.
 */
import { truncateUtf8 } from './destinations.js';
import { isPublicHostSync } from './netguard.js';

export class SourceError extends Error {}

export const MAX_MAGNET_BYTES = 8192;
export const MAX_TRACKERS = 50;
export const MAX_DN_BYTES = 255;
const TRACKER_PROTOCOLS = new Set(['http:', 'https:', 'udp:', 'ws:', 'wss:']);
/** Any whitespace (incl. unicode spaces, NBSP, U+2028/9) or control character. */
// eslint-disable-next-line no-control-regex
const WS_OR_CONTROL = /[\s\u0000-\u001f\u007f-\u009f]/u;
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Normalise a v1 infohash (40 hex or 32 base32) to lowercase hex, or null. */
export function normalizeInfohash(h: string | undefined): string | null {
  if (!h) return null;
  const s = h.trim().toLowerCase();
  if (/^[0-9a-f]{40}$/.test(s)) return s;
  if (/^[a-z2-7]{32}$/.test(s)) {
    let bits = '';
    for (const c of s) bits += B32.indexOf(c).toString(2).padStart(5, '0');
    let hex = '';
    for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex.length === 40 ? hex : null;
  }
  return null;
}

/** Cheap tracker URL policy (no DNS): scheme allow-list, parseable, no credentials, public-looking host. Returns the normalised URL or null. */
export function sanitiseTracker(raw: string): string | null {
  if (raw.length > 2048 || WS_OR_CONTROL.test(raw) || raw.includes('\\')) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (!TRACKER_PROTOCOLS.has(u.protocol) || u.username || u.password) return null;
  if (!isPublicHostSync(u.hostname)) return null;
  return u.href;
}

/** Filter + dedupe + cap a tracker list. */
export function sanitiseTrackers(list: Iterable<string>, max = MAX_TRACKERS): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const t = sanitiseTracker(raw);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** Display name: control/format characters become spaces, whitespace collapsed, at most MAX_DN_BYTES UTF-8 bytes. */
export function sanitiseDisplayName(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
  const t = truncateUtf8(s, MAX_DN_BYTES).trim();
  return t || null;
}

export interface CanonicalMagnet { infohash: string; name: string | null; trackers: string[]; magnet: string }

export function buildMagnet(infohash: string, name: string | null, trackers: string[]): string {
  let m = `magnet:?xt=urn:btih:${infohash}`;
  if (name) m += `&dn=${encodeURIComponent(name)}`;
  for (const t of trackers.slice(0, MAX_TRACKERS)) m += `&tr=${encodeURIComponent(t)}`;
  return m;
}

/** Validate a user-supplied magnet and rebuild it canonically. Throws SourceError with a user-facing message. */
export function canonicalizeMagnet(input: string): CanonicalMagnet {
  const m = input.trim();
  if (Buffer.byteLength(m, 'utf8') > MAX_MAGNET_BYTES) throw new SourceError('Magnet link is too long');
  if (WS_OR_CONTROL.test(m)) throw new SourceError('Magnet link contains whitespace or control characters');
  if (!/^magnet:\?/i.test(m)) throw new SourceError('Not a valid magnet link');
  const params = new URLSearchParams(m.slice('magnet:?'.length));
  let infohash: string | null = null;
  let name: string | null = null;
  const trackers: string[] = [];
  for (const [k, v] of params) {
    if (k === 'xt') {
      const x = /^urn:btih:([0-9a-z]+)$/i.exec(v);
      if (x && !infohash) infohash = normalizeInfohash(x[1]);
    } else if (k === 'dn') {
      if (name === null) name = sanitiseDisplayName(v);
    } else if (k === 'tr' || /^tr\.\d+$/.test(k)) trackers.push(v);
  }
  if (!infohash) throw new SourceError('Magnet link has no valid BitTorrent v1 infohash');
  const clean = sanitiseTrackers(trackers);
  return { infohash, name, trackers: clean, magnet: buildMagnet(infohash, name, clean) };
}

/** Union of two tracker lists (sanitised, capped); `base` entries keep their order. */
export function mergeTrackers(base: string[], extra: string[]): string[] {
  return sanitiseTrackers([...base, ...extra]);
}
