/**
 * Tracker lists, worker side (docs/architecture.md § Tracker lists):
 *  - one-time migration of the engine's current `add_trackers` / `add_trackers_enabled` into our settings;
 *  - periodic fetch of the configured lists (stale-while-error);
 *  - applying the effective list (manual + fetched) to the engine, only when it differs;
 *  - removing those trackers again from PRIVATE torrents that were added as a magnet.
 */
import type { Logger } from 'pino';
import { decryptJson } from '../lib/crypto.js';
import type { Config } from '../lib/config.js';
import type { Db } from '../lib/db.js';
import { getSetting, hasSetting, setSettingIfAbsent } from '../lib/settings.js';
import { effectiveTrackers, refreshDue, refreshTrackerLists, splitLines } from '../lib/trackers.js';
import type { FetchOptions } from '../lib/trackerlist.js';
import type { TorrentSource } from '../lib/types.js';

export interface TrackerEngine {
  getPreferences(): Promise<Record<string, unknown>>;
  setPreferences(prefs: Record<string, unknown>): Promise<void>;
  /** Lowercase hashes of the app's torrents that qBittorrent flags private. */
  privateTorrents(): Promise<string[]>;
  torrentTrackers(hash: string): Promise<string[]>;
  removeTrackers(hash: string, urls: string[]): Promise<void>;
}

export interface TrackerDeps {
  db: Db; config: Config; engine: TrackerEngine; log: Logger;
  fetch?: FetchOptions;
  /** How often the engine's current value is compared with ours (restart / manual edit in the WebUI). Default 60 s. */
  verifyEveryMs?: number;
  privateEveryMs?: number;
}

const lineKey = (t: string): string => t.trim().toLowerCase();

export class TrackerSync {
  private applied: string | null = null;
  private lastVerify = 0;
  private lastPrivate = 0;
  private migrated = false;
  private refreshing: Promise<void> | null = null;
  private lastWarn = 0;
  private backoffUntil = 0;

  constructor(private readonly d: TrackerDeps, private readonly clock: () => number = Date.now) {}

  private warn(msg: string, err?: unknown): void {
    if (this.clock() - this.lastWarn < 60_000) return;
    this.lastWarn = this.clock();
    this.d.log.warn({ err: err instanceof Error ? err.message : err }, msg);
  }

  /** Resolves when a background refresh is not running (tests, shutdown). */
  async idle(): Promise<void> { if (this.refreshing) await this.refreshing; }

  /** First run: take over the values currently in qBittorrent, so existing deployments (and the e2e fixture tracker) keep them. */
  private async migrate(): Promise<void> {
    if (this.migrated) return;
    const { db } = this.d;
    const needManual = !hasSetting(db, 'trackers.manual');
    const needEnabled = !hasSetting(db, 'trackers.enabled');
    if (needManual || needEnabled) {
      const prefs = await this.d.engine.getPreferences();
      // Insert-if-absent: an admin PUT may have written the setting while the engine call was in flight.
      if (needManual) setSettingIfAbsent(db, 'trackers.manual', typeof prefs.add_trackers === 'string' ? splitLines(prefs.add_trackers).join('\n') : '');
      if (needEnabled) setSettingIfAbsent(db, 'trackers.enabled', prefs.add_trackers_enabled === true);
      this.d.log.info('tracker lists: took over the engine\'s extra-tracker settings');
    }
    this.migrated = true;
  }

  private startRefresh(): void {
    if (this.refreshing) return;
    this.refreshing = (async () => {
      try {
        const r = await refreshTrackerLists(this.d.db, { allowPrivate: this.d.config.trackerListAllowPrivate, ...this.d.fetch });
        this.d.log.info({ ok: r.ok, failed: r.failed, changed: r.changed }, 'tracker lists refreshed');
      } catch (err) { this.warn('tracker list refresh failed', err); }
    })().finally(() => { this.refreshing = null; });
  }

