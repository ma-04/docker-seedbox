import { describe, expect, it } from 'vitest';
import { canonicalPath, sign, verify } from '../src/signing';
import { KEY } from './helpers';

const vectors: [string, string, string][] = [
  ['/alice/Big Buck Bunny/video.mp4', '1900000000', '88fb761b1385669729ba3b8e81cf0a56d34c86b2612afb56a329cc2879293fe6'],
  ["/bob/ünï cødé #1 100%/it's a file.txt", '0', '8836dcec3058dac1cca8afa96bb92c34eebab3390eeeb9fb11587d6d5cf3dd3c'],
  ['/a/b.bin', '1', 'd8e48a68228acd72c96b9a950ccf895a27a2c27117ae0c61629c99b29a915a0e'],
];

describe('signing vectors', () => {
  it.each(vectors)('signs %s', async (path, exp, sig) => {
    expect(await sign(KEY, path, exp)).toBe(sig);
  });
  it('verifies vectors (third is expired)', async () => {
    expect(await verify(KEY, vectors[0]![0], '1900000000', vectors[0]![2], 1_800_000_000)).toBe('ok');
    expect(await verify(KEY, vectors[1]![0], '0', vectors[1]![2])).toBe('ok');
    expect(await verify(KEY, vectors[2]![0], '1', vectors[2]![2], 1_800_000_000)).toBe('expired');
  });
  it('rejects tampering, uppercase sig, bad exp', async () => {
    const [p, e, s] = vectors[0]!;
    expect(await verify(KEY, p + 'x', e, s, 1)).toBe('bad-signature');
    expect(await verify(KEY, p, '1900000001', s, 1)).toBe('bad-signature');
    expect(await verify(KEY, p, e, s.toUpperCase(), 1)).toBe('bad-signature');
    expect(await verify(KEY, p, '1234567890123', s, 1)).toBe('bad-signature');
    expect(await verify(KEY, p, null, s)).toBe('bad-signature');
    expect(await verify(KEY, p, e, null)).toBe('bad-signature');
  });
});

describe('canonicalPath', () => {
  it('decodes per segment', () => {
    expect(canonicalPath('/bob/%C3%BCn%C3%AF%20c%23%25%27/x%20y')).toBe("/bob/ünï c#%'/x y");
  });
  it.each(['/', '', '/a/', '//a', '/a//b', '/a/./b', '/a/../b', '/a/%2e%2e/b', '/a/%2E/b', '/a%2Fb', '/a/%5Cb', '/a\\b', '/a/%00', '/a/%zz', '/a/%E0%A4%A'])('rejects %s', (p) => {
    expect(canonicalPath(p)).toBeNull();
  });
});
