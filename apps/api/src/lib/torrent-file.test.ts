import { describe, expect, it } from 'vitest';
import parseTorrent from 'parse-torrent';
import { decodeStrict, dictGet, type DictNode } from './bencode-strict.js';
import { buildCanonicalTorrent, parseStrictTorrent, rebuildTorrent, TorrentFileError } from './torrent-file.js';
import { bd, bdRaw, bi, bl, bs, makeInfo, makeTorrent, sha1hex } from './torrent-fixtures.js';

const rejects = (buf: Buffer, re?: RegExp) => expect(() => parseStrictTorrent(buf)).toThrow(re ? re : TorrentFileError);

describe('parseStrictTorrent: the infohash is SHA-1 of the raw info bytes', () => {
  it('hashes the original bytes of a valid torrent', () => {
    const info = makeInfo();
    const t = parseStrictTorrent(makeTorrent(info));
    expect(t.infohash).toBe(sha1hex(info));
    expect(t.infoRaw.equals(info)).toBe(true);
    expect(t.totalSize).toBe(1000);
  });

  // The reviewer's two cases.
  it('(a) two top-level info dicts -> rejected (parse-torrent keeps the last, libtorrent the first)', () => {
    const decoy = makeInfo({ length: 10, seed: 1 });
    const real = makeInfo({ length: 5_000_000_000, pieceLength: 4 * 1024 * 1024, seed: 2 });
    rejects(bdRaw(['info', decoy], ['info', real]), /ascending/);
  });

  it('(b) unsorted keys inside info -> rejected (re-encoding would change the hash)', () => {
    const info = bdRaw(['name', bs('a')], ['length', bi(1)], ['piece length', bi(16384)], ['pieces', bs(Buffer.alloc(20, 1))]);
    rejects(makeTorrent(info), /ascending/);
  });

  it('duplicate keys inside info, inside a file entry and inside a path list owner -> rejected', () => {
    const dupInfo = bdRaw(['length', bi(1)], ['length', bi(2)], ['name', bs('a')], ['piece length', bi(16384)], ['pieces', bs(Buffer.alloc(20, 1))]);
    rejects(makeTorrent(dupInfo));
    const file = bdRaw(['length', bi(1)], ['length', bi(2)], ['path', bl(bs('a'))]);
    rejects(makeTorrent(bd({ files: bl(file), name: bs('d'), 'piece length': bi(16384), pieces: bs(Buffer.alloc(20)) })));
  });

  it('a duplicate unknown key at the root -> rejected', () => {
    const f = bdRaw(['comment', bs('a')], ['comment', bs('b')], ['info', makeInfo()]);
    rejects(f);
  });

  it('leading-zero integers, -0, trailing junk, and deep nesting -> rejected', () => {
    const info = makeInfo();
    rejects(Buffer.from(makeTorrent(info, { x: Buffer.from('i007e') })));
    rejects(Buffer.from(makeTorrent(info, { x: Buffer.from('i-0e') })));
    rejects(Buffer.concat([makeTorrent(info), Buffer.from('junk')]));
    rejects(Buffer.concat([makeTorrent(info), Buffer.from('\n')]));
    rejects(makeTorrent(info, { x: Buffer.from('l'.repeat(40) + 'e'.repeat(40)) }), /nesting/);
    rejects(makeTorrent(makeInfo({ extra: { 'piece length': bi('016384') } })));
    rejects(Buffer.from('not bencode'));
    rejects(Buffer.alloc(0));
  });

  it('a non-dictionary root or missing/ill-typed info -> rejected', () => {
    rejects(bl(bs('a')));
    rejects(bd({ announce: bs('x') }));
    rejects(bd({ info: bs('x') }));
  });

  it('rejects an oversized upload', () => {
    expect(() => parseStrictTorrent(makeTorrent(makeInfo()), 50)).toThrow(/too large/);
  });
});

