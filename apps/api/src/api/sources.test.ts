import { describe, expect, it } from 'vitest';
import { decryptJson } from '../lib/crypto.js';
import { alice, bob, HEX, makeLocalDest, setup } from './testutil.js';

const enc = encodeURIComponent;

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

