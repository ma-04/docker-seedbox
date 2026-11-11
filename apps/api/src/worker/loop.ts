/** The worker: one tick every 2 s, every step isolated, all state in SQLite. See docs/architecture.md § Worker loop. */
import { spawn as nodeSpawn } from 'node:child_process';
import { rm, stat, statfs as fsStatfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { Config } from '../lib/config.js';
import type { Db } from '../lib/db.js';
import { decryptJson } from '../lib/crypto.js';
import { getSetting } from '../lib/settings.js';
import { canonicalizeMagnet, SourceError } from '../lib/source.js';
import { rebuildTorrent } from '../lib/torrent-file.js';
import { now, type JobRow, type TorrentRow, type TorrentSource } from '../lib/types.js';
import type { VpnClient } from '../lib/vpn.js';
import { DownloaderUnavailableError, type DownloadAddInput, type Downloader } from '../downloaders/types.js';
import type { RcloneProc, SpawnFn } from './rclone.js';
import { processDeletions } from './deletions.js';
import { EgressProxy } from './egress-proxy.js';
import { realGDrive, runUpload, type EndpointGuard, type GDriveOps } from './upload.js';
import { TrackerSync, type TrackerEngine } from './trackers.js';
import type { FetchOptions } from '../lib/trackerlist.js';
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
  /** SSRF guard for user-owned S3 endpoints; defaults to the shared lib/netguard.ts `assertPublicEndpoint`. */
  endpointGuard?: EndpointGuard;
  /** Engine preferences access for the tracker-list step. Omitted = that step is off (most tests). */
  engine?: TrackerEngine;
  /** Fetch options of the tracker-list step (tests). */
  trackerFetch?: FetchOptions;
  /** Egress proxy for user-owned destinations (default: a lazily started EgressProxy configured from EGRESS_ALLOWED_PORTS). */
  egress?: EgressProxy;
  /** How often the engine's category is swept for torrents that match no non-removed row. Default 30 s. */
  strayEveryMs?: number;
  /** Clock in ms (tests). */
  nowMs?: () => number;
  /** How often free disk is re-checked per downloading torrent. Default 60 s. */
  diskCheckEveryMs?: number;
  /** Test seams. */
  hooks?: {
    /** Called in cleanup after the torrent was removed from the downloader and its data deleted, before the DB transition. */
    afterCleanupRemove?: (t: TorrentRow) => void | Promise<void>;
  };
}

