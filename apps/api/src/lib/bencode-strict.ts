/**
 * Strict, canonical-only bencode decoder (no dependencies).
 *
 * Why it exists: the infohash of an uploaded .torrent MUST be the one the downloader will compute, i.e. SHA-1 of the RAW
 * bytes of the (first) `info` value. A lenient decoder + re-encoder (what parse-torrent does) keeps the LAST duplicate key
 * and normalises key order, so a crafted file can make the app and qBittorrent/libtorrent disagree. This decoder rejects
 * every non-canonical construct ANYWHERE in the file instead of picking an interpretation:
 *
 *  - dictionary keys must be byte strings, in strictly ascending raw-byte order (so no duplicates, no unsorted keys)
 *  - integers: `i<digits>e` or `i-<digits>e`, no leading zeros, no `-0`, not empty, no sign-only, <= 20 digits
 *  - strings: `<len>:<bytes>`, no leading zeros in len (except `0`), <= 10 digits, must fit in the buffer
 *  - exactly one root value and nothing after it
 *  - nesting depth <= MAX_DEPTH, input <= `maxBytes`, number of values (keys included) <= MAX_ELEMENTS
 *
 * Every node records the byte range it came from, so callers can hash/copy the exact raw bytes of any value.
 * `encodeCanonical(decode(x))` is byte-identical to `x` for every accepted input (asserted by `assertCanonical`).
 */

export class BencodeError extends Error {}

export const MAX_DEPTH = 16;
export const MAX_ELEMENTS = 2_000_000;
export const MAX_INPUT_BYTES = 5 * 1024 * 1024;

export interface IntNode { type: 'int'; value: bigint; start: number; end: number }
/** `start`/`end` delimit the whole `<len>:<bytes>` token; `data` is the payload (a view into the input, not a copy). */
export interface StrNode { type: 'str'; data: Buffer; start: number; end: number }
export interface ListNode { type: 'list'; items: BNode[]; start: number; end: number }
export interface DictEntry { key: Buffer; value: BNode }
export interface DictNode { type: 'dict'; entries: DictEntry[]; start: number; end: number }
export type BNode = IntNode | StrNode | ListNode | DictNode;

const ZERO = 0x30;
const isDigit = (c: number | undefined): c is number => c !== undefined && c >= 0x30 && c <= 0x39;

class Decoder {
  private count = 0;
  constructor(private readonly b: Buffer) {}

  private tick(): void {
    if (++this.count > MAX_ELEMENTS) throw new BencodeError('too many elements');
  }

  private digits(p: number, maxLen: number): number {
    let q = p;
    while (isDigit(this.b[q])) q++;
    const n = q - p;
    if (n === 0) throw new BencodeError('digit expected');
    if (n > maxLen) throw new BencodeError('number too long');
    if (n > 1 && this.b[p] === ZERO) throw new BencodeError('leading zero');
    return q;
  }

  int(p: number): IntNode {
    this.tick();
    let q = p + 1;
    if (this.b[q] === 0x2d) q++; // '-'
    const neg = q > p + 1;
    const dEnd = this.digits(q, 20);
    if (neg && this.b[q] === ZERO) throw new BencodeError('negative zero');
    if (this.b[dEnd] !== 0x65) throw new BencodeError('unterminated integer');
    return { type: 'int', value: BigInt(this.b.toString('latin1', p + 1, dEnd)), start: p, end: dEnd + 1 };
  }

  str(p: number): StrNode {
    this.tick();
    const colon = this.digits(p, 10);
    if (this.b[colon] !== 0x3a) throw new BencodeError('colon expected');
    const len = Number(this.b.toString('latin1', p, colon));
    const start = colon + 1;
    if (start + len > this.b.length) throw new BencodeError('string exceeds input');
    return { type: 'str', data: this.b.subarray(start, start + len), start: p, end: start + len };
  }

  value(p: number, depth: number): BNode {
    if (p >= this.b.length) throw new BencodeError('unexpected end of input');
    const c = this.b[p]!;
    if (c === 0x69) return this.int(p); // i
    if (isDigit(c)) return this.str(p);
    if (c === 0x6c || c === 0x64) { // l / d
      if (depth >= MAX_DEPTH) throw new BencodeError('nesting too deep');
      this.tick();
      const isDict = c === 0x64;
      const items: BNode[] = [];
      const entries: DictEntry[] = [];
      let q = p + 1;
      let prev: Buffer | null = null;
      for (;;) {
        if (q >= this.b.length) throw new BencodeError('unterminated container');
        if (this.b[q] === 0x65) { q++; break; }
        if (isDict) {
          if (!isDigit(this.b[q])) throw new BencodeError('dictionary key must be a string');
          const k = this.str(q);
          if (prev && Buffer.compare(prev, k.data) >= 0) throw new BencodeError('dictionary keys not strictly ascending (duplicate or unsorted)');
          prev = k.data;
          const v = this.value(k.end, depth + 1);
          entries.push({ key: k.data, value: v });
          q = v.end;
        } else {
          const v = this.value(q, depth + 1);
          items.push(v);
          q = v.end;
        }
      }
      return isDict ? { type: 'dict', entries, start: p, end: q } : { type: 'list', items, start: p, end: q };
    }
    throw new BencodeError('invalid bencode token');
  }
}

/** Decode exactly one canonical bencode value covering the whole buffer. Throws BencodeError otherwise. */
export function decodeStrict(buf: Buffer, maxBytes = MAX_INPUT_BYTES): BNode {
  if (buf.length === 0) throw new BencodeError('empty input');
  if (buf.length > maxBytes) throw new BencodeError('input too large');
  const d = new Decoder(buf);
  const root = d.value(0, 0);
  if (root.end !== buf.length) throw new BencodeError('trailing bytes after the root value');
  return root;
}

export const bencInt = (n: number | bigint): Buffer => Buffer.from(`i${n}e`, 'latin1');
export const bencStr = (s: string | Buffer): Buffer => {
  const d = typeof s === 'string' ? Buffer.from(s, 'utf8') : s;
  return Buffer.concat([Buffer.from(`${d.length}:`, 'latin1'), d]);
};

/** Canonical encoding of a decoded tree (built from values, not from the source byte ranges). */
export function encodeCanonical(n: BNode): Buffer {
  const out: Buffer[] = [];
  const walk = (x: BNode): void => {
    switch (x.type) {
      case 'int': out.push(bencInt(x.value)); break;
      case 'str': out.push(bencStr(x.data)); break;
      case 'list': out.push(Buffer.from('l')); x.items.forEach(walk); out.push(Buffer.from('e')); break;
      case 'dict': out.push(Buffer.from('d')); for (const e of x.entries) { out.push(bencStr(e.key)); walk(e.value); } out.push(Buffer.from('e')); break;
    }
  };
  walk(n);
  return Buffer.concat(out);
}

/** Canonical-form check: re-encoding the decoded tree must reproduce the input byte for byte. */
export function assertCanonical(buf: Buffer, root: BNode): void {
  if (!encodeCanonical(root).equals(buf)) throw new BencodeError('not in canonical form');
}

export const dictGet = (d: DictNode, key: string): BNode | undefined => {
  const k = Buffer.from(key, 'latin1');
  return d.entries.find((e) => e.key.equals(k))?.value;
};
