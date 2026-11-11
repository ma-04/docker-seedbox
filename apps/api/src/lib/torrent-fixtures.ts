/** Hand-built bencode for tests (no vitest import so API and worker tests can share it). Nothing here validates anything. */
import { createHash } from 'node:crypto';

export const sha1hex = (b: Buffer): string => createHash('sha1').update(b).digest('hex');
export const bs = (s: string | Buffer): Buffer => {
  const d = typeof s === 'string' ? Buffer.from(s, 'utf8') : s;
  return Buffer.concat([Buffer.from(`${d.length}:`), d]);
};
export const bi = (n: number | bigint | string): Buffer => Buffer.from(`i${n}e`);
export const bl = (...items: Buffer[]): Buffer => Buffer.concat([Buffer.from('l'), ...items, Buffer.from('e')]);
/** Dict with the entries in the order GIVEN (possibly unsorted / duplicated: that is the point). */
export const bdRaw = (...kv: [string | Buffer, Buffer][]): Buffer => Buffer.concat([Buffer.from('d'), ...kv.flatMap(([k, v]) => [bs(k), v]), Buffer.from('e')]);
/** Dict with keys sorted by raw bytes (canonical). */
export const bd = (kv: Record<string, Buffer>): Buffer =>
  bdRaw(...Object.entries(kv).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))));

export interface InfoOpts {
  name?: string;
  pieceLength?: number;
  /** single-file length, or multi-file list of [path parts, length] */
  length?: number;
  files?: { path: string[]; length: number }[];
  /** override the number of pieces (default: consistent with the size) */
  pieceCount?: number;
  extra?: Record<string, Buffer>;
  /** seed byte for the piece hashes so different calls give different infohashes */
  seed?: number;
}

export function makeInfo(o: InfoOpts = {}): Buffer {
  const pieceLength = o.pieceLength ?? 16384;
  const total = o.files ? o.files.reduce((a, f) => a + f.length, 0) : (o.length ?? 1000);
  const count = o.pieceCount ?? Math.max(1, Math.ceil(total / pieceLength));
  const pieces = Buffer.alloc(count * 20);
  for (let i = 0; i < pieces.length; i++) pieces[i] = ((o.seed ?? 7) * 31 + i * 7 + (i >> 8)) & 0xff;
  const kv: Record<string, Buffer> = {
    name: bs(o.name ?? 'file.bin'),
    'piece length': bi(pieceLength),
    pieces: bs(pieces),
    ...(o.files
      ? { files: bl(...o.files.map((f) => bd({ length: bi(f.length), path: bl(...f.path.map((p) => bs(p))) }))) }
      : { length: bi(total) }),
    ...(o.extra ?? {}),
  };
  return bd(kv);
}

/** Root dict with the given raw info bytes and extra top-level entries (canonical order). */
export function makeTorrent(info: Buffer, extra: Record<string, Buffer> = {}): Buffer {
  return bd({ ...extra, info });
}
