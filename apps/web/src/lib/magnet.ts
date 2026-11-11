/** Parsing and validation of `magnet:` URIs handed to the app by the browser's protocol handler (`/add?magnet=...`). */

/** Longest accepted magnet URI, in UTF-8 bytes. Real ones are a few hundred bytes; this only bounds hostile input. */
export const MAX_MAGNET_LENGTH = 8192;
const MAX_NAME_LENGTH = 200;

export interface ParsedMagnet {
  /** The URI exactly as received (trimmed); this is what gets pre-filled and later submitted. */
  uri: string;
  /** 40 hex or 32 base32 characters, as written. */
  infohash: string;
  /** Display name (`dn=`), decoded, for rendering as text only. */
  name: string | null;
}

export type MagnetResult = { ok: true; magnet: ParsedMagnet } | { ok: false; error: string };

const BTIH = /^urn:btih:([0-9a-f]{40}|[a-z2-7]{32})$/i;
// Same rules as the API (apps/api/src/lib/source.ts `canonicalizeMagnet`): any whitespace or control character
// anywhere (after trimming the ends) and more than 8 KB (bytes) are rejected. The tests in magnet.test.ts and the
// API's source.test.ts pin the same cases; change both together. The API rebuilds the magnet itself, so this is UX only.
// eslint-disable-next-line no-control-regex
const WS_OR_CONTROL = /[\s\u0000-\u001f\u007f-\u009f]/u;

/** Validates one already-URL-decoded value (what `URLSearchParams.get('magnet')` returns). Never throws. */
export function parseMagnet(input: string | null | undefined): MagnetResult {
  if (input === null || input === undefined || input.trim() === '') return { ok: false, error: 'No magnet link was provided.' };
  const uri = input.trim();
  if (new TextEncoder().encode(uri).length > MAX_MAGNET_LENGTH) return { ok: false, error: 'The magnet link is too long.' };
  if (WS_OR_CONTROL.test(uri)) return { ok: false, error: 'The magnet link contains invalid characters.' };
  if (!/^magnet:\?/i.test(uri)) return { ok: false, error: 'That is not a magnet link (it must start with "magnet:?").' };
  let params: URLSearchParams;
  try { params = new URLSearchParams(uri.slice('magnet:?'.length)); } catch { return { ok: false, error: 'The magnet link is malformed.' }; }
  let infohash: string | null = null;
  for (const xt of params.getAll('xt')) {
    const m = BTIH.exec(xt);
    if (m) { infohash = m[1]!; break; }
  }
  if (!infohash) return { ok: false, error: 'The magnet link has no valid BitTorrent info hash (xt=urn:btih:...).' };
  const dn = params.get('dn')?.trim();
  const name = dn ? (dn.length > MAX_NAME_LENGTH ? `${dn.slice(0, MAX_NAME_LENGTH)}...` : dn) : null;
  return { ok: true, magnet: { uri, infohash, name } };
}

/** What `/add` hands to the Downloads page. */
export interface Incoming {
  magnet: ParsedMagnet | null;
  error: string | null;
  destinationId: number | null;
}

export function parseIncoming(search: string): Incoming {
  const p = new URLSearchParams(search);
  const r = parseMagnet(p.get('magnet'));
  const rawDest = p.get('destinationId');
  const dest = rawDest !== null && /^\d{1,9}$/.test(rawDest) ? Number(rawDest) : null;
  return r.ok ? { magnet: r.magnet, error: null, destinationId: dest } : { magnet: null, error: r.error, destinationId: null };
}

// Hand-over between the `/add` route and the Downloads page. Module state (not router state) so a reload never re-prefills.
let pending: Incoming | null = null;
export const setPendingIncoming = (i: Incoming): void => { pending = i; };
export const peekPendingIncoming = (): Incoming | null => pending;
export const clearPendingIncoming = (): void => { pending = null; };
