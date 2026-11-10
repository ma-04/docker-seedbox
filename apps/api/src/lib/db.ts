import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

/** Open (and migrate) the database. Pass ':memory:' in tests. Safe to call from api and worker concurrently. */
export function openDb(path: string, migrationsDir = MIGRATIONS_DIR): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  // busy_timeout first: switching to WAL takes a lock, and api + worker open the file concurrently.
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db, migrationsDir);
  return db;
}

function migrate(db: Db, dir: string): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  for (const f of files) {
    // IMMEDIATE takes the write lock first, so two processes booting together cannot both apply a migration.
    db.transaction(() => {
      if (db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(f)) return;
      db.exec(readFileSync(join(dir, f), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, Math.floor(Date.now() / 1000));
    }).immediate();
  }
}
