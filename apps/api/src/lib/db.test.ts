import Database from 'better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// api and worker are two processes on one SQLite file (WAL). A DEFERRED transaction that reads first and writes later
// cannot upgrade its read snapshot once the other process has committed: SQLite returns SQLITE_BUSY at once, without
// waiting for busy_timeout (CI saw "database is locked" -> HTTP 500 on POST /api/jobs in 2 ms). BEGIN IMMEDIATE takes
// the write lock up front and does honour busy_timeout, so every transaction in the app must be `.immediate()`.

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
let dir: string | null = null;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

function twoHandles(): [Database.Database, Database.Database] {
  dir = mkdtempSync(join(tmpdir(), 'sbdb-'));
  const file = join(dir, 'db.sqlite');
  const a = new Database(file); a.pragma('busy_timeout = 2000'); a.pragma('journal_mode = WAL');
  a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)'); a.prepare('INSERT INTO t (v) VALUES (0)').run();
  const b = new Database(file); b.pragma('busy_timeout = 2000');
  return [a, b];
}

describe('SQLite transactions between api and worker', () => {
  it('a deferred read-then-write transaction fails with SQLITE_BUSY at once when the other process committed in between', () => {
    const [a, b] = twoHandles();
    const tx = a.transaction(() => {
      a.prepare('SELECT v FROM t WHERE id = 1').get();
      b.prepare('UPDATE t SET v = v + 1 WHERE id = 1').run();   // "the worker" commits meanwhile
      a.prepare('UPDATE t SET v = v + 10 WHERE id = 1').run();
    });
    const t0 = Date.now();
    expect(() => tx()).toThrow(/database is locked|SQLITE_BUSY/);
    expect(Date.now() - t0).toBeLessThan(1000);                 // busy_timeout was not honoured
    a.close(); b.close();
  });

  it('an immediate transaction holds the write lock, so the other writer waits instead of breaking it', () => {
    const [a, b] = twoHandles();
    a.transaction(() => {
      a.prepare('SELECT v FROM t WHERE id = 1').get();
      a.prepare('UPDATE t SET v = v + 10 WHERE id = 1').run();
    }).immediate();
    b.prepare('UPDATE t SET v = v + 1 WHERE id = 1').run();
    expect((a.prepare('SELECT v FROM t WHERE id = 1').get() as { v: number }).v).toBe(11);
    a.close(); b.close();
  });

  it('every db.transaction(...) in the app source is run with .immediate()', () => {
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(p);
      }
    };
    walk(SRC);
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (let i = text.indexOf('.transaction('); i !== -1; i = text.indexOf('.transaction(', i + 1)) {
        let depth = 0; let j = i + '.transaction'.length;
        for (; j < text.length; j++) {
          if (text[j] === '(') depth++;
          else if (text[j] === ')' && --depth === 0) break;
        }
        if (!text.startsWith('.immediate(', j + 1)) offenders.push(`${relative(SRC, f)}:${text.slice(0, i).split('\n').length}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