describe('info dict shape', () => {
  const T = (o: Parameters<typeof makeInfo>[0]) => makeTorrent(makeInfo(o));
  const raw = (kv: Record<string, Buffer>) => makeTorrent(bd(kv));
  const base = { name: bs('a'), 'piece length': bi(16384), pieces: bs(Buffer.alloc(20, 1)), length: bi(1) };

  it('a size-inconsistent piece list is rejected (the declared size must be trustworthy)', () => {
    rejects(T({ length: 50_000_000_000, pieceCount: 1 }), /piece list/);
    rejects(T({ length: 10, pieceCount: 5 }), /piece list/);
    rejects(T({ length: 16384 * 3 + 1, pieceCount: 3 }), /piece list/);
    expect(parseStrictTorrent(T({ length: 16384 * 3 + 1, pieceCount: 4 })).pieceCount).toBe(4);
    rejects(T({ files: [{ path: ['a'], length: 100 }, { path: ['b'], length: 100 }], pieceCount: 2 }), /piece list/); // 200 bytes = 1 piece
  });

  it.each([
    ['empty name', { ...base, name: bs('') }],
    ['non-string name', { ...base, name: bi(1) }],
    ['missing name', { 'piece length': base['piece length'], pieces: base.pieces, length: base.length }],
    ['zero piece length', { ...base, 'piece length': bi(0) }],
    ['negative piece length', { ...base, 'piece length': bi(-1) }],
    ['pieces not a multiple of 20', { ...base, pieces: bs(Buffer.alloc(21)) }],
    ['empty pieces', { ...base, pieces: bs('') }],
    ['neither length nor files', { name: base.name, 'piece length': base['piece length'], pieces: base.pieces }],
    ['both length and files', { ...base, files: bl(bd({ length: bi(1), path: bl(bs('a')) })) }],
    ['negative length', { ...base, length: bi(-1) }],
    ['non-integer length', { ...base, length: bs('1') }],
    ['empty files list', { ...base, length: undefined as unknown as Buffer, files: bl() }],
    ['v2 meta version', { ...base, 'meta version': bi(2) }],
    ['v2 file tree', { ...base, 'file tree': bd({}) }],
  ])('%s', (_n, kv) => {
    const clean = Object.fromEntries(Object.entries(kv).filter(([, v]) => v !== undefined)) as Record<string, Buffer>;
    rejects(raw(clean));
  });

  it('a v2/hybrid torrent (piece layers at the root) is rejected with a clear message', () => {
    rejects(makeTorrent(makeInfo(), { 'piece layers': bd({}) }), /v2|hybrid/);
    rejects(makeTorrent(makeInfo({ extra: { 'meta version': bi(2), 'file tree': bd({ a: bd({ '': bd({ length: bi(1) }) }) }) } })), /v2|hybrid/);
  });

  it.each([
    ['empty path list', bd({ length: bi(1), path: bl() })],
    ['empty component', bd({ length: bi(1), path: bl(bs('')) })],
    ['dot', bd({ length: bi(1), path: bl(bs('.')) })],
    ['dot-dot', bd({ length: bi(1), path: bl(bs('a'), bs('..')) })],
    ['slash in component', bd({ length: bi(1), path: bl(bs('a/b')) })],
    ['backslash in component', bd({ length: bi(1), path: bl(bs('a\\b')) })],
    ['NUL in component', bd({ length: bi(1), path: bl(bs('a\0b')) })],
    ['non-string component', bd({ length: bi(1), path: bl(bi(1)) })],
    ['negative file length', bd({ length: bi(-1), path: bl(bs('a')) })],
    ['missing file length', bd({ path: bl(bs('a')) })],
    ['symlink path', bd({ length: bi(1), path: bl(bs('a')), 'symlink path': bl(bs('/etc/passwd')) })],
    ['attr l', bd({ attr: bs('l'), length: bi(1), path: bl(bs('a')) })],
    ['non-dict file entry', bs('x')],
  ])('file entry: %s', (_n, file) => {
    rejects(raw({ name: bs('d'), 'piece length': bi(16384), pieces: bs(Buffer.alloc(20)), files: bl(file) }));
  });

  it.each([
    ['single-file info with attr l', { attr: bs('l') }],
    ['single-file info with symlink path', { 'symlink path': bl(bs('x')) }],
    ['name.utf-8 = ..', { 'name.utf-8': bs('..') }],
    ['name.utf-8 with a slash', { 'name.utf-8': bs('a/b') }],
    ['name.utf-8 not a string', { 'name.utf-8': bi(1) }],
  ])('%s', (_n, extra) => {
    rejects(T({ extra }));
  });

  it.each([['..'], ['a/b'], ['a\\b'], ['.']])('name %s', (name) => {
    rejects(T({ name }));
  });

  it('file entries: path.utf-8 gets the same rules as path', () => {
    const f = (pu: Buffer) => raw({ name: bs('d'), 'piece length': bi(16384), pieces: bs(Buffer.alloc(20)), files: bl(bd({ length: bi(1), path: bl(bs('a')), 'path.utf-8': pu })) });
    rejects(f(bl(bs('..'))));
    rejects(f(bl(bs('a/b'))));
    rejects(f(bl()));
    expect(parseStrictTorrent(f(bl(bs('ä')))).totalSize).toBe(1);
  });

  it('accepts padding files (BEP 47 attr p) and unicode / private / source keys', () => {
    const t = parseStrictTorrent(makeTorrent(makeInfo({
      name: 'Ünï cødé 日本語 #1 100%',
      files: [{ path: ['dir', 'a b.txt'], length: 20000 }, { path: ['.pad', '12384'], length: 12384 }],
      extra: { private: bi(1), source: bs('x') },
    })));
    expect(t.totalSize).toBe(32384);
    expect(t.name).toBe('Ünï cødé 日本語 #1 100%');
  });

  it('total size is the exact sum and may not exceed MAX_SAFE_INTEGER', () => {
    const pl = 2 ** 40;
    const big = 2n ** 53n; // > MAX_SAFE_INTEGER
    const pieceCount = Number((big + BigInt(pl) - 1n) / BigInt(pl));
    expect(pieceCount).toBeLessThan(1e7);
    rejects(raw({ name: bs('a'), 'piece length': bi(pl), pieces: bs(Buffer.alloc(pieceCount * 20)), length: bi(big) }), /out of range/);
    const files = bl(bd({ length: bi(2 ** 52), path: bl(bs('a')) }), bd({ length: bi(2 ** 52), path: bl(bs('b')) }));
    rejects(raw({ name: bs('a'), 'piece length': bi(pl), pieces: bs(Buffer.alloc(pieceCount * 20)), files }), /out of range/);
  });
});

