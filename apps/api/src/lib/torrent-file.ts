/**
 * Strict .torrent handling. The infohash we record is SHA-1 of the RAW `info` bytes of the file we store and forward, and
 * the declared size is validated against the piece list, so what the app tracks is exactly what qBittorrent runs.
 * See lib/bencode-strict.ts for the canonical-only decoder and docs/architecture.md § Torrent sources.
 *
 * The file we keep is BUILT FROM SCRATCH: a root dict with only `announce`/`announce-list` (sanitised) and `info` (verbatim).
 */
import { createHash } from 'node:crypto';
import {
  assertCanonical, BencodeError, bencStr, decodeStrict, dictGet, MAX_INPUT_BYTES,
  type BNode, type DictNode, type StrNode,
} from './bencode-strict.js';
import { sanitiseDisplayName, sanitiseTrackers, SourceError } from './source.js';

export class TorrentFileError extends SourceError {}

export interface StrictTorrent {
  infohash: string;
  /** The exact bytes of the `info` value, as in the uploaded file. */
  infoRaw: Buffer;
  name: string | null;
  totalSize: number;
  pieceLength: number;
  pieceCount: number;
  /** Unsanitised tracker strings from `announce` / `announce-list`, in file order. */
  announce: string[];
}

function bad(m: string): never { throw new TorrentFileError(m); }
const sha1 = (b: Buffer): string => createHash('sha1').update(b).digest('hex');
const MAX_NAME_BYTES = 4096;
const MAX_PATH_BYTES = 4096;

const asDict = (n: BNode | undefined, what: string): DictNode => (n && n.type === 'dict' ? n : bad(`${what} is not a dictionary`));
const asStr = (n: BNode | undefined, what: string): StrNode => (n && n.type === 'str' ? n : bad(`${what} is not a string`));

function nonNegInt(n: BNode | undefined, what: string): bigint {
  if (!n || n.type !== 'int') return bad(`${what} is not an integer`);
  if (n.value < 0n) return bad(`${what} is negative`);
  return n.value;
}

function checkPathPart(p: Buffer): void {
  if (p.length === 0 || p.length > MAX_PATH_BYTES) bad('Torrent has an empty or oversized path component');
  const s = p.toString('latin1');
  if (s === '.' || s === '..' || /[/\\\0]/.test(s)) bad('Torrent has an unsafe path component');
}

/** BEP 47 symlink entries would make the engine create symlinks inside the download directory. */
function checkNoSymlink(d: DictNode): void {
  if (dictGet(d, 'symlink path') !== undefined) bad('Torrents containing symlinks are not supported');
  const attr = dictGet(d, 'attr');
  if (attr !== undefined && (attr.type !== 'str' || attr.data.includes(0x6c))) bad('Torrents containing symlinks are not supported');
}

/** Everything about the info dict that decides what the downloader will do; mirrors what libtorrent will derive. */
function validateInfo(info: DictNode): { totalSize: number; pieceLength: number; pieceCount: number; name: Buffer } {
  if (dictGet(info, 'meta version') || dictGet(info, 'file tree')) bad('BitTorrent v2 / hybrid torrents are not supported (v1 only)');
  const name = asStr(dictGet(info, 'name'), 'name').data;
  if (name.length === 0 || name.length > MAX_NAME_BYTES) bad('Torrent name is empty or too long');
  checkPathPart(name);
  // libtorrent prefers the .utf-8 variants when present, so they get exactly the same rules (old clients emit them).
  const nameUtf8 = dictGet(info, 'name.utf-8');
  if (nameUtf8 !== undefined) {
    const d = asStr(nameUtf8, 'name.utf-8').data;
    if (d.length > MAX_NAME_BYTES) bad('Torrent name is too long');
    checkPathPart(d);
  }
  // libtorrent also reads `attr` / `symlink path` from a single-file info dict.
  checkNoSymlink(info);
  const pl = nonNegInt(dictGet(info, 'piece length'), 'piece length');
  if (pl <= 0n) bad('piece length must be positive');
  const pieces = asStr(dictGet(info, 'pieces'), 'pieces').data;
  if (pieces.length === 0 || pieces.length % 20 !== 0) bad('pieces must be a non-empty multiple of 20 bytes');

  const length = dictGet(info, 'length');
  const files = dictGet(info, 'files');
  if ((length === undefined) === (files === undefined)) bad('Torrent must have exactly one of length and files');
  let total = 0n;
  if (length !== undefined) {
    total = nonNegInt(length, 'length');
  } else {
    if (!files || files.type !== 'list' || files.items.length === 0) return bad('files must be a non-empty list');
    for (const f of files.items) {
      const fd = asDict(f, 'file entry');
      total += nonNegInt(dictGet(fd, 'length'), 'file length');
      const path = dictGet(fd, 'path');
      if (!path || path.type !== 'list' || path.items.length === 0) bad('file path must be a non-empty list');
      else for (const part of path.items) checkPathPart(asStr(part, 'path component').data);
      const pu = dictGet(fd, 'path.utf-8');
      if (pu !== undefined) {
        if (pu.type !== 'list' || pu.items.length === 0) bad('file path.utf-8 must be a non-empty list');
        else for (const part of pu.items) checkPathPart(asStr(part, 'path.utf-8 component').data);
      }
      checkNoSymlink(fd);
    }
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) bad('Torrent size is out of range');
  const pieceCount = pieces.length / 20;
  // The declared size is only trustworthy when the piece list agrees with it.
  const expected = (total + pl - 1n) / pl;
  if (total === 0n) bad('Torrent is empty');
  if (expected !== BigInt(pieceCount)) bad('Torrent piece list does not match its declared size');
  return { totalSize: Number(total), pieceLength: Number(pl), pieceCount, name };
}

