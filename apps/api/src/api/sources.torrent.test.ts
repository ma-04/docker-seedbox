import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeStrict, dictGet, type DictNode } from '../lib/bencode-strict.js';
import { decryptJson } from '../lib/crypto.js';
import { bd, bdRaw, bi, bl, bs, makeInfo, makeTorrent, sha1hex } from '../lib/torrent-fixtures.js';
import { alice, HEX, makeLocalDest, multipartBody, setup } from './testutil.js';

type Env = ReturnType<typeof setup>;
const str = (s: string) => `${Buffer.byteLength(s)}:${s}`;
const INFO = Buffer.concat([Buffer.from('d6:lengthi1000e4:name8:file.bin12:piece lengthi16384e6:pieces20:'), Buffer.alloc(20, 7), Buffer.from('e')]);
const infohashOf = (info: Buffer) => createHash('sha1').update(info).digest('hex');

/** A .torrent with announce data and web seeds around a fixed info dict (keys in sorted order). */
function torrentWith(extra: Record<string, string>): Buffer {
  const entries = { ...extra, info: INFO.toString('latin1') };
  const body = Object.keys(entries).sort().map((k) => str(k) + entries[k]!).join('');
  return Buffer.from(`d${body}e`, 'latin1');
}

const storedSource = (env: Env) => decryptJson<{ magnet?: string; torrentB64?: string }>(
  env.config.appSecret, (env.db.prepare('SELECT source_enc FROM torrents').get() as { source_enc: string }).source_enc);
const rows = (env: Env) => (env.db.prepare('SELECT COUNT(*) n FROM torrents').get() as { n: number }).n;

describe('magnets: the recorded infohash is the single canonical xt', () => {
  const post = async (magnet: string) => {
    const env = setup();
    const dest = await makeLocalDest(env);
    const r = await env.call(alice, 'POST', '/api/jobs', { magnet, destinationId: dest });
    return { env, r };
  };
  const B = 'b'.repeat(40);

  it('rejects two xt values (decoy + real) and stores nothing', async () => {
    for (const m of [`magnet:?xt=urn:btih:${HEX}&xt=urn:btih:${B}`, `magnet:?xt=urn:btih:${HEX}&xt=urn:btih:${HEX}`, `magnet:?xt=urn:btih:${HEX}&xt.1=urn:btih:${B}`, `magnet:?xt=urn:btih:${HEX}&xt=urn:btmh:1220${'a'.repeat(64)}`]) {
      const { env, r } = await post(m);
      expect(r.statusCode, m).toBe(400);
      expect(rows(env)).toBe(0);
    }
  });

  it.each([`urn:btmh:1220${'a'.repeat(64)}`, `urn:sha1:${'a'.repeat(32)}`, `urn:btih:${HEX.slice(0, 39)}`, `urn:btih:${HEX}0`, `urn:btih:${'a'.repeat(31)}1`, 'urn:btih:'])('rejects xt %s', async (xt) => {
    expect((await post(`magnet:?xt=${xt}`)).r.statusCode).toBe(400);
  });

  it('records the hash of the single xt (hex and base32); the stored magnet has exactly that xt', async () => {
    const hex = await post(`magnet:?xt=urn:btih:${HEX.toUpperCase()}&dn=x`);
    expect(hex.r.statusCode).toBe(201);
    expect(hex.r.json().infohash).toBe(HEX);
    expect(storedSource(hex.env).magnet).toBe(`magnet:?xt=urn:btih:${HEX}&dn=x`);
    const b32 = await post('magnet:?xt=urn:btih:YEX6DQDLXISUVHOJ6UM3GNNKPQJWPKEK');
    expect(b32.r.json().infohash).toBe(HEX);
    expect((storedSource(b32.env).magnet!.match(/xt=/g) ?? []).length).toBe(1);
  });
});