describe('rebuildTorrent builds the stored file from scratch', () => {
  it('keeps only info (verbatim) plus sanitised announce data; drops every other top-level key', () => {
    const info = makeInfo({ extra: { private: bi(1) } });
    const f = makeTorrent(info, {
      announce: bs('http://127.0.0.1:6969/announce'),
      'announce-list': bl(bl(bs('udp://tracker.example.com:1337/announce')), bl(bs('http://10.0.0.1/a'), bs('https://t2.example.com/announce'))),
      'url-list': bl(bs('http://172.31.250.1/seed')),
      httpseeds: bl(bs('http://172.31.250.1/seed2')),
      nodes: bl(bl(bs('127.0.0.1'), bi(6881))),
      comment: bs('hello'), 'created by': bs('x'), 'creation date': bi(1), encoding: bs('UTF-8'), unknown: bs('zzz'),
    });
    const r = rebuildTorrent(f);
    expect(r.trackers).toEqual(['udp://tracker.example.com:1337/announce', 'https://t2.example.com/announce']);
    const root = decodeStrict(r.file) as DictNode;
    expect(root.entries.map((e) => e.key.toString())).toEqual(['announce', 'announce-list', 'info']);
    const v = dictGet(root, 'info')!;
    expect(r.file.subarray(v.start, v.end).equals(info)).toBe(true);
    expect(sha1hex(r.file.subarray(v.start, v.end))).toBe(r.infohash);
  });

  it('with no usable trackers the file is just {info}', () => {
    const r = rebuildTorrent(makeTorrent(makeInfo(), { announce: bs('http://127.0.0.1/a') }));
    expect(r.file.equals(bd({ info: makeInfo() }))).toBe(true);
  });

  it('is idempotent: rebuilding a rebuilt file gives identical bytes', () => {
    const r = rebuildTorrent(makeTorrent(makeInfo(), { announce: bs('udp://tracker.example.com:1/a') }));
    expect(rebuildTorrent(r.file).file.equals(r.file)).toBe(true);
  });
});

