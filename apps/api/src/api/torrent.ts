import parseTorrent from 'parse-torrent';
import type { TorrentSource } from '../lib/types.js';
import { validation } from './errors.js';

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

export interface ParsedSource { infohash: string; name: string | null; totalSize: number; source: TorrentSource }

async function run(input: string | Uint8Array) {
  try {
    return await parseTorrent(input);
  } catch {
    throw validation('Not a valid magnet link or .torrent file');
  }
}

const nameOf = (n: string | string[] | undefined): string | null => {
  const v = Array.isArray(n) ? n[0] : n;
  return v && v.trim() ? v.trim().slice(0, 500) : null;
};

export async function parseMagnet(magnet: string): Promise<ParsedSource> {
  const m = magnet.trim();
  if (!/^magnet:\?/i.test(m)) throw validation('Not a valid magnet link');
  const p = await run(m);
  const infohash = normalizeInfohash(p.infoHash);
  if (!infohash) throw validation('Magnet link has no valid BitTorrent v1 infohash');
  return { infohash, name: nameOf(p.name), totalSize: 0, source: { magnet: m } };
}

export async function parseTorrentFile(buf: Buffer): Promise<ParsedSource> {
  if (buf.length === 0) throw validation('Empty torrent file');
  const p = await run(new Uint8Array(buf));
  const infohash = normalizeInfohash(p.infoHash);
  if (!infohash) throw validation('Torrent file has no valid infohash');
  return { infohash, name: nameOf(p.name), totalSize: p.length ?? 0, source: { torrentB64: buf.toString('base64') } };
}
