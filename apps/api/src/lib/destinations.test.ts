import { describe, expect, it } from 'vitest';
import { jobDirName, jobRemoteDir, MAX_SEGMENT_BYTES, safeSegment, truncateUtf8, userDirName } from './destinations.js';
import { userSlug } from './types.js';

const shared = { owner_user_id: null };
const owned = { owner_user_id: 7 };
const H = 'abcdef0123456789abcdef0123456789abcdef01';

describe('safeSegment', () => {
  it('strips separators, control chars, leading dots and trailing dots/spaces', () => {
    expect(safeSegment('a/b\\c\u0000d\ne')).toBe('a_b_c_d_e');
    expect(safeSegment('..')).toBe('_');
    expect(safeSegment('..hidden')).toBe('_hidden');
    expect(safeSegment('name. . ')).toBe('name');
    expect(safeSegment('   ')).toBe('untitled');
    expect(safeSegment('')).toBe('untitled');
  });

  it('truncates by UTF-8 bytes on a code-point boundary (CJK, emoji, no split surrogates)', () => {
    const cjk = '日本語'.repeat(100); // 3 bytes each
    const out = safeSegment(cjk);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(MAX_SEGMENT_BYTES);
    expect(out).toBe(cjk.slice(0, 60)); // 60 * 3 = 180
    const emoji = '😀'.repeat(100); // 4 bytes, 2 UTF-16 units
    const e = safeSegment(emoji);
    expect(Buffer.byteLength(e)).toBeLessThanOrEqual(MAX_SEGMENT_BYTES);
    expect(Buffer.from(e).toString('utf8')).toBe(e); // round-trips: nothing was cut in half
    expect(e).not.toMatch(/�/);
    expect(truncateUtf8('aé', 2)).toBe('a'); // é is 2 bytes, only 1 left
  });

  it('replaces lone surrogates', () => {
    expect(safeSegment('a\ud83dz')).toBe('a_z');
  });
});

describe('path traversal', () => {
  it.each([' ..', '..  ', '. .', '../../data', '\u202e..', '.', ' . ', '...'])('name %j never yields a dot segment', (n) => {
    const seg = safeSegment(n);
    expect(['.', '..', '']).not.toContain(seg);
    expect(seg).not.toMatch(/[\\/]/);
    const dir = jobRemoteDir(shared, { id: 1, username: 'u' }, H, n);
    for (const part of dir.split('/')) expect(['.', '..', '']).not.toContain(part);
  });
  it('username .. cannot yield a dot directory', () => {
    expect(userSlug('..')).toBe('_');
    expect(userDirName({ id: 3, username: '..' })).toBe('_-3');
    expect(jobRemoteDir(shared, { id: 3, username: '..' }, H, 'x').split('/')[0]).toBe('_-3');
  });
});

describe('userSlug / user directory', () => {
  it('slug stays lossy, the directory is made unique by the user id', () => {
    expect(userSlug('Bob')).toBe(userSlug('bob'));
    expect(userSlug('a b')).toBe(userSlug('a_b'));
    expect(userDirName({ id: 1, username: 'Bob' })).toBe('bob-1');
    expect(userDirName({ id: 2, username: 'bob' })).toBe('bob-2');
    expect(userDirName({ id: 3, username: 'a b' })).not.toBe(userDirName({ id: 4, username: 'a_b' }));
  });
  it('is bounded and never empty', () => {
    expect(userSlug('x'.repeat(500)).length).toBe(64);
    expect(userSlug('')).toBe('user');
  });
});

describe('jobRemoteDir', () => {
  it('appends the first 8 hex of the infohash so same-named torrents never share a folder', () => {
    expect(jobRemoteDir(owned, { id: 5, username: 'u' }, H, 'Movie')).toBe('Movie [abcdef01]');
    expect(jobRemoteDir(owned, { id: 5, username: 'u' }, 'f'.repeat(40), 'Movie')).toBe('Movie [ffffffff]');
  });
  it('shared destinations: <slug>-<userId>/<name> [<8 hex>]', () => {
    expect(jobRemoteDir(shared, { id: 12, username: 'Alice B' }, H, 'Movie')).toBe('alice_b-12/Movie [abcdef01]');
  });
  it('the whole directory name stays within the byte budget, including the suffix', () => {
    const dir = jobDirName(H, '字'.repeat(400));
    expect(Buffer.byteLength(dir)).toBeLessThanOrEqual(MAX_SEGMENT_BYTES);
    expect(dir.endsWith(' [abcdef01]')).toBe(true);
  });
  it('a hostile name cannot add path segments', () => {
    const dir = jobRemoteDir(owned, { id: 1, username: 'u' }, H, '../../etc/passwd');
    expect(dir.split('/')).toHaveLength(1);
    expect(dir.startsWith('.')).toBe(false);
  });
});
