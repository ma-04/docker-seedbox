/** Test helpers (no vitest import so it can live next to the sources). */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import pino from 'pino';
import { loadConfig, type Config } from '../lib/config.js';
import { encryptJson } from '../lib/crypto.js';
import { openDb, type Db } from '../lib/db.js';
import { encryptConfig } from '../lib/destinations.js';
import type { VpnClient } from '../lib/vpn.js';
import { now, type DestinationConfig, type TorrentSource, type VpnStatus } from '../lib/types.js';
import type { DownloadAddInput, Downloader, DownloadStatus } from '../downloaders/types.js';
import type { RcloneProc, SpawnFn } from './rclone.js';

export const SECRET = 'test-secret-test-secret-test-secret-123';
export const silent = pino({ level: 'silent' });

export function makeEnv(): { db: Db; config: Config; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'seedbox-test-'));
  const config = loadConfig({ APP_SECRET: SECRET, GATEWAY_SECRET: 'g', VPN_CONTROL_TOKEN: 'v', DOWNLOADS_DIR: join(dir, 'downloads'), DATA_DIR: join(dir, 'data') });
  mkdirSync(config.downloadsDir, { recursive: true });
  const db = openDb(':memory:');
  db.prepare("INSERT INTO settings (key, value_json) VALUES ('limits.minFreeDiskBytes', '0')").run();
  return { db, config, dir };
}

export function addUser(db: Db, username: string, email: string | null = null): number {
  return Number(db.prepare('INSERT INTO users (username, email, created_at, last_seen_at) VALUES (?, ?, ?, ?)').run(username, email, now(), now()).lastInsertRowid);
}
export function addDest(db: Db, cfg: DestinationConfig, ownerUserId: number | null = null): number {
  return Number(db.prepare('INSERT INTO destinations (owner_user_id, name, type, config_enc, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(ownerUserId, 'dest', cfg.type, encryptConfig(SECRET, cfg), now()).lastInsertRowid);
}
export function addTorrent(db: Db, infohash: string, source: TorrentSource = { magnet: `magnet:?xt=urn:btih:${infohash}` }): number {
  return Number(db.prepare('INSERT INTO torrents (infohash, source_enc, added_at) VALUES (?, ?, ?)').run(infohash, encryptJson(SECRET, source), now() - 120).lastInsertRowid);
}
export function addJob(db: Db, userId: number, torrentId: number, destId: number): number {
  return Number(db.prepare('INSERT INTO jobs (user_id, torrent_id, destination_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, torrentId, destId, now(), now()).lastInsertRowid);
}
export const job = (db: Db, id: number) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as import('../lib/types.js').JobRow;
export const torrent = (db: Db, id: number) => db.prepare('SELECT * FROM torrents WHERE id = ?').get(id) as import('../lib/types.js').TorrentRow;
export const files = (db: Db, jobId: number) =>
  (db.prepare('SELECT path, size FROM job_files WHERE job_id = ? ORDER BY path').all(jobId) as { path: string; size: number }[]);

export function writeFiles(root: string, spec: Record<string, string>): void {
  for (const [rel, content] of Object.entries(spec)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

export class FakeDownloader implements Downloader {
  readonly kind = 'fake';
  items = new Map<string, DownloadStatus>();
  added: DownloadAddInput[] = [];
  removed: { ref: string; deleteData: boolean }[] = [];
  async add(i: DownloadAddInput): Promise<void> {
    this.added.push(i);
    if (!this.items.has(i.id)) {
      this.items.set(i.id, { state: 'metadata-pending', name: '', totalSize: 0, progress: 0, dlSpeed: 0, ratio: 0, contentPath: '', savePath: i.savePath });
    }
  }
  async status(ref: string): Promise<DownloadStatus | null> { return this.items.get(ref) ?? null; }
  async remove(ref: string, deleteData: boolean): Promise<void> { this.removed.push({ ref, deleteData }); this.items.delete(ref); }
  set(ref: string, patch: Partial<DownloadStatus>): void {
    const cur = this.items.get(ref) ?? { state: 'downloading', name: '', totalSize: 0, progress: 0, dlSpeed: 0, ratio: 0, contentPath: '', savePath: '' };
    this.items.set(ref, { ...cur, ...patch });
  }
}

export class FakeVpn implements VpnClient {
  modes: string[] = [];
  connects: string[] = [];
  disconnects = 0;
  fail = false;
  status_: VpnStatus = { mode: 'required', connected: false, name: null, publicIp: null, lastHandshakeSec: null, since: null };
  async status(): Promise<VpnStatus> { if (this.fail) throw new Error('unreachable'); return this.status_; }
  async connect(name: string): Promise<VpnStatus> {
    if (this.fail) throw new Error('unreachable');
    this.connects.push(name);
    this.status_ = { ...this.status_, connected: true, name, lastHandshakeSec: 1 };
    return this.status_;
  }
  async disconnect(): Promise<void> { this.disconnects++; }
  async setMode(m: 'off' | 'required'): Promise<void> { if (this.fail) throw new Error('unreachable'); this.modes.push(m); this.status_ = { ...this.status_, mode: m }; }
}

export interface FakeProc extends RcloneProc { stderr: PassThrough; emitter: EventEmitter; killed: boolean; signals: string[]; finish(code: number, lines?: string[]): void }
export function fakeSpawn(onSpawn?: (cmd: string, args: string[], env: NodeJS.ProcessEnv, proc: FakeProc) => void): { spawn: SpawnFn; calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[]; procs: FakeProc[] } {
  const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const procs: FakeProc[] = [];
  const spawn: SpawnFn = (cmd, args, opts) => {
    const emitter = new EventEmitter();
    const stderr = new PassThrough();
    const proc = {
      stderr, emitter, killed: false, signals: [] as string[],
      kill(sig?: string) { proc.killed = true; proc.signals.push(String(sig ?? 'SIGTERM')); return true; },
      on(ev: string, fn: (...a: any[]) => void) { emitter.on(ev, fn); return proc; },
      finish(code: number, lines: string[] = []) {
        for (const l of lines) stderr.write(l + '\n');
        setImmediate(() => emitter.emit('close', code, null));
      },
    } as unknown as FakeProc;
    calls.push({ cmd, args, env: opts.env });
    procs.push(proc);
    onSpawn?.(cmd, args, opts.env, proc);
    return proc;
  };
  return { spawn, calls, procs };
}