const ACTIVE = "('queued','downloading','uploading')";
const MAX_ADD_FAILURES = 10;
/** A torrent absent from the downloader this long, with a definitive re-add failure, is failed. */
const MISSING_FAIL_AFTER_MS = 120_000;
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
  private deletionsInflight: Promise<void> | null = null;
  private deletionsAc = new AbortController();
  private lastVpn = 0;
  private lastVpnWarn = 0;
  private lastWarn = new Map<string, number>();
  private addFailures = new Map<number, number>();
  private lastProgress = new Map<number, number>();
  /** Torrent id -> ms since which the downloader has not known it (continuous). */
  private missingSince = new Map<number, number>();
  private lastDiskCheck = new Map<number, number>();
  private diskChecked = new Set<number>();
  private vpnApplied = false;
  private lastStray = 0;
  /** Torrent id -> category hashes present just before its first add (until the engine lists it): anything new afterwards is blamed on it. */
  private addBefore = new Map<number, Set<string>>();
  private readonly egress: EgressProxy;
  private readonly trackers: TrackerSync | null;

  private clock(): number { return (this.d.nowMs ?? Date.now)(); }
  private nowSec(): number { return Math.floor(this.clock() / 1000); }

  constructor(deps: WorkerDeps) {
    this.d = { maxUploads: 2, tickMs: 2000, vpnEveryMs: 15_000, rcloneBin: process.env.RCLONE_BIN || 'rclone', ...deps };
    this.db = deps.db;
    this.log = deps.log;
    this.egress = deps.egress ?? new EgressProxy();
    this.trackers = deps.engine
      ? new TrackerSync({ db: deps.db, config: deps.config, engine: deps.engine, log: deps.log, fetch: deps.trackerFetch }, () => this.clock())
      : null;
  }

  start(): void {
    this.stopped = false;
    this.deletionsAc = new AbortController();
    // Apply vpn.mode before anything else: after a restart the sidecar boots fail-closed and qBittorrent has
    // already resumed its torrents; do not wait for the first periodic reconcile.
    this.lastVpn = Date.now();
    this.vpnInflight = this.reconcileVpn().finally(() => { this.vpnInflight = null; });
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
    this.deletionsAc.abort();
    await this.ticking;
    await this.idle();
    await this.egress.stop();
  }

  /** Resolves when no upload is running (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.uploads.size) await Promise.allSettled([...this.uploads.values()].map((u) => u.done));
    if (this.vpnInflight) await this.vpnInflight;
    if (this.deletionsInflight) await this.deletionsInflight;
    if (this.trackers) await this.trackers.idle();
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
    await this.step('heal', () => this.healStranded());
    await this.step('add', () => this.addPending());
    await this.step('promote', () => this.promoteJobs());
    await this.step('sync', () => this.syncDownloading());
    await this.step('sweep', () => this.sweepFailed());
    await this.step('strays', () => this.sweepStrays());
    await this.step('uploads', () => this.startUploads());
    await this.step('cleanup', () => this.cleanup());
    await this.step('deletions', () => this.deletions());
    if (this.trackers) await this.step('trackers', () => this.trackers!.tick());
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
      this.vpnApplied = true;
    } catch (err) {
      // Not applied yet (sidecar still starting): retry in ~3 s instead of waiting a full interval.
      if (!this.vpnApplied) this.lastVpn = Date.now() - this.d.vpnEveryMs + 3000;
      if (Date.now() - this.lastVpnWarn >= 60_000) {
        this.lastVpnWarn = Date.now();
        this.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'vpn reconcile failed');
      }
    }
  }

  // --- step 0: self-heal -----------------------------------------------------------------------------

  /**
   * A torrent that is removed/error although a job still wants it (the API inserted or retried a job while the
   * worker was tearing the torrent down) goes back to `pending`: its data is re-downloaded rather than the job
   * sitting in `queued` forever.
   */
  private async healStranded(): Promise<void> {
    const rows = this.db.prepare(
      `SELECT id, library_path FROM torrents WHERE state IN ('removed','error')
         AND EXISTS (SELECT 1 FROM jobs WHERE jobs.torrent_id = torrents.id AND jobs.state IN ${ACTIVE})`,
    ).all() as { id: number; library_path: string | null }[];
    let healed = 0;
    for (const r of rows) {
      // Keep the library copy when it is still there: addPending then serves the job from it instead of re-downloading.
      const keep = r.library_path && (await exists(r.library_path)) ? r.library_path : null;
      healed += this.db.prepare(
        `UPDATE torrents SET state = 'pending', progress = 0, dl_speed = 0, error = NULL, completed_at = NULL,
           started_at = NULL, library_path = ?, cleanup_pending = 0
         WHERE id = ? AND state IN ('removed','error')
           AND EXISTS (SELECT 1 FROM jobs WHERE jobs.torrent_id = torrents.id AND jobs.state IN ${ACTIVE})`,
      ).run(keep, r.id).changes;
    }
    if (healed > 0) this.log.warn({ torrents: healed }, 'torrents with active jobs were removed/failed; resetting them to pending');
  }

  // --- step 1: pending torrents -> downloader -------------------------------------------------

  private async addToDownloader(t: TorrentRow): Promise<string> {
    const src = decryptJson<TorrentSource>(this.d.config.appSecret, t.source_enc);
    const savePath = join(this.d.config.downloadsDir, 'incomplete', t.infohash);
    // Everything is re-validated and REBUILT on every add: rows stored before the strict policy may hold web seeds,
    // non-canonical bytes or (worst case) an info dict whose hash is not the one the row claims.
    let source: DownloadAddInput['source'];
    if ('magnet' in src) {
      const c = canonicalizeMagnet(src.magnet);
      if (c.infohash !== t.infohash) throw new SourceError('The stored magnet does not match the recorded infohash');
      source = { magnet: c.magnet };
    } else {
      const r = rebuildTorrent(Buffer.from(src.torrentB64, 'base64'));
      if (r.infohash !== t.infohash) throw new SourceError('The stored torrent file does not match the recorded infohash');
      source = { torrent: r.file };
    }
    if (!this.addBefore.has(t.id)) {
      try { this.addBefore.set(t.id, new Set(await this.d.downloader.list())); } catch { /* engine down: the add below fails the same way */ }
    }
    await this.d.downloader.add({ id: t.infohash, source, savePath });
    return savePath;
  }

  private async addPending(): Promise<void> {
    const { db, config } = this.d;
    const pending = db.prepare("SELECT * FROM torrents WHERE state = 'pending' ORDER BY id").all() as TorrentRow[];
    if (!pending.length) return;

    // Nobody wants it any more (cancelled before it started): nothing was added, just retire it.
    // One conditional statement: a job the API inserts in the meantime keeps the torrent alive.
    const wanted: TorrentRow[] = [];
    for (const t of pending) {
      const r = db.prepare(
        `UPDATE torrents SET state = 'removed' WHERE id = ? AND state = 'pending'
           AND EXISTS (SELECT 1 FROM jobs WHERE torrent_id = ?)
           AND NOT EXISTS (SELECT 1 FROM jobs WHERE torrent_id = ? AND state IN ${ACTIVE})`,
      ).run(t.id, t.id, t.id);
      if (r.changes === 0) wanted.push(t);
    }
    if (!wanted.length) return;

    // Content already moved into the library by an earlier completed job: serve new jobs from there, no re-download.
    for (let i = wanted.length - 1; i >= 0; i--) {
      const t = wanted[i]!;
      if (!t.library_path || !(await exists(t.library_path))) continue;
      db.prepare("UPDATE torrents SET state = 'downloaded', progress = 1, dl_speed = 0, error = NULL, completed_at = ? WHERE id = ? AND state = 'pending'").run(now(), t.id);
      wanted.splice(i, 1);
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
        const savePath = await this.addToDownloader(t);
        if (await this.engineHoldsDifferentTorrent(t)) continue;
        db.prepare("UPDATE torrents SET state = 'downloading', save_path = ?, error = NULL, started_at = ?, library_path = NULL, cleanup_pending = 0 WHERE id = ? AND state = 'pending'")
          .run(savePath, this.nowSec(), t.id);
        this.addFailures.delete(t.id);
        this.missingSince.delete(t.id);
        this.diskChecked.delete(t.id);
      } catch (err) {
        if (err instanceof SourceError) { this.failTorrent(t, `Invalid torrent source: ${err.message}`); continue; }
        const n = (this.addFailures.get(t.id) ?? 0) + 1;
        this.addFailures.set(t.id, n);
        this.warnOnce(`add:${t.id}`, `adding torrent ${t.id} failed (attempt ${n})`, err, 30_000);
        // A downloader that is down/restarting is not the torrent's fault: keep it pending.
        if (n >= MAX_ADD_FAILURES && !(err instanceof DownloaderUnavailableError)) this.failTorrent(t, 'Could not add the torrent to the downloader');
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
        // Throws (and is only logged) when the downloader is unreachable: that never fails a torrent.
        const st = await downloader.status(t.infohash);
        if (!st) return this.handleMissing(t);
        this.missingSince.delete(t.id);
        this.addBefore.delete(t.id);
        if (st.state === 'error') return this.failTorrent(t, `The downloader reported an error (${st.rawState ?? 'error'})`);
        if (st.state === 'metadata-pending') {
          const limitMin = getSetting(db, 'limits.metadataTimeoutMinutes');
          if (limitMin > 0 && t.started_at !== null && this.nowSec() - t.started_at > limitMin * 60) {
            return this.failTorrent(t, `No metadata received after ${limitMin} minutes (no peers / metadata timeout)`);
          }
          return;
        }

        const max = getSetting(db, 'limits.maxTorrentBytes');
        if (max > 0 && st.totalSize > max) {
          return this.failTorrent(t, `Torrent is ${formatBytes(st.totalSize)}, which exceeds the maximum allowed size of ${formatBytes(max)}`);
        }
        if (st.state !== 'completed' && st.totalSize > 0 && (await this.diskTooSmall(t, st.totalSize, st.progress))) return;
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
        if (done) { this.lastProgress.delete(t.id); this.diskChecked.delete(t.id); this.lastDiskCheck.delete(t.id); }
      });
    }
  }

  /**
   * The downloader does not know a torrent we believe is downloading. qBittorrent restarting (compose restarts it
   * whenever the vpn container restarts) can briefly return an empty list, so this is transient: re-add from the
   * stored source (idempotent; qBittorrent re-checks existing data). Only a torrent missing continuously for > 120 s
   * whose re-add is definitively rejected is failed; an unreachable downloader never fails anything.
   */
  private async handleMissing(t: TorrentRow): Promise<void> {
    const nowMs = this.clock();
    const since = this.missingSince.get(t.id) ?? nowMs;
    this.missingSince.set(t.id, since);
    // Before re-adding: an untracked torrent that appeared since the first add means the engine parsed something else
    // (and a re-add of a duplicate would only answer "Fails." and hide that).
    if (await this.engineHoldsDifferentTorrent(t)) return;
    try {
      await this.addToDownloader(t);
      if (await this.engineHoldsDifferentTorrent(t)) return;
      this.warnOnce(`missing:${t.id}`, `torrent ${t.id} was missing from the downloader; re-added it`, undefined, 30_000);
    } catch (err) {
      if (err instanceof SourceError) { this.missingSince.delete(t.id); return this.failTorrent(t, `Invalid torrent source: ${err.message}`); }
      if (err instanceof DownloaderUnavailableError) { this.missingSince.delete(t.id); throw err; }
      if (await this.engineHoldsDifferentTorrent(t)) return;
      if (nowMs - since > MISSING_FAIL_AFTER_MS) {
        this.missingSince.delete(t.id);
        return this.failTorrent(t, 'The torrent disappeared from the downloader and could not be added again');
      }
      this.warnOnce(`missing:${t.id}`, `torrent ${t.id} is missing from the downloader and re-adding it failed`, err, 30_000);
    }
  }

  // --- defence in depth: nothing may run untracked ----------------------------------------------------------

  /** Hashes in the engine's category that belong to no non-removed torrents row. */
  private async strayHashes(): Promise<string[]> {
    const known = new Set((this.db.prepare("SELECT infohash FROM torrents WHERE state != 'removed'").all() as { infohash: string }[]).map((r) => r.infohash));
    return (await this.d.downloader.list()).filter((h) => !known.has(h));
  }

  private async removeStray(h: string): Promise<void> {
    await this.d.downloader.remove(h, true);
    await this.rmData({ infohash: h });
  }

  /**
   * After an add the engine must hold exactly the expected infohash. If it does not (yet) know it but holds an
   * untracked torrent, the engine parsed something other than what we recorded: remove that torrent with its data and
   * fail the torrent. Until metadata arrives a magnet is already listed under its infohash, so the same rule applies.
   * Only hashes that appeared after the snapshot taken before the add are blamed. An engine that has not listed the new torrent
   * yet and shows no new stray is left alone: the check also runs before every re-add and the periodic sweep removes strays anyway.
   */
  private async engineHoldsDifferentTorrent(t: TorrentRow): Promise<boolean> {
    try {
      if (await this.d.downloader.status(t.infohash)) { this.addBefore.delete(t.id); return false; }
      const before = this.addBefore.get(t.id);
      if (!before) return false; // no snapshot (worker restarted): the periodic sweep removes strays, a re-add takes a snapshot
      const blamed = (await this.strayHashes()).filter((h) => !before.has(h));
      if (!blamed.length) return false;
      for (const h of blamed) { this.log.warn({ torrentId: t.id, hash: h }, 'removing a torrent the engine started that matches no torrents row'); await this.removeStray(h); }
      this.failTorrent(t, 'The engine reported a different torrent than the one recorded (engine reported a different torrent); it was removed');
      return true;
    } catch (err) {
      this.warnOnce(`verify:${t.id}`, `could not verify torrent ${t.id} in the downloader`, err, 30_000);
      return false;
    }
  }

  /** Periodic: remove (with data) every torrent in the app's category that matches no non-removed row, so nothing runs untracked. */
  private async sweepStrays(): Promise<void> {
    const nowMs = this.clock();
    if (nowMs - this.lastStray < (this.d.strayEveryMs ?? 30_000)) return;
    this.lastStray = nowMs;
    for (const h of await this.strayHashes()) {
      this.log.warn({ hash: h }, 'removing an untracked torrent from the downloader');
      await this.removeStray(h);
    }
  }

  /**
   * Disk guard. Once after metadata: remaining download plus the extra copies a local destination needs (seeding or
   * other jobs force copy instead of move) must fit above limits.minFreeDiskBytes. Afterwards, periodically: free space
   * below the floor fails the torrent (freeing its partial data) instead of filling the volume.
   * Returns true when the torrent was failed.
   */
  private async diskTooSmall(t: TorrentRow, totalSize: number, progress: number): Promise<boolean> {
    const { db } = this.d;
    const first = !this.diskChecked.has(t.id);
    const nowMs = this.clock();
    if (!first && nowMs - (this.lastDiskCheck.get(t.id) ?? 0) < (this.d.diskCheckEveryMs ?? 60_000)) return false;
    this.lastDiskCheck.set(t.id, nowMs);
    let free: number;
    try { free = await (this.d.freeBytes ?? defaultFree)(this.d.config.downloadsDir); } catch { return false; }
    this.diskChecked.add(t.id);
    const minFree = getSetting(db, 'limits.minFreeDiskBytes');
    if (first) {
      const jobs = db.prepare(
        `SELECT COUNT(*) AS active, COALESCE(SUM(d.type = 'local'), 0) AS local FROM jobs j JOIN destinations d ON d.id = j.destination_id
         WHERE j.torrent_id = ? AND j.state IN ${ACTIVE}`,
      ).get(t.id) as { active: number; local: number };
      const mustCopy = getSetting(db, 'seeding.ratio') > 0 || jobs.active > 1;
      const copies = mustCopy ? jobs.local : Math.max(0, jobs.local - 1);
      const need = totalSize * (1 - progress) + copies * totalSize;
      if (need > free - minFree) {
        this.failTorrent(t, `Not enough free disk space: ${formatBytes(need)} needed (${formatBytes(totalSize)} torrent${copies ? `, ${copies} extra cop${copies > 1 ? 'ies' : 'y'} in the library` : ''}) but only ${formatBytes(Math.max(0, free - minFree))} available above the ${formatBytes(minFree)} reserve`);
        return true;
      }
    } else if (free < minFree) {
      this.failTorrent(t, `Free disk space fell below the ${formatBytes(minFree)} reserve (${formatBytes(free)} left); the download was stopped`);
      return true;
    }
    return false;
  }

  /** Torrent -> error, its active jobs -> failed. Removal from the downloader and data deletion is done by sweepFailed (retried until it works). */
  private failTorrent(t: TorrentRow, message: string): void {
    this.log.warn({ torrentId: t.id, reason: message }, 'torrent failed');
    this.db.transaction(() => {
      this.db.prepare("UPDATE torrents SET state = 'error', error = ?, dl_speed = 0, cleanup_pending = 1 WHERE id = ?").run(message, t.id);
      this.db.prepare(`UPDATE jobs SET state = 'failed', error = ?, updated_at = ? WHERE torrent_id = ? AND state IN ${ACTIVE}`).run(message, now(), t.id);
    })();
    this.missingSince.delete(t.id);
    this.lastProgress.delete(t.id);
    this.addBefore.delete(t.id);
  }

  /**
   * Remove errored torrents (and their data) from the downloader, retrying every tick until it succeeds. A torrent
   * that a retry has meanwhile given an active job again is left alone (heal/addPending re-use it); the worker is
   * sequential, so a re-add never interleaves with a removal started here.
   */
  private async sweepFailed(): Promise<void> {
    const { db, downloader } = this.d;
    // Only errored (or since retired) torrents: a torrent that is pending/downloading again is not ours to delete.
    const rows = db.prepare("SELECT * FROM torrents WHERE cleanup_pending = 1 AND state IN ('error','removed') ORDER BY id").all() as TorrentRow[];
    for (const t of rows) {
      await this.step(`sweep:${t.id}`, async () => {
        const hasActive = (): boolean => !!db.prepare(`SELECT 1 FROM jobs WHERE torrent_id = ? AND state IN ${ACTIVE} LIMIT 1`).get(t.id);
        if (hasActive()) { db.prepare('UPDATE torrents SET cleanup_pending = 0 WHERE id = ?').run(t.id); return; }
        await downloader.remove(t.infohash, true);
        await this.rmData(t);
        db.prepare(
          `UPDATE torrents SET cleanup_pending = 0 WHERE id = ? AND state IN ('error','removed')
             AND NOT EXISTS (SELECT 1 FROM jobs WHERE torrent_id = ? AND state IN ${ACTIVE})`,
        ).run(t.id, t.id);
      });
    }
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
        rcloneBin: this.d.rcloneBin, gdrive: this.d.gdrive ?? realGDrive, endpointGuard: this.d.endpointGuard, egress: this.egress,
        onProc: (_id, proc) => { entry.proc = proc; },
      }, c.id, ac.signal).catch((e) => this.log.error({ err: String(e) }, 'upload crashed'))
        .finally(() => { this.uploads.delete(c.id); });
      this.uploads.set(c.id, entry);
    }
  }

  // --- step 6: delete files of removed jobs ---------------------------------------------------------

  /** Off the tick (an S3 purge can take minutes against a slow endpoint and must not freeze the state machine); one pass at a time. */
  private deletions(): void {
    if (this.stopped || this.deletionsInflight) return;
    this.deletionsInflight = processDeletions({
      db: this.db, config: this.d.config, log: this.log, rcloneBin: this.d.rcloneBin, egress: this.egress, endpointGuard: this.d.endpointGuard,
      signal: this.deletionsAc.signal,
      spawn: this.d.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, { env: opts.env, stdio: ['ignore', 'ignore', 'pipe'] })),
    }).catch((e) => this.log.error({ err: String(e) }, 'deletions crashed')).finally(() => { this.deletionsInflight = null; });
  }

  // --- step 5: release torrents nobody needs ------------------------------------------------------

  private async cleanup(): Promise<void> {
    const { db, downloader } = this.d;
    const rows = db.prepare("SELECT * FROM torrents WHERE state IN ('downloading','downloaded') ORDER BY id").all() as TorrentRow[];
    const activeCount = (id: number): number =>
      (db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE torrent_id = ? AND state IN ${ACTIVE}`).get(id) as { n: number }).n;
    for (const t of rows) {
      await this.step(`cleanup:${t.id}`, async () => {
        if (activeCount(t.id) > 0) return;
        const total = (db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE torrent_id = ?').get(t.id) as { n: number }).n;
        // A torrent row without jobs may be mid-creation by the API; give it a minute.
        if (total === 0 && now() - t.added_at < 60) return;
        if (t.state === 'downloaded') {
          // After a failed upload keep the data for a while so "Retry" re-uploads without re-downloading.
          const graceMin = getSetting(db, 'cleanup.failedGraceMinutes');
          if (graceMin > 0) {
            const lastFail = (db.prepare("SELECT MAX(updated_at) AS t FROM jobs WHERE torrent_id = ? AND state = 'failed'").get(t.id) as { t: number | null }).t;
            if (lastFail !== null && this.nowSec() - lastFail < graceMin * 60) return;
          }
          const target = getSetting(db, 'seeding.ratio');
          if (target > 0) {
            const st = await downloader.status(t.infohash);
            const maxMin = getSetting(db, 'seeding.maxMinutes');
            const capped = maxMin > 0 && t.completed_at !== null && this.nowSec() - t.completed_at > maxMin * 60;
            if (st && st.ratio < target && !capped) return; // keep seeding
          }
        }
        await downloader.remove(t.infohash, true);
        await this.rmData(t);
        await this.d.hooks?.afterCleanupRemove?.(t);
        // Decided now, in one transaction, after the slow work: a job the API added meanwhile means the data is gone,
        // so the torrent goes back to `pending` (re-download) instead of staying stranded.
        const outcome = db.transaction((): 'removed' | 'reset' => {
          if (activeCount(t.id) > 0) {
            db.prepare(
              `UPDATE torrents SET state = 'pending', progress = 0, dl_speed = 0, error = NULL, completed_at = NULL,
                 started_at = NULL, library_path = NULL WHERE id = ?`,
            ).run(t.id);
            return 'reset';
          }
          db.prepare("UPDATE torrents SET state = 'removed', dl_speed = 0 WHERE id = ?").run(t.id);
          return 'removed';
        }).immediate();
        this.lastProgress.delete(t.id);
        if (outcome === 'reset') this.log.warn({ torrentId: t.id }, 'a job arrived while the torrent was being removed; it will be downloaded again');
        else this.log.info({ torrentId: t.id }, 'torrent removed');
      });
    }
  }
}

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

function formatBytes(n: number): string {
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}
