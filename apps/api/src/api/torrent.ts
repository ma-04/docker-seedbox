import parseTorrent from 'parse-torrent';
import { canonicalizeMagnet, normalizeInfohash, sanitiseDisplayName, sanitiseTrackers, SourceError } from '../lib/source.js';
import type { TorrentSource } from '../lib/types.js';
import { validation } from './errors.js';

export { normalizeInfohash };

export interface ParsedSource { infohash: string; name: string | null; totalSize: number; trackers: string[]; source: TorrentSource }

async function run(input: string | Uint8Array) {
  try {
    return await parseTorrent(input);
  } catch {
    throw validation('Not a valid magnet link or .torrent file');
  }
}

const nameOf = (n: string | string[] | undefined): string | null => {
  const v = Array.isArray(n) ? n[0] : n;
  return v ? sanitiseDisplayName(v.slice(0, 500)) : null;
};

/** Parse and canonicalise a magnet: the returned `source.magnet` is rebuilt, never the user's string. */
export async function parseMagnet(magnet: string): Promise<ParsedSource> {
  try {
    const c = canonicalizeMagnet(magnet);
    return { infohash: c.infohash, name: c.name, totalSize: 0, trackers: c.trackers, source: { magnet: c.magnet } };
  } catch (e) {
    if (e instanceof SourceError) throw validation(e.message);
    throw e;
  }
}

// ---- .torrent rewriting -------------------------------------------------------------------------------
// announce/announce-list/url-list/httpseeds/nodes live OUTSIDE the info dict, so removing or replacing them keeps the
// infohash. We splice the original bytes (the info dict is copied verbatim, never re-encoded).

const DROP_KEYS = new Set(['announce', 'announce-list', 'url-list', 'httpseeds', 'nodes']);
const MAX_DEPTH = 64;

function skipValue(b: Buffer, i: number, depth = 0): number {
  if (depth > MAX_DEPTH || i >= b.length) throw new Error('bad bencode');
  const c = b[i]!;
  if (c === 0x69) { // i...e
    const e = b.indexOf(0x65, i);
    if (e < 0) throw new Error('bad bencode');
    return e + 1;
  }
  if (c === 0x6c || c === 0x64) { // l...e / d...e
    let p = i + 1;
    while (b[p] !== 0x65) {
      if (p >= b.length) throw new Error('bad bencode');
      p = skipValue(b, p, depth + 1);
      if (c === 0x64) p = skipValue(b, p, depth + 1);
    }
    return p + 1;
  }
  if (c >= 0x30 && c <= 0x39) {
    const colon = b.indexOf(0x3a, i);
    const len = Number(b.toString('latin1', i, colon));
    if (colon < 0 || !Number.isInteger(len) || colon + 1 + len > b.length) throw new Error('bad bencode');
    return colon + 1 + len;
  }
  throw new Error('bad bencode');
}

const benStr = (s: string): Buffer => { const v = Buffer.from(s, 'utf8'); return Buffer.concat([Buffer.from(`${v.length}:`), v]); };

interface Entry { keyName: string; key: Buffer; raw: Buffer; value: Buffer }

/** Rebuild a .torrent with `trackers` as the only announce data and no web seeds. The info dict is copied byte for byte. */
export function rewriteTorrent(buf: Buffer, trackers: string[]): Buffer {
  const entries: Entry[] = [];
  if (buf[0] !== 0x64) throw new Error('bad bencode');
  let p = 1;
  while (buf[p] !== 0x65) {
    if (p >= buf.length) throw new Error('bad bencode');
    const keyEnd = skipValue(buf, p);
    const raw = buf.subarray(p, keyEnd);
    const key = raw.subarray(raw.indexOf(0x3a) + 1);
    const valEnd = skipValue(buf, keyEnd);
    entries.push({ keyName: key.toString('latin1'), key, raw, value: buf.subarray(keyEnd, valEnd) });
    p = valEnd;
  }
  const out = entries.filter((e) => !DROP_KEYS.has(e.keyName));
  if (trackers.length) {
    const add = (name: string, value: Buffer) => out.push({ keyName: name, key: Buffer.from(name), raw: benStr(name), value });
    add('announce', benStr(trackers[0]!));
    add('announce-list', Buffer.concat([Buffer.from('l'), ...trackers.map((t) => Buffer.concat([Buffer.from('l'), benStr(t), Buffer.from('e')])), Buffer.from('e')]));
  }
  out.sort((a, b) => Buffer.compare(a.key, b.key)); // bencode dictionaries are sorted by raw key bytes
  return Buffer.concat([Buffer.from('d'), ...out.flatMap((e) => [e.raw, e.value]), Buffer.from('e')]);
}

export async function parseTorrentFile(buf: Buffer): Promise<ParsedSource> {
  if (buf.length === 0) throw validation('Empty torrent file');
  const p = await run(new Uint8Array(buf));
  const infohash = normalizeInfohash(p.infoHash);
  if (!infohash) throw validation('Torrent file has no valid infohash');
  const trackers = sanitiseTrackers(p.announce ?? []);
  let clean: Buffer;
  try { clean = rewriteTorrent(buf, trackers); } catch { throw validation('Not a valid magnet link or .torrent file'); }
  const again = await run(new Uint8Array(clean));
  if (normalizeInfohash(again.infoHash) !== infohash) throw validation('Not a valid magnet link or .torrent file');
  return { infohash, name: nameOf(p.name), totalSize: p.length ?? 0, trackers, source: { torrentB64: clean.toString('base64') } };
}
