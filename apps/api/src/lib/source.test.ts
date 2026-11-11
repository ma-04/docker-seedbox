import { describe, expect, it } from 'vitest';
import { canonicalizeMagnet, MAX_MAGNET_BYTES, mergeTrackers, normalizeInfohash, sanitiseTracker, SourceError } from './source.js';

const HEX = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';
const B32 = 'YEX6DQDLXISUVHOJ6UM3GNNKPQJWPKEK';
const enc = encodeURIComponent;

describe('canonicalizeMagnet', () => {
  it('rejects the newline injection payload (raw LF/CR anywhere)', () => {
    const attack = `magnet:?xt=urn:btih:${HEX}&dn=x\nhttp://172.31.250.1/evil\nmagnet:?xt=urn:btih:${'b'.repeat(40)}`;
    expect(() => canonicalizeMagnet(attack)).toThrow(SourceError);
    expect(() => canonicalizeMagnet(attack.replace(/\n/g, '\r\n'))).toThrow(SourceError);
  });
  it.each(['\n', '\r', '\t', ' ', '\u0000', '\u007f', '\u0085', '\u00a0', '\u2028', '\u2029', '\u3000', '\ufeff'])('rejects interior %j', (c) => {
    expect(() => canonicalizeMagnet(`magnet:?xt=urn:btih:${HEX}&dn=a${c}b`)).toThrow(/whitespace or control/);
  });
  it('rejects over 8 KB (bytes) and accepts exactly the limit', () => {
    const base = `magnet:?xt=urn:btih:${HEX}&dn=`;
    expect(() => canonicalizeMagnet(base + 'a'.repeat(MAX_MAGNET_BYTES))).toThrow(/too long/);
    expect(() => canonicalizeMagnet(base + 'a'.repeat(MAX_MAGNET_BYTES - base.length))).not.toThrow();
    expect(() => canonicalizeMagnet(base + '\u00e9'.repeat(MAX_MAGNET_BYTES / 2))).toThrow(/too long/); // bytes, not chars
  });
  it.each(['http://x', 'magnet:?dn=x', `magnet:?xt=urn:btmh:1220${'a'.repeat(64)}`, `magnet:?xt=urn:btih:${HEX.slice(1)}`, `magnet:?xt=urn:btih:${HEX}zz`, ''])('rejects %s', (m) => {
    expect(() => canonicalizeMagnet(m)).toThrow(SourceError);
  });
  it('rebuilds from parsed fields only: drops ws=, xs=, as=, x.pe=, so=, kt=, unknown keys and unsafe trackers', () => {
    const raw = `magnet:?xt=urn:btih:${B32}&xt=urn:btmh:1220${'a'.repeat(64)}&dn=${enc('Big Buck Bunny')}`
      + `&tr=${enc('udp://tracker.example.com:1337/announce')}&tr=${enc('http://127.0.0.1:6969/announce')}&tr=${enc('https://10.0.0.5/a')}`
      + `&tr=${enc('http://172.31.250.1/x')}&tr=${enc('udp://tracker')}&tr=${enc('ftp://tracker.example.com/x')}&tr=${enc('https://u:p@tracker.example.com/a')}`
      + `&tr=${enc('wss://tracker.example.org/')}&ws=${enc('http://169.254.169.254/latest')}&xs=${enc('http://evil.example/x.torrent')}`
      + `&as=${enc('http://evil.example/')}&x.pe=10.0.0.1:6881&so=0,1&kt=a+b&foo=bar`;
    const c = canonicalizeMagnet(raw);
    expect(c.infohash).toBe(HEX);
    expect(c.magnet).toBe(`magnet:?xt=urn:btih:${HEX}&dn=Big%20Buck%20Bunny&tr=${enc('udp://tracker.example.com:1337/announce')}&tr=${enc('wss://tracker.example.org/')}`);
    for (const bad of ['ws=', 'xs=', 'as=', 'x.pe', 'so=', 'kt=', 'foo', '127.0.0.1', '10.0.0.5', '172.31', '169.254', 'btmh']) expect(c.magnet).not.toContain(bad);
  });
  it('sanitises dn (encoded newlines/controls become spaces, 255 byte cap) so the rebuilt string has no raw control characters', () => {
    const c = canonicalizeMagnet(`magnet:?xt=urn:btih:${HEX}&dn=${enc('a\nhttp://172.31.250.1/x\r\nb\u202e')}`);
    expect(c.name).toBe('a http://172.31.250.1/x b');
    expect(c.magnet).not.toMatch(/[\s\u0000-\u001f]/);
    const long = canonicalizeMagnet(`magnet:?xt=urn:btih:${HEX}&dn=${enc('\u00e9'.repeat(400))}`);
    expect(Buffer.byteLength(long.name!)).toBeLessThanOrEqual(255);
  });
  it('caps trackers at 50 and dedupes', () => {
    const many = Array.from({ length: 80 }, (_, i) => `&tr=${enc(`udp://t${i}.example.com:80/a`)}`).join('') + `&tr=${enc('udp://t0.example.com:80/a')}`;
    const c = canonicalizeMagnet(`magnet:?xt=urn:btih:${HEX}${many}`);
    expect(c.trackers).toHaveLength(50);
    expect(new Set(c.trackers).size).toBe(50);
  });
  it('is idempotent', () => {
    const c = canonicalizeMagnet(`magnet:?xt=urn:btih:${HEX}&dn=a%20b&tr=${enc('udp://t.example.com:1/a?pass=1')}`);
    expect(canonicalizeMagnet(c.magnet).magnet).toBe(c.magnet);
  });
});

describe('sanitiseTracker', () => {
  it.each(['udp://tracker.example.com:6969', 'http://t.example.com/announce', 'https://t.example.com/a?passkey=abc', 'ws://t.example.com', 'wss://t.example.com:443', 'udp://93.184.216.34:80', 'udp://[2606:4700::1111]:80'])('keeps %s', (t) => {
    expect(sanitiseTracker(t)).toBeTruthy();
  });
  it.each([
    'udp://127.0.0.1:80', 'http://localhost/a', 'http://[::1]/a', 'udp://[::ffff:127.0.0.1]:80', 'http://169.254.169.254/', 'http://100.64.0.1/', 'http://[fd00::1]/', 'http://2130706433/',
    'udp://2130706433:80', 'udp://0x7f.1:80', 'http://printer.local/', 'http://tracker/', 'ftp://t.example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:pw@t.example.com/',
    'http://t.example.com\\@127.0.0.1/', 'http://t.example.com/a b', 'not a url', 'http://a.example.com/\nhttp://127.0.0.1/',
  ])('drops %j', (t) => { expect(sanitiseTracker(t)).toBeNull(); });
});

describe('misc', () => {
  it('normalizeInfohash handles hex and base32', () => { expect(normalizeInfohash(B32)).toBe(HEX); expect(normalizeInfohash(HEX.toUpperCase())).toBe(HEX); expect(normalizeInfohash('zz')).toBeNull(); });
  it('mergeTrackers unions in order and re-sanitises', () => {
    expect(mergeTrackers(['udp://a.example.com:1/'], ['udp://b.example.com:1/', 'udp://a.example.com:1/', 'http://127.0.0.1/'])).toEqual(['udp://a.example.com:1/', 'udp://b.example.com:1/']);
  });
});
