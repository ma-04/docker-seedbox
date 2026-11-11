import { describe, expect, it } from 'vitest';
import { MAX_MAGNET_LENGTH, parseIncoming, parseMagnet } from './magnet';

const HEX = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';
const B32 = 'MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U';

describe('parseMagnet', () => {
  it('accepts a 40-hex info hash and decodes dn', () => {
    const r = parseMagnet(`magnet:?xt=urn:btih:${HEX}&dn=Big%20Buck+Bunny%20%26%20Co&tr=udp%3A%2F%2Ftracker.example.com%3A80`);
    expect(r).toMatchObject({ ok: true, magnet: { infohash: HEX, name: 'Big Buck Bunny & Co' } });
  });
  it('accepts a 32-char base32 info hash and a magnet without dn', () => {
    const r = parseMagnet(`magnet:?xt=urn:btih:${B32}`);
    expect(r).toMatchObject({ ok: true, magnet: { infohash: B32, name: null } });
  });
  it('keeps the exact uri (trimmed)', () => {
    const uri = `magnet:?xt=urn:btih:${HEX}&dn=a&tr=x`;
    expect(parseMagnet(`  ${uri}\n`)).toMatchObject({ ok: true, magnet: { uri } });
  });
  it('rejects more than one xt (the API only accepts a single v1 btih)', () => {
    expect(parseMagnet(`magnet:?xt=urn:sha1:abc&xt=urn:btih:${HEX}`).ok).toBe(false);
    expect(parseMagnet(`magnet:?xt=urn:btih:${HEX}&xt=urn:btih:${'b'.repeat(40)}`).ok).toBe(false);
  });
  it.each([
    ['javascript:alert(1)'], ['data:text/html,<script>1</script>'], ['http://example.com/?xt=urn:btih:' + HEX],
    ['magnet:?dn=nothing'], [`magnet:?xt=urn:btih:${HEX.slice(1)}`], [`magnet:?xt=urn:btih:${HEX}zz`], [`magnet:?xt=urn:btmh:${HEX}`],
    [''], [null], [undefined], [`magnet:?xt=urn:btih:${HEX}\u0000`],
  ])('rejects %s', (input) => {
    expect(parseMagnet(input as string).ok).toBe(false);
  });
  it('rejects over-long input', () => {
    const long = `magnet:?xt=urn:btih:${HEX}&dn=${'a'.repeat(MAX_MAGNET_LENGTH)}`;
    expect(parseMagnet(long)).toMatchObject({ ok: false });
    expect(parseMagnet(`magnet:?xt=urn:btih:${HEX}&dn=${'a'.repeat(1000)}`).ok).toBe(true);
  });
  it('rejects the newline injection payload and any interior whitespace/control character', () => {
    expect(parseMagnet(`magnet:?xt=urn:btih:${HEX}&dn=x\nhttp://172.31.250.1/evil\nmagnet:?xt=urn:btih:${'b'.repeat(40)}`).ok).toBe(false);
    for (const c of ['\n', '\r', '\t', ' ', '\u0000', '\u007f', '\u0085', '\u00a0', '\u2028', '\u2029', '\u3000', '\ufeff']) {
      expect(parseMagnet(`magnet:?xt=urn:btih:${HEX}&dn=a${c}b`)).toMatchObject({ ok: false });
    }
  });
  it('measures the 8 KB limit in bytes, like the API', () => {
    const base = `magnet:?xt=urn:btih:${HEX}&dn=`;
    expect(parseMagnet(base + 'a'.repeat(MAX_MAGNET_LENGTH - base.length)).ok).toBe(true);
    expect(parseMagnet(base + 'a'.repeat(MAX_MAGNET_LENGTH - base.length + 1)).ok).toBe(false);
    expect(parseMagnet(base + '\u00e9'.repeat(MAX_MAGNET_LENGTH / 2)).ok).toBe(false);
  });
  it('rejects double-encoded input', () => {
    expect(parseMagnet(encodeURIComponent(`magnet:?xt=urn:btih:${HEX}`)).ok).toBe(false);
    expect(parseMagnet(`magnet:?xt=urn%253Abtih%253A${HEX}`).ok).toBe(false);
  });
  it('truncates very long names', () => {
    const r = parseMagnet(`magnet:?xt=urn:btih:${HEX}&dn=${'n'.repeat(500)}`);
    expect(r.ok && r.magnet.name!.length).toBeLessThan(210);
  });
});

describe('parseIncoming', () => {
  const magnet = `magnet:?xt=urn:btih:${HEX}&dn=x&tr=http%3A%2F%2Ft.example%2Fa%3Fb%3D1`;
  it('reads a single-encoded magnet and destinationId', () => {
    const r = parseIncoming(`?magnet=${encodeURIComponent(magnet)}&destinationId=7`);
    expect(r).toMatchObject({ error: null, destinationId: 7, magnet: { uri: magnet } });
  });
  it('reports an error for missing or invalid values and ignores a bad destinationId', () => {
    expect(parseIncoming('').error).toBeTruthy();
    expect(parseIncoming('?magnet=javascript%3Aalert(1)').magnet).toBeNull();
    expect(parseIncoming(`?magnet=${encodeURIComponent(magnet)}&destinationId=abc`).destinationId).toBeNull();
  });
});
