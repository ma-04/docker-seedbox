import { describe, expect, it } from 'vitest';
import { openToken, sealToken, TokenError } from './token.js';

const SECRET = 's'.repeat(40);
const NOW = 1_900_000_000;

describe('search result tokens', () => {
  const link = '/jackett/dl/sbmock/?path=QUJD&file=X';

  it('round-trips for the user it was issued to; the payload is not readable', () => {
    const t = sealToken(SECRET, { u: 7, e: NOW + 60, l: link });
    expect(openToken(SECRET, t, 7, NOW)).toMatchObject({ u: 7, l: link });
    expect(Buffer.from(t, 'base64url').toString('latin1')).not.toContain('jackett');
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is bound to the user', () => {
    const t = sealToken(SECRET, { u: 7, e: NOW + 60, l: link });
    expect(() => openToken(SECRET, t, 8, NOW)).toThrow(TokenError);
  });

  it('expires', () => {
    const t = sealToken(SECRET, { u: 7, e: NOW - 1, m: 'magnet:?xt=urn:btih:' + 'a'.repeat(40) });
    expect(() => openToken(SECRET, t, 7, NOW)).toThrow(/expired/);
  });

  it('cannot be forged, altered or replayed under another secret', () => {
    const t = sealToken(SECRET, { u: 7, e: NOW + 60, l: link });
    const raw = Buffer.from(t, 'base64url');
    for (const i of [0, 5, 20, raw.length - 1]) {
      const b = Buffer.from(raw);
      b[i] = b[i]! ^ 1;
      expect(() => openToken(SECRET, b.toString('base64url'), 7, NOW)).toThrow(TokenError);
    }
    expect(() => openToken('x'.repeat(40), t, 7, NOW)).toThrow(TokenError);
    for (const bad of ['', 'not a token!', 'AAAA', 'A'.repeat(20_000)]) expect(() => openToken(SECRET, bad, 7, NOW)).toThrow(TokenError);
  });

  it('a magnet with many trackers stays reasonably small (deflated)', () => {
    const m = 'magnet:?xt=urn:btih:' + 'a'.repeat(40) + Array.from({ length: 40 }, (_, i) => `&tr=udp%3A%2F%2Ftracker${i}.example.org%3A1337%2Fannounce`).join('');
    const t = sealToken(SECRET, { u: 1, e: NOW + 60, m });
    expect(t.length).toBeLessThan(m.length);
    expect(openToken(SECRET, t, 1, NOW).m).toBe(m);
  });
});