function trackersOf(root: DictNode): string[] {
  const out: string[] = [];
  const text = (n: BNode | undefined): void => { if (n && n.type === 'str') out.push(n.data.toString('utf8')); };
  text(dictGet(root, 'announce'));
  const al = dictGet(root, 'announce-list');
  if (al && al.type === 'list') {
    for (const tier of al.items) {
      if (tier.type === 'list') tier.items.forEach(text);
      else text(tier);
    }
  }
  return out;
}

/** Strictly parse a .torrent: canonical bencode everywhere, v1 only, validated info dict. Throws TorrentFileError. */
export function parseStrictTorrent(buf: Buffer, maxBytes = MAX_INPUT_BYTES): StrictTorrent {
  let root: BNode;
  try {
    root = decodeStrict(buf, maxBytes);
    assertCanonical(buf, root);
  } catch (e) {
    if (e instanceof BencodeError) throw new TorrentFileError(`Not a valid .torrent file (${e.message})`);
    throw e;
  }
  const rd = asDict(root, 'Torrent file');
  if (dictGet(rd, 'piece layers')) bad('BitTorrent v2 / hybrid torrents are not supported (v1 only)');
  const infoNode = asDict(dictGet(rd, 'info'), 'info');
  const { totalSize, pieceLength, pieceCount, name } = validateInfo(infoNode);
  const infoRaw = Buffer.from(buf.subarray(infoNode.start, infoNode.end));
  return {
    infohash: sha1(infoRaw),
    infoRaw,
    name: sanitiseDisplayName(name.toString('utf8').slice(0, 500)),
    totalSize, pieceLength, pieceCount,
    announce: trackersOf(rd),
  };
}

/** New root dict: `announce`, `announce-list` (sanitised trackers only) and the verbatim `info` bytes, keys in canonical order. */
export function buildCanonicalTorrent(infoRaw: Buffer, trackers: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from('d')];
  if (trackers.length) {
    parts.push(bencStr('announce'), bencStr(trackers[0]!));
    parts.push(bencStr('announce-list'), Buffer.concat([Buffer.from('l'), ...trackers.map((t) => Buffer.concat([Buffer.from('l'), bencStr(t), Buffer.from('e')])), Buffer.from('e')]));
  }
  parts.push(bencStr('info'), infoRaw, Buffer.from('e'));
  return Buffer.concat(parts);
}

export interface RebuiltTorrent extends StrictTorrent { file: Buffer; trackers: string[] }

/**
 * Strictly parse `buf` and rebuild the file we store/forward. The result is parsed again and must yield the same infohash
 * and size (the rebuilt bytes are what the downloader sees).
 */
export function rebuildTorrent(buf: Buffer, maxBytes = MAX_INPUT_BYTES): RebuiltTorrent {
  const t = parseStrictTorrent(buf, maxBytes);
  const trackers = sanitiseTrackers(t.announce);
  const file = buildCanonicalTorrent(t.infoRaw, trackers);
  const again = parseStrictTorrent(file, maxBytes + 512 * 1024);
  if (again.infohash !== t.infohash || !again.infoRaw.equals(t.infoRaw) || again.totalSize !== t.totalSize) bad('Torrent could not be rebuilt safely');
  return { ...t, file, trackers };
}
