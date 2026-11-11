import { expect, test } from '@playwright/test';
import { assertFolderShape, assertRecordedFolder, assertRunPrefix, runFolderFor, shellQuote, userDirName } from './guards';

// Unit-style tests of the delete guards. They need no credentials and no browser:
//   npx playwright test -c playwright.live.config.ts 00-guards
const H = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';
const RUN = 'r26111104590ab1';

test.describe('00. delete guards', () => {
  test('userDirName matches the app (docs/architecture.md example)', () => {
    expect(userDirName({ id: 12, username: 'Alice B' })).toBe('alice_b-12');
    expect(userDirName({ id: 3, username: '..x' })).toBe('_x-3');
  });

  test('runFolderFor builds <userDir>/<name> [<hash8>] and refuses unusual names', () => {
    expect(runFolderFor({ id: 2, username: 'tester' }, H, 'debian-12.5.0-amd64-netinst.iso')).toBe('tester-2/debian-12.5.0-amd64-netinst.iso [c12fe1c0]');
    for (const bad of ['', '..', '.', 'a/b', 'a b', 'x*', 'ünï', "it's", 'a\nb']) expect(() => runFolderFor({ id: 2, username: 't' }, H, bad), bad).toThrow();
    expect(() => runFolderFor({ id: 2, username: 't' }, 'nothex', 'a.iso')).toThrow();
  });

  test('assertRecordedFolder: only exactly recorded folders pass', () => {
    const rec = ['tester-2/a.iso [c12fe1c0]', 'tester2-3/a.iso [c12fe1c0]'];
    expect(assertRecordedFolder(rec[0]!, rec)).toBe(rec[0]);
    // another user's copy of the same ISO, a wildcard, a parent, traversal, an empty record list
    for (const bad of ['other-9/a.iso [c12fe1c0]', 'tester-2/a.iso [*]', 'tester-2', 'tester-2/../x/a.iso [c12fe1c0]', '*/a.iso [c12fe1c0]', 'tester-2/a.iso [c12fe1c0]/..', '', '/', 'tester-2/a.iso [c12fe1c0] ']) {
      expect(() => assertRecordedFolder(bad, rec), bad).toThrow();
    }
    expect(() => assertRecordedFolder(rec[0]!, [])).toThrow(/not recorded/);
  });

  test('assertFolderShape rejects globs, brackets elsewhere, backslashes and traversal', () => {
    for (const bad of ['a-1/b [c12fe1c0]/c', 'a-1/b[x] [c12fe1c0]', 'a-1/b\\c [c12fe1c0]', '../a-1/b [c12fe1c0]', 'a-1/?? [c12fe1c0]']) expect(() => assertFolderShape(bad), bad).toThrow();
  });

  test('assertRunPrefix: exactly <base>/<run-id>, nothing broader', () => {
    expect(assertRunPrefix(`seedbox-test/${RUN}`, RUN, 'seedbox-test')).toBe(`seedbox-test/${RUN}`);
    for (const bad of ['seedbox-test', 'seedbox-test/', `seedbox-test/${RUN}/`, `seedbox-test/${RUN}/x`, `seedbox-test/*`, '', '/', `other/${RUN}`, `seedbox-test/../${RUN}`]) {
      expect(() => assertRunPrefix(bad, RUN, 'seedbox-test'), bad).toThrow();
    }
    expect(() => assertRunPrefix('x/bad', 'bad', 'x')).toThrow(/run id/);
    expect(() => assertRunPrefix(`/${RUN}`, RUN, '')).toThrow(/base/);
    expect(() => assertRunPrefix(`../${RUN}`, RUN, '..')).toThrow(/base/);
  });

  test('shellQuote survives quotes and spaces', () => {
    expect(shellQuote("a b [c]'; rm -rf /")).toBe(`'a b [c]'\\''; rm -rf /'`);
  });
});
