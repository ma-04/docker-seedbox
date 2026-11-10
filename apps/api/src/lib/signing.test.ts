import { describe, expect, it } from 'vitest';
import { normalizePath, sign, signedUrl, verify } from './signing.js';

const key = 'test-signing-key';
const vectors: [string, number, string][] = [
  ['/alice/Big Buck Bunny/video.mp4', 1900000000, '88fb761b1385669729ba3b8e81cf0a56d34c86b2612afb56a329cc2879293fe6'],
  ["/bob/ünï cødé #1 100%/it's a file.txt", 0, '8836dcec3058dac1cca8afa96bb92c34eebab3390eeeb9fb11587d6d5cf3dd3c'],
  ['/a/b.bin', 1, 'd8e48a68228acd72c96b9a950ccf895a27a2c27117ae0c61629c99b29a915a0e'],
];

describe('signing', () => {
  it('matches the documented test vectors', () => {
    for (const [p, exp, sig] of vectors) expect(sign(key, p, exp)).toBe(sig);
  });
  it('verifies, expires and rejects tampering', () => {
    expect(verify(key, vectors[0]![0], '1900000000', vectors[0]![2], 1_800_000_000)).toBe('ok');
    expect(verify(key, vectors[1]![0], '0', vectors[1]![2])).toBe('ok');
    expect(verify(key, vectors[2]![0], '1', vectors[2]![2])).toBe('expired');
    expect(verify(key, '/a/c.bin', '1', vectors[2]![2])).toBe('bad-signature');
    expect(verify(key, '/a/b.bin', '0', vectors[2]![2])).toBe('bad-signature');
    expect(verify(key, '/a/../b.bin', '0', sign(key, '/a/../b.bin', 0))).toBe('bad-signature');
  });
  it('normalizes paths', () => {
    expect(normalizePath('/a/b')).toBe('/a/b');
    for (const bad of ['a/b', '/a//b', '/a/./b', '/a/../b', '/', '']) expect(normalizePath(bad)).toBeNull();
  });
  it('builds encoded urls that round-trip', () => {
    const u = new URL(signedUrl('https://x.test/', key, vectors[1]![0], 0, '/dl'));
    expect(u.pathname.startsWith('/dl/bob/')).toBe(true);
    const path = decodeURIComponent(u.pathname.slice('/dl'.length));
    expect(verify(key, path, u.searchParams.get('exp')!, u.searchParams.get('sig')!)).toBe('ok');
  });
});