describe('.torrent uploads', () => {
  const upload = async (env: Env, dest: number, file: Buffer) => {
    const m = multipartBody({ destinationId: String(dest) }, { name: 'a.torrent', data: file });
    return env.call(alice, 'POST', '/api/jobs', m.payload, { headers: m.headers });
  };

  it('strips url-list, httpseeds, nodes, comment and unsafe trackers but keeps the infohash', async () => {
    const env = setup();
    const dest = await makeLocalDest(env);
    const original = torrentWith({
      announce: str('http://127.0.0.1:6969/announce'),
      'announce-list': `ll${str('http://127.0.0.1:6969/announce')}el${str('udp://tracker.example.com:1337/announce')}${str('http://10.0.0.1/a')}el${str('https://t2.example.com/announce')}ee`,
      'url-list': `l${str('http://172.31.250.1/seed')}e`,
      httpseeds: `l${str('http://172.31.250.1/seed2')}e`,
      nodes: `ll${str('127.0.0.1')}i6881eee`,
      comment: str('hello'),
    });
    const r = await upload(env, dest, original);
    expect(r.statusCode).toBe(201);
    expect(r.json().infohash).toBe(infohashOf(INFO));
    const stored = Buffer.from(storedSource(env).torrentB64!, 'base64');
    const text = stored.toString('latin1');
    for (const gone of ['url-list', 'httpseeds', 'nodes', 'comment', 'hello', '127.0.0.1', '172.31.250.1', '10.0.0.1']) expect(text).not.toContain(gone);
    expect(text).toContain('udp://tracker.example.com:1337/announce');
    expect(text).toContain('https://t2.example.com/announce');
    expect(stored.includes(INFO)).toBe(true);
    const parseTorrent = (await import('parse-torrent')).default;
    expect((await parseTorrent(new Uint8Array(stored))).infoHash).toBe(infohashOf(INFO));
  });

  it('e2e: the recorded infohash equals SHA-1 of the info bytes in the stored source, for several shapes', async () => {
    const env = setup();
    const dest = await makeLocalDest(env);
    const infos = [
      makeInfo({ seed: 1 }),
      makeInfo({ name: 'ünï 日本', seed: 2, files: [{ path: ['a', 'b c.txt'], length: 40000 }, { path: ['d'], length: 5 }], extra: { private: bi(1) } }),
      makeInfo({ seed: 3, length: 16384 * 5000, pieceCount: 5000 }),
    ];
    for (const info of infos) {
      const r = await upload(env, dest, makeTorrent(info, { announce: bs('udp://tracker.example.com:1337/a'), 'url-list': bl(bs('http://evil.example/')) }));
      expect(r.statusCode).toBe(201);
      const hash = r.json().infohash as string;
      const stored = Buffer.from(decryptJson<{ torrentB64: string }>(env.config.appSecret,
        (env.db.prepare('SELECT source_enc FROM torrents WHERE infohash = ?').get(hash) as { source_enc: string }).source_enc).torrentB64, 'base64');
      const root = decodeStrict(stored) as DictNode;
      const v = dictGet(root, 'info')!;
      expect(sha1hex(stored.subarray(v.start, v.end))).toBe(hash);
      expect(hash).toBe(sha1hex(info));
    }
  });

  // The reviewer's cases. Before the fix these were accepted with the decoy's infohash / declared size.
  it('(a) two top-level info dicts -> 400, nothing stored', async () => {
    const env = setup();
    const dest = await makeLocalDest(env);
    const decoy = makeInfo({ length: 10, seed: 1 });
    const real = makeInfo({ length: 9_000_000_000, pieceLength: 4 << 20, seed: 2 });
    expect((await upload(env, dest, bdRaw(['info', decoy], ['info', real]))).statusCode).toBe(400);
    expect(rows(env)).toBe(0);
  });

  it('(b) unsorted keys inside info -> 400', async () => {
    const env = setup();
    const dest = await makeLocalDest(env);
    const info = bdRaw(['name', bs('a')], ['length', bi(1)], ['piece length', bi(16384)], ['pieces', bs(Buffer.alloc(20, 1))]);
    expect((await upload(env, dest, makeTorrent(info))).statusCode).toBe(400);
    expect(rows(env)).toBe(0);
  });

  it('duplicate keys at any depth, leading-zero ints, trailing junk, deep nesting, v2/hybrid, size-inconsistent pieces -> 400', async () => {
    const env = setup();
    const dest = await makeLocalDest(env);
    const good = makeInfo();
    const bad: Buffer[] = [
      bdRaw(['comment', bs('a')], ['comment', bs('b')], ['info', good]),
      makeTorrent(bdRaw(['length', bi(1)], ['length', bi(2)], ['name', bs('a')], ['piece length', bi(16384)], ['pieces', bs(Buffer.alloc(20))])),
      makeTorrent(good, { x: Buffer.from('i007e') }),
      Buffer.concat([makeTorrent(good), Buffer.from('trailing')]),
      makeTorrent(good, { x: Buffer.from('l'.repeat(50) + 'e'.repeat(50)) }),
      makeTorrent(good, { 'piece layers': bd({}) }),
      makeTorrent(makeInfo({ extra: { 'meta version': bi(2) } })),
      makeTorrent(makeInfo({ length: 50_000_000_000, pieceCount: 1 })),
    ];
    for (const b of bad) expect((await upload(env, dest, b)).statusCode).toBe(400);
    expect(rows(env)).toBe(0);
  });

  it('the size limit applies to the declared and verified size', async () => {
    const env = setup();
    const dest = await makeLocalDest(env);
    env.db.prepare("INSERT INTO settings (key, value_json) VALUES ('limits.maxTorrentBytes', '1000000')").run();
    expect((await upload(env, dest, makeTorrent(makeInfo({ length: 16384 * 100, pieceCount: 100 })))).statusCode).toBe(413);
    expect((await upload(env, dest, makeTorrent(makeInfo({ length: 5000 })))).statusCode).toBe(201);
  });
});
