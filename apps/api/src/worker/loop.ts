/** The worker: one tick every 2 s, every step isolated, all state in SQLite. See docs/architecture.md § Worker loop. */
import { spawn as nodeSpawn } from 'node:child_process';
import { rm, statfs as fsStatfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { Config } from '../lib/config.js';
import type { Db } from '../lib/db.js';
import { decryptJson } from '../lib/crypto.js';
import { getSetting } from '../lib/settings.js';
import { now, type JobRow, type TorrentRow, type TorrentSource } from '../lib/types.js';
import type { VpnClient } from '../lib/vpn.js';
import type { Downloader } from '../downloaders/types.js';
import type { RcloneProc, SpawnFn } from './rclone.js';
import { realGDrive, runUpload, type GDriveOps } from './upload.js';
import { reconcileVpn } from './vpn.js';

export interface WorkerDeps {
  db: Db;
  config: Config;
  downloader: Downloader;
  vpn: VpnClient;
  log: Logger;
  spawn?: SpawnFn;
  rcloneBin?: string;
  maxUploads?: number;
  tickMs?: number;
  vpnEveryMs?: number;
  /** Free bytes on the downloads volume. */
  freeBytes?: (dir: string) => Promise<number>;
  gdrive?: GDriveOps;
}

const ACTIVE = "('queued','downloading','uploading')";
const MAX_ADD_FAILURES = 10;
const INFOHASH = /^[0-9a-f]{40}$/;

const defaultFree = async (dir: string): Promise<number> => {
  const s = await fsStatfs(dir);
  return Number(s.bavail) * Number(s.bsize);
};

export class Worker {
  private readonly db: Db;
  private readonly log: Logger;
  private readonly d: Required<Pick<WorkerDeps, 'maxUploads' | 'tickMs' | 'vpnEveryMs' | 'rcloneBin'>> & WorkerDeps;
  private readonly uploads = new Map<number, { ac: AbortController; done: Promise<void>; proc?: RcloneProc }>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private ticking: Promise<void> | null = null;
  private vpnInflight: Promise<void> | null = null;
  private lastVpn = 0;
  private lastVpnWarn = 0;
  private lastWarn = new Map<string, number>();
  private addFailures = new Map<number, number>();
  private lastProgress = new Map<number, number>();

  constructor(deps: WorkerDeps) {
    this.d = { maxUploads: 2, tickMs: 2000, vpnEveryMs: 15_000, rcloneBin: process.env.RCLONE_BIN || 'rclone', ...deps };
    this.db = deps.db;
    this.log = deps.log;
  }

  start(): void {
    this.stopped = false;
    const loop = (): void => {
      if (this.stopped) return;
      this.ticking = this.tick().finally(() => {
        this.ticking = null;
        if (!this.stopped) this.timer = setTimeout(loop, this.d.tickMs);
      });
    };
    loop();
  }

  /** Stop ticking, kill running rclone children, wait for in-flight work. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const u of this.uploads.values()) { u.ac.abort(); u.proc?.kill('SIGTERM'); }
    await this.ticking;
    await this.idle();
  }

  /** Resolves when no upload is running (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.uploads.size) await Promise.allSettled([...this.uploads.values()].map((u) => u.done));
    if (this.vpnInflight) await this.vpnInflight;
  }

  private warnOnce(key: string, msg: string, err?: unknown, everyMs = 60_000): void {
    const t = Date.now();
    if (t - (this.lastWarn.get(key) ?? 0) < everyMs) return;
    this.lastWarn.set(key, t);
    this.log.warn({ err: err instanceof Error ? err.message : err }, msg);
  }

  private async step(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); } catch (err) { this.warnOnce(`step:${name}`, `worker step ${name} failed`, err, 10_000); }
  }

  async tick(): Promise<void> {
    await this.step('add', () => this.addPending());
    await this.step('promote', () => this.promoteJobs());
    await this.step('sync', () => this.syncDownloading());
    await this.step('uploads', () => this.startUploads());
    await this.step('cleanup', () => this.cleanup());
    if (Date.now() - this.lastVpn >= this.d.vpnEveryMs && !this.vpnInflight) {
      this.lastVpn = Date.now();
      this.vpnInflight = this.reconcileVpn().finally(() => { this.vpnInflight = null; });
    }
  }

  /** One VPN pass; never throws, logs at warn at most once a minute. */
  async reconcileVpn(): Promise<void> {
    try {
      const traffic = (this.db.prepare("SELECT COUNT(*) AS n FROM torrents WHERE state IN ('pending','downloading')").get() as { n: number }).n > 0;
      await reconcileVpn({ db: this.db, config: this.d.config, vpn: this.d.vpn, log: this.log }, traffic);
    } catch (err) {
      if (Date.now() - this.lastVpnWarn >= 60_000) {
        this.lastVpnWarn = Date.now();
        this.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'vpn reconcile failed');
      }
    }
  }

  // --- step 1: pending torrents -> downloader -------------------------------------------------

  private async addPending(): Promise<void> {
    const { db, config, downloader } = this.d;
    const pending = db.prepare("SELECT * FROM torrents WHERE state = 'pending' ORDER BY id").all() as TorrentRow[];
    if (!pending.length) return;

    // Nobody wants it any more (cancelled before it started): nothing was added, just retire it.
    const wanted: TorrentRow[] = [];
    for (const t of pending) {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE torrent_id = ? AND state IN ${ACTIVE}`).get(t.id) as { n: number }).n;
      const any = (db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE torrent_id = ?').get(t.id) as { n: number }).n;
      if (n > 0 || any === 0) wanted.push(t);
      else db.prepare("UPDATE torrents SET state = 'removed' WHERE id = ?").run(t.id);
    }
    if (!wanted.length) return;

    if (getSetting(db, 'vpn.mode') === 'required') {
      let connected = false;
      try { connected = (await this.d.vpn.status()).connected; } catch { /* treated as not connected */ }
      if (!connected) { this.warnOnce('vpn-gate', 'vpn.mode=required and the VPN is not connected; torrents stay pending', undefined, 300_000); return; }
    }
    const minFree = getSetting(db, 'limits.minFreeDiskBytes');
    if (minFree > 0) {
      const free = await (this.d.freeBytes ?? defaultFree)(config.downloadsDir);
      if (free < minFree) { this.warnOnce('disk', `free disk space (${free} bytes) is below limits.minFreeDiskBytes; torrents stay pending`, undefined, 300_000); return; }
    }

    for (const t of wanted) {
      if (!INFOHASH.test(t.infohash)) { this.failTorrent(t, 'Invalid infohash'); continue; }
      try {
        const src = decryptJson<TorrentSource>(config.appSecret, t.source_enc);
        const savePath = join(config.downloadsDir, 'incomplete', t.infohash);
        await downloader.add({
          id: t.infohash,
          source: 'magnet' in src ? { magnet: src.magnet } : { torrent: Buffer.from(src.torrentB64, 'base64') },
          savePath,
        });
        db.prepare("UPDATE torrents SET state = 'downloading', save_path = ?, error = NULL WHERE id = ? AND state = 'pending'").run(savePath, t.id);
        this.addFailures.delete(t.id);
      } catch (err) {
        const n = (this.addFailures.get(t.id) ?? 0) + 1;
        this.addFailures.set(t.id, n);
        this.warnOnce(`add:${t.id}`, `adding torrent ${t.id} failed (attempt ${n})`, err, 30_000);
        if (n >= MAX_ADD_FAILURES) this.failTorrent(t, 'Could not add the torrent to the downloader');
      }
    }
  }

  // --- step 2: queued jobs -> downloading -------------------------------------------------------

  private promoteJobs(): void {
    this.db.prepare(
      `UPDATE jobs SET state = 'downloading', updated_at = ?
       WHERE state = 'queued' AND torrent_id IN (SELECT id FROM torrents WHERE state IN ('downloading','downloaded'))`,
    ).run(now());
  }

  // --- step 3: sync downloading torrents ------------------------------------------------------------

  private async syncDownloading(): Promise<void> {
    const { db, downloader } = this.d;
    const rows = db.prepare("SELECT * FROM torrents WHERE state = 'downloading' ORDER BY id").all() as TorrentRow[];
    for (const t of rows) {
      await this.step(`sync:${t.id}`, async () => {
        const st = await downloader.status(t.infohash);
        if (!st) return this.failTorrent(t, 'The torrent disappeared from the downloader', false);
        if (st.state === 'error') return this.failTorrent(t, `The downloader reported an error (${st.rawState ?? 'error'})`);
        if (st.state === 'metadata-pending') return;

        const max = getSetting(db, 'limits.maxTorrentBytes');
        if (max > 0 && st.totalSize > max) {
          return this.failTorrent(t, `Torrent is ${formatBytes(st.totalSize)}, which exceeds the maximum allowed size of ${formatBytes(max)}`);
        }
        const done = st.state === 'completed';
        const progress = done ? 1 : st.progress;
        db.prepare(
          `UPDATE torrents SET name = ?, total_size = ?, progress = ?, dl_speed = ?, state = ?, completed_at = ?
           WHERE id = ? AND state = 'downloading'`,
        ).run(st.name || t.name, st.totalSize, progress, done ? 0 : Math.round(st.dlSpeed), done ? 'downloaded' : 'downloading', done ? now() : null, t.id);

        if (this.lastProgress.get(t.id) !== progress) {
          this.lastProgress.set(t.id, progress);
          db.prepare(`UPDATE jobs SET updated_at = ? WHERE torrent_id = ? AND state IN ('queued','downloading')`).run(now(), t.id);
        }
        if (done) this.lastProgress.delete(t.id);
      });
    }
  }

  /** Torrent -> error, its active jobs -> failed, drop it (and its data) from the downloader. */
  private failTorrent(t: TorrentRow, message: string, removeFromDownloader = true): void {
    this.log.warn({ torrentId: t.id, reason: message }, 'torrent failed');
    this.db.transaction(() => {
      this.db.prepare("UPDATE torrents SET state = 'error', error = ?, dl_speed = 0 WHERE id = ?").run(message, t.id);
      this.db.prepare(`UPDATE jobs SET state = 'failed', error = ?, updated_at = ? WHERE torrent_id = ? AND state IN ${ACTIVE}`).run(message, now(), t.id);
    })();
    void this.discard(t, removeFromDownloader).catch((e) => this.warnOnce(`discard:${t.id}`, 'failed to clean up a torrent', e));
  }

  private async discard(t: TorrentRow, fromDownloader: boolean): Promise<void> {
    if (fromDownloader) await this.d.downloader.remove(t.infohash, true);
    await this.rmData(t);
  }

  private async rmData(t: Pick<TorrentRow, 'infohash'>): Promise<void> {
    if (!INFOHASH.test(t.infohash)) return;
    await rm(join(this.d.config.downloadsDir, 'incomplete', t.infohash), { recursive: true, force: true });
  }

  // --- step 4: uploads -------------------------------------------------------------------------------------

  private startUploads(): void {
    const { db } = this.d;
    // Cancel uploads whose job was cancelled (or deleted) meanwhile.
    for (const [id, u] of this.uploads) {
      const j = db.prepare('SELECT state FROM jobs WHERE id = ?').get(id) as { state: string } | undefined;
      if (!j || j.state !== 'uploading') { u.ac.abort(); u.proc?.kill('SIGTERM'); }
    }
    if (this.stopped) return;
    // 'uploading' jobs not running in this process (fresh boot) restart from scratch; then newly finished downloads.
    const candidates = db.prepare(
      `SELECT j.id, j.state FROM jobs j JOIN torrents t ON t.id = j.torrent_id
       WHERE j.state = 'uploading' OR (j.state = 'downloading' AND t.state = 'downloaded')
       ORDER BY (j.state = 'uploading') DESC, j.id`,
    ).all() as Pick<JobRow, 'id' | 'state'>[];
    for (const c of candidates) {
      if (this.uploads.has(c.id)) continue;
      if (this.uploads.size >= this.d.maxUploads) break;
      db.prepare("UPDATE jobs SET state = 'uploading', upload_progress = 0, upload_speed = 0, updated_at = ? WHERE id = ? AND state IN ('downloading','uploading')").run(now(), c.id);
      const ac = new AbortController();
      const entry: { ac: AbortController; done: Promise<void>; proc?: RcloneProc } = { ac, done: Promise.resolve() };
      entry.done = runUpload({
        db, config: this.d.config, downloader: this.d.downloader, log: this.log,
        spawn: this.d.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, { env: opts.env, stdio: ['ignore', 'ignore', 'pipe'] })),
        rcloneBin: this.d.rcloneBin, gdrive: this.d.gdrive ?? realGDrive,
        onProc: (_id, proc) => { entry.proc = proc; },
      }, c.id, ac.signal).catch((e) => this.log.error({ err: String(e) }, 'upload crashed'))
        .finally(() => { this.uploads.delete(c.id); });
      this.uploads.set(c.id, entry);
    }
  }

  // --- step 5: release torrents nobody needs ------------------------------------------------------

  private async cleanup(): Promise<void> {
    const { db, downloader } = this.d;
    const rows = db.prepare("SELECT * FROM torrents WHERE state IN ('downloading','downloaded') ORDER BY id").all() as TorrentRow[];
    for (const t of rows) {
      await this.step(`cleanup:${t.id}`, async () => {
        const active = (db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE torrent_id = ? AND state IN ${ACTIVE}`).get(t.id) as { n: number }).n;
        if (active > 0) return;
        const total = (db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE torrent_id = ?').get(t.id) as { n: number }).n;
        // A torrent row without jobs may be mid-creation by the API; give it a minute.
        if (total === 0 && now() - t.added_at < 60) return;
        if (t.state === 'downloaded') {
          const target = getSetting(db, 'seeding.ratio');
          if (target > 0) {
            const st = await downloader.status(t.infohash);
            if (st && st.ratio < target) return; // keep seeding
          }
        }
        await downloader.remove(t.infohash, true);
        await this.rmData(t);
        db.prepare("UPDATE torrents SET state = 'removed', dl_speed = 0 WHERE id = ?").run(t.id);
        this.lastProgress.delete(t.id);
        this.log.info({ torrentId: t.id }, 'torrent removed');
      });
    }
  }
}

function formatBytes(n: number): string {
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}
