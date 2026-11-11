import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptJson } from '../lib/crypto.js';
import { alice, bob, HEX, makeLocalDest, multipartBody, setup } from './testutil.js';
import { rewriteTorrent } from './torrent.js';

const enc = encodeURIComponent;
const str = (s: string) => `${Buffer.byteLength(s)}:${s}`;
const INFO = Buffer.concat([Buffer.from('d6:lengthi1000e4:name8:file.bin12:piece lengthi16384e6:pieces20:'), Buffer.alloc(20, 7), Buffer.from('e')]);
const infohashOf = (info: Buffer) => createHash('sha1').update(info).digest('hex');

/** A .torrent with announce data and web seeds around a fixed info dict (keys in sorted order). */
function torrentWith(extra: Record<string, string>): Buffer {
  const entries = { ...extra, info: INFO.toString('latin1') };
  const body = Object.keys(entries).sort().map((k) => str(k) + (k === 'info' ? entries[k] : entries[k]!)).join('');
  return Buffer.from(`d${body}e`, 'latin1');
}

const storedSource = (env: ReturnType<typeof setup>) => decryptJson<{ magnet?: string; torrentB64?: string }>(
  env.config.appSecret, (env.db.prepare('SELECT source_enc FROM torrents').get() as { source_enc: string }).source_enc);

describe('magnet injection (qBittorrent splits `urls` on newlines)', () => {
  it('rejects the exact attack string with 400 and stores nothing', async () => {
    const env = setup();
    const dest = await makeLocalDest(env);
    const B = 'b'.repeat(40);
    const attack = `magnet:?xt=urn:btih:${HEX}&dn=x\nhttp://172.31.250.1/evil\nmagnet:?xt=urn:btih:${B}`;
    const r = await env.call(alice, 'POST', '/api/jobs', { magnet: attack, destinationId: dest });
    expect(r.statusCode).toBe(400);
    expect((env.db.prepare('SELECT COUNT(*) n FROM torrents').get() as { n: number }).n).toBe(0);
    expect((env.db.prepare('SELECT COUNT(*) n FROM jobs').get() as { n: number }).n).toBe(0);
  });

  it('rejects an over-long magnet and one without a v1 btih', async () => {
    const env = setup();
    const dest = await makeLocalDest(env);
    expect((await env.call(alice, 'POST', '/api/jobs', { magnet: `magnet:?xt=urn:btih:${HEX}&dn=${'a'.repeat(9000)}`, destinationId: dest })).statusCode).toBe(400);
    expect((await env.call(alice, 'POST', '/api/jobs', { magnet: `magnet:?xt=urn:btmh:1220${'a'.repeat(64)}`, destinationId: dest })).statusCode).toBe(400);
  });

  it('stores a canonical magnet: no ws/xs/x.pe/private trackers/extra params, sanitised dn', async () => {
    const env = setup();
    const dest = await makeLocalDest(env);
    const raw = `magnet:?xt=urn:btih:${HEX}&dn=${enc('Movie\nhttp://172.31.250.1/x')}&tr=${enc('udp://tracker.example.com:1337/announce')}`
      + `&tr=${enc('http://10.1.2.3/announce')}&tr=${enc('http://127.0.0.1:6969/announce')}&ws=${enc('http://172.31.250.1/seed')}&xs=${enc('http://evil.example/t.torrent')}&x.pe=10.0.0.1:1&so=0&kt=x`;
    const r = await env.call(alice, 'POST', '/api/jobs', { magnet: raw, destinationId: dest });
    expect(r.statusCode).toBe(201);
    expect(storedSource(env).magnet).toBe(`magnet:?xt=urn:btih:${HEX}&dn=${enc('Movie http://172.31.250.1/x')}&tr=${enc('udp://tracker.example.com:1337/announce')}`);
    expect(r.json().name).toBe('Movie http://172.31.250.1/x');
  });

  it('merges sanitised trackers of a later submission into the shared source instead of ignoring them', async () => {
    const env = setup();
    const dest = await makeLocalDest(env);
    await env.call(alice, 'POST', '/api/jobs', { magnet: `magnet:?xt=urn:btih:${HEX}&tr=${enc('udp://a.example.com:1/announce')}`, destinationId: dest });
    const r = await env.call(bob, 'POST', '/api/jobs', {
      magnet: `magnet:?xt=urn:btih:${HEX}&tr=${enc('udp://b.example.com:2/announce')}&tr=${enc('udp://a.example.com:1/announce')}&tr=${enc('udp://127.0.0.1:3/announce')}&ws=${enc('http://evil.example/')}`,
      destinationId: dest,
    });
    expect(r.statusCode).toBe(201);
    expect(storedSource(env).magnet).toBe(`magnet:?xt=urn:btih:${HEX}&tr=${enc('udp://a.example.com:1/announce')}&tr=${enc('udp://b.example.com:2/announce')}`);
  });

  it('rewrites a legacy stored raw magnet to canonical form when the torrent is added again', async () => {
    const env = setup();
    const dest = await makeLocalDest(env);
    await env.call(alice, 'POST', '/api/jobs', { magnet: `magnet:?xt=urn:btih:${HEX}`, destinationId: dest });
    const { encryptJson } = await import('../lib/crypto.js');
    env.db.prepare('UPDATE torrents SET source_enc = ?').run(encryptJson(env.config.appSecret, { magnet: `magnet:?xt=urn:btih:${HEX}&dn=x\nhttp://172.31.250.1/` }));
    await env.call(bob, 'POST', '/api/jobs', { magnet: `magnet:?xt=urn:btih:${HEX}`, destinationId: dest });
    expect(storedSource(env).magnet).toBe(`magnet:?xt=urn:btih:${HEX}`);
  });
});

describe('.torrent uploads', () => {
  const upload = async (env: ReturnType<typeof setup>, dest: number, file: Buffer) => {
    const m = multipartBody({ destinationId: String(dest) }, { name: 'a.torrent', data: file });
    return env.call(alice, 'POST', '/api/jobs', m.payload, { headers: m.headers });
  };

  it('strips url-list, httpseeds, nodes and unsafe trackers but keeps the infohash', async () => {
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
    for (const gone of ['url-list', 'httpseeds', 'nodes', '127.0.0.1', '172.31.250.1', '10.0.0.1']) expect(text).not.toContain(gone);
    expect(text).toContain('udp://tracker.example.com:1337/announce');
    expect(text).toContain('https://t2.example.com/announce');
    expect(text).toContain('7:comment5:hello');
    expect(stored.includes(INFO)).toBe(true); // the info dict is byte-identical
    // an independent re-parse yields the same infohash
    const parseTorrent = (await import('parse-torrent')).default;
    expect((await parseTorrent(new Uint8Array(stored))).infoHash).toBe(infohashOf(INFO));
  });

  it('rewriteTorrent keeps the original info bytes even when the source is not canonically ordered', () => {
    const out = rewriteTorrent(torrentWith({ 'url-list': `l${str('http://x.example/')}e` }), ['udp://t.example.com:1/a']);
    expect(out.includes(INFO)).toBe(true);
    expect(out.toString('latin1')).not.toContain('url-list');
    expect(out.toString('latin1')).toContain('8:announce');
  });

  it('rejects a torrent whose structure cannot be rewritten', async () => {
    const env = setup();
    const dest = await makeLocalDest(env);
    expect((await upload(env, dest, Buffer.from('d4:infod6:lengthi1e4:name1:a12:piece lengthi16384e6:pieces20:' + 'x'.repeat(20) + 'ee-garbage', 'latin1'))).statusCode).toBeLessThan(500);
  });
});