describe('property: stored file info range hashes to the recorded infohash, and parse-torrent agrees', () => {
  const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const names = ['a', 'Big Buck Bunny', 'ünï cødé', '日本語のファイル', 'emoji 🎬', 'x'.repeat(200), 'with space and #%\'', 'dot.dot.'];

  it('300 random valid torrents (single/multi file, unicode, private flag, large piece lists)', async () => {
    const r = rng(12345);
    const pick = <T>(a: T[]): T => a[Math.floor(r() * a.length)]!;
    for (let n = 0; n < 300; n++) {
      const pieceLength = pick([16384, 32768, 262144, 1 << 20, 4 << 20]);
      const multi = r() < 0.5;
      const extra: Record<string, Buffer> = {};
      if (r() < 0.4) extra.private = bi(r() < 0.5 ? 1 : 0);
      if (r() < 0.3) extra.source = bs(pick(names));
      if (r() < 0.2) extra['x-extra'] = bl(bi(1), bs('z'), bd({ k: bi(2) }));
      // up to ~40 000 pieces for the large lists
      const total = r() < 0.1 ? Math.floor(r() * 40000 * pieceLength) + 1 : Math.floor(r() * 50 * pieceLength) + 1;
      let info: Buffer;
      if (multi) {
        const k = 1 + Math.floor(r() * 6);
        const files = Array.from({ length: k }, (_, i) => ({ path: r() < 0.5 ? [pick(names).replace(/[/\\]/g, '_'), `f${i}`] : [`f${i}`], length: 0 }));
        let left = total;
        files.forEach((f, i) => { f.length = i === k - 1 ? left : Math.floor(r() * left); left -= f.length; });
        info = makeInfo({ name: pick(names), pieceLength, files, extra, seed: n });
      } else {
        info = makeInfo({ name: pick(names), pieceLength, length: total, extra, seed: n });
      }
      const upload = makeTorrent(info, {
        ...(r() < 0.7 ? { announce: bs('udp://tracker.example.com:1337/announce') } : {}),
        ...(r() < 0.3 ? { 'url-list': bl(bs('http://evil.example/')) } : {}),
        ...(r() < 0.3 ? { comment: bs(pick(names)) } : {}),
      });
      const rebuilt = rebuildTorrent(upload);
      const root = decodeStrict(rebuilt.file) as DictNode;
      const infoNode = dictGet(root, 'info')!;
      const stored = rebuilt.file.subarray(infoNode.start, infoNode.end);
      expect(sha1hex(stored)).toBe(rebuilt.infohash);
      expect(sha1hex(info)).toBe(rebuilt.infohash);
      expect(rebuilt.totalSize).toBe(total);
      if (n % 10 === 0) expect((await parseTorrent(new Uint8Array(rebuilt.file))).infoHash).toBe(rebuilt.infohash);
    }
  });

  it('buildCanonicalTorrent output always strict-parses', () => {
    const f = buildCanonicalTorrent(makeInfo(), ['udp://a.example.com:1/x', 'https://b.example.com/y']);
    expect(parseStrictTorrent(f).announce).toEqual(['udp://a.example.com:1/x', 'udp://a.example.com:1/x', 'https://b.example.com/y']);
  });
});