  private async apply(): Promise<void> {
    const { db, engine } = this.d;
    const eff = effectiveTrackers(db);
    const desired = JSON.stringify([eff.enabled, eff.trackers]);
    const t = this.clock();
    const verify = t - this.lastVerify >= (this.d.verifyEveryMs ?? 60_000);
    if (desired === this.applied && !verify) return;
    // The engine's own "add trackers from URL" preference must stay off: this app fetches (and validates) the lists.
    // Compared exactly (not case-folded): a case-only edit of a passkey path is a real change.
    const wanted = { enabled: eff.enabled, list: eff.trackers };
    const prefs = await engine.getPreferences();
    this.lastVerify = t;
    const same = prefs.add_trackers_enabled === wanted.enabled
      && prefs.add_trackers_from_url_enabled !== true
      && (!wanted.enabled || (typeof prefs.add_trackers === 'string' && JSON.stringify(splitLines(prefs.add_trackers)) === JSON.stringify(wanted.list)));
    if (!same) {
      const w: Record<string, unknown> = { add_trackers_enabled: eff.enabled, add_trackers_from_url_enabled: false };
      // A blank line starts a new tier in qBittorrent's add_trackers. One tracker per tier: with the default
      // announce_to_all_tiers=true every tracker is announced to; in a single tier only the first working one would be.
      if (eff.enabled) w.add_trackers = eff.trackers.join('\n\n');
      await engine.setPreferences(w);
      this.d.log.info({ enabled: eff.enabled, trackers: eff.trackers.length }, 'tracker lists applied to the engine');
    }
    this.applied = desired;
  }

  /** Magnet torrents of private swarms get the extra trackers before their metadata is known: remove them again. */
  private async sweepPrivate(): Promise<void> {
    const { db, engine, config } = this.d;
    const ours = new Set([...effectiveTrackers(db).trackers, ...splitLines(getSetting(db, 'trackers.manual'))].map(lineKey));
    if (ours.size === 0) return;
    for (const hash of await engine.privateTorrents()) {
      const row = db.prepare('SELECT source_enc FROM torrents WHERE infohash = ?').get(hash) as { source_enc: string } | undefined;
      if (!row) continue;
      const src = decryptJson<TorrentSource>(config.appSecret, row.source_enc);
      if (!('magnet' in src)) continue; // a .torrent file has its metadata at add time: the engine already skips private ones
      const own = new Set<string>();
      for (const [k, v] of new URLSearchParams(src.magnet.slice(src.magnet.indexOf('?') + 1))) if (k === 'tr' || /^tr\.\d+$/.test(k)) own.add(lineKey(v));
      const have = await engine.torrentTrackers(hash);
      const drop = have.filter((u) => !u.startsWith('** ') && ours.has(lineKey(u)) && !own.has(lineKey(u)));
      if (drop.length) {
        await engine.removeTrackers(hash, drop);
        this.d.log.info({ removed: drop.length }, 'removed extra trackers from a private torrent');
      }
    }
  }

  /** One pass (called every worker tick; cheap: settings reads only, except every `verifyEveryMs`). Never throws. */
  async tick(): Promise<void> {
    if (this.clock() < this.backoffUntil) return;
    try { await this.migrate(); } catch (err) { this.backoffUntil = this.clock() + 10_000; this.warn('tracker settings migration waits for the engine', err); return; }
    if (getSetting(this.d.db, 'trackers.enabled') && refreshDue(this.d.db)) this.startRefresh();
    try { await this.apply(); } catch (err) { this.applied = null; this.backoffUntil = this.clock() + 10_000; this.warn('applying extra trackers to the engine failed', err); }
    if (this.clock() - this.lastPrivate >= (this.d.privateEveryMs ?? 30_000)) {
      this.lastPrivate = this.clock();
      try { if (getSetting(this.d.db, 'trackers.enabled')) await this.sweepPrivate(); } catch (err) { this.warn('private-torrent tracker sweep failed', err); }
    }
  }
}
