import parseTorrent from 'parse-torrent';
import { canonicalizeMagnet, normalizeInfohash, SourceError } from '../lib/source.js';
import { rebuildTorrent } from '../lib/torrent-file.js';
import type { TorrentSource } from '../lib/types.js';
import { validation } from './errors.js';

export { normalizeInfohash };

export interface ParsedSource { infohash: string; name: string | null; totalSize: number; trackers: string[]; source: TorrentSource }

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

// ---- .torrent files ---------------------------------------------------------------------------------------
// The infohash is SHA-1 of the raw `info` bytes of the uploaded file (lib/torrent-file.ts, strict canonical bencode only),
// never parse-torrent's re-encoded view: a lenient decoder keeps the LAST duplicate key and re-sorts keys, which let a
// crafted file make the app track one torrent while qBittorrent ran another. parse-torrent is only a cross-check.

const MAX_TORRENT_FILE = 5 * 1024 * 1024;

export async function parseTorrentFile(buf: Buffer): Promise<ParsedSource> {
  if (buf.length === 0) throw validation('Empty torrent file');
  let r: ReturnType<typeof rebuildTorrent>;
  try {
    r = rebuildTorrent(buf, MAX_TORRENT_FILE);
  } catch (e) {
    if (e instanceof SourceError) throw validation(e.message);
    throw e;
  }
  // Belt and braces: an independent parser must agree on the infohash, for the upload and for the file we will store.
  for (const input of [buf, r.file]) {
    let p: Awaited<ReturnType<typeof parseTorrent>>;
    try { p = await parseTorrent(new Uint8Array(input)); } catch { throw validation('Not a valid magnet link or .torrent file'); }
    if (normalizeInfohash(p.infoHash) !== r.infohash) throw validation('Torrent file is ambiguous (infohash mismatch between parsers)');
  }
  return { infohash: r.infohash, name: r.name, totalSize: r.totalSize, trackers: r.trackers, source: { torrentB64: r.file.toString('base64') } };
}
