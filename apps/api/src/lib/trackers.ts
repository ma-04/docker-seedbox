/** Tracker lists: stored state, the effective list handed to the engine, and the refresh pass (worker). docs/architecture.md § Tracker lists. */
import type { Db } from './db.js';
import type { TrackerListStatusDto, TrackersDto } from './dto.js';
import { getSetting, setSetting } from './settings.js';
import { sanitiseTracker } from './source.js';
import { fetchTrackerListBody, parseTrackerList, TrackerListError, type FetchOptions } from './trackerlist.js';
import { now } from './types.js';

interface ListRow {
  url: string; fetched_at: number | null; attempted_at: number; ok: number; error: string | null;
  tracker_count: number; body_sha256: string | null; trackers_json: string;
}

/** Newline text (the engine's `add_trackers` format) -> trimmed non-empty lines. */
export const splitLines = (text: string): string[] => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** Dedupe key: scheme and host case-insensitive, the rest exact. */
function key(t: string): string {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/is.exec(t);
  return m ? `${m[1]!.toLowerCase()}://${m[2]!.toLowerCase()}${m[3]}` : t;
}

/** Manual trackers first, then the fetched ones (lists in configured order), deduplicated; `max` caps the FETCHED part. */
export function mergeEffective(manual: string[], fetched: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of manual) { const k = key(t); if (!seen.has(k)) { seen.add(k); out.push(t); } }
  let taken = 0;
  for (const t of fetched) {
    if (taken >= max) break;
    const k = key(t);
    if (seen.has(k)) continue;
    seen.add(k); out.push(t); taken++;
  }
  return out;
}

const rows = (db: Db): ListRow[] => db.prepare('SELECT * FROM tracker_lists').all() as ListRow[];

/** Trackers of the configured lists (last good copy of each, stale-while-error), in configured order. */
export function fetchedTrackers(db: Db): string[] {
  const byUrl = new Map(rows(db).map((r) => [r.url, r]));
  const out: string[] = [];
  for (const url of getSetting(db, 'trackers.listUrls')) {
    const r = byUrl.get(url);
    if (!r) continue;
    try { for (const t of JSON.parse(r.trackers_json) as string[]) { if (typeof t === 'string' && sanitiseTracker(t)) out.push(t); } } catch { /* corrupt row: ignored */ }
  }
  return out;
}

export interface Effective { enabled: boolean; trackers: string[]; manualCount: number }

/** What the engine should be given. Disabled = nothing is added (and the lists are not fetched). */
export function effectiveTrackers(db: Db): Effective {
  const enabled = getSetting(db, 'trackers.enabled');
  const manual = splitLines(getSetting(db, 'trackers.manual'));
  if (!enabled) return { enabled, trackers: [], manualCount: manual.length };
  return { enabled, trackers: mergeEffective(manual, fetchedTrackers(db), getSetting(db, 'trackers.maxTrackers')), manualCount: manual.length };
}

export function trackersDto(db: Db): TrackersDto {
  const byUrl = new Map(rows(db).map((r) => [r.url, r]));
  const urls = getSetting(db, 'trackers.listUrls');
  const lists: TrackerListStatusDto[] = urls.map((url) => {
    const r = byUrl.get(url);
    return {
      url, lastFetchedAt: r?.fetched_at ?? null, lastAttemptAt: r && r.attempted_at ? r.attempted_at : null,
      ok: !!r?.ok, error: r?.error ?? null, trackerCount: r?.tracker_count ?? 0,
    };
  });
  const eff = effectiveTrackers(db);
  const req = getSetting(db, 'trackers.refreshRequestedAt');
  return {
    enabled: eff.enabled, urls, refreshHours: getSetting(db, 'trackers.refreshHours'), maxTrackers: getSetting(db, 'trackers.maxTrackers'),
    lists, manualCount: eff.manualCount, effectiveCount: eff.trackers.length,
    refreshRequestedAt: req > getSetting(db, 'trackers.refreshDoneAt') ? req : null,
  };
}

/** Failed lists are retried sooner than the refresh interval (at most hourly). */
const retryAfterSec = (hours: number): number => Math.min(hours * 3600, 3600);

/** True when a refresh pass should run now: an admin request is pending, or a configured list is missing / past its interval. */
export function refreshDue(db: Db, nowSec = now()): boolean {
  if (!getSetting(db, 'trackers.enabled')) return false;
  const urls = getSetting(db, 'trackers.listUrls');
  if (urls.length === 0) return false;
  if (getSetting(db, 'trackers.refreshRequestedAt') > getSetting(db, 'trackers.refreshDoneAt')) return true;
  const hours = getSetting(db, 'trackers.refreshHours');
  const byUrl = new Map(rows(db).map((r) => [r.url, r]));
  return urls.some((u) => {
    const r = byUrl.get(u);
    return !r || nowSec - r.attempted_at >= (r.ok ? hours * 3600 : retryAfterSec(hours));
  });
}

export interface RefreshResult { changed: boolean; ok: number; failed: number }

/**
 * Fetch every configured list once. A failure (network, HTTP error, HTML/binary body) keeps the previous good list and
 * records a short error. Returns whether the stored trackers changed. Never throws.
 */
export async function refreshTrackerLists(db: Db, opts: FetchOptions = {}, nowSec = now()): Promise<RefreshResult> {
  const urls = getSetting(db, 'trackers.listUrls');
  const max = getSetting(db, 'trackers.maxTrackers');
  const requestedAt = getSetting(db, 'trackers.refreshRequestedAt');
  const before = JSON.stringify(fetchedTrackers(db));
  let ok = 0, failed = 0;
  db.prepare(`DELETE FROM tracker_lists WHERE url NOT IN (${urls.map(() => '?').join(',') || "''"})`).run(...urls);
  for (const url of urls) {
    try {
      const body = await fetchTrackerListBody(url, opts);
      const p = parseTrackerList(body, max);
      db.prepare(
        `INSERT INTO tracker_lists (url, fetched_at, attempted_at, ok, error, tracker_count, body_sha256, trackers_json) VALUES (?, ?, ?, 1, NULL, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET fetched_at = excluded.fetched_at, attempted_at = excluded.attempted_at, ok = 1, error = NULL,
           tracker_count = excluded.tracker_count, body_sha256 = excluded.body_sha256, trackers_json = excluded.trackers_json`,
      ).run(url, nowSec, nowSec, p.trackers.length, p.sha256, JSON.stringify(p.trackers));
      ok++;
    } catch (e) {
      const msg = (e instanceof TrackerListError ? e.message : 'Could not download the list').slice(0, 200);
      db.prepare(
        `INSERT INTO tracker_lists (url, attempted_at, ok, error) VALUES (?, ?, 0, ?)
         ON CONFLICT(url) DO UPDATE SET attempted_at = excluded.attempted_at, ok = 0, error = excluded.error`,
      ).run(url, nowSec, msg);
      failed++;
    }
  }
  setSetting(db, 'trackers.refreshDoneAt', Math.max(requestedAt, getSetting(db, 'trackers.refreshDoneAt')));
  return { changed: JSON.stringify(fetchedTrackers(db)) !== before, ok, failed };
}
