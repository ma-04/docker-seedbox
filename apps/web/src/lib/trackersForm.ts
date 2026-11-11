import type { TrackersDto, TrackersUpdateDto } from './api';

/** Form state of the "Tracker lists" card (Admin -> Settings). Mirrors the API limits in apps/api/src/api/routes/trackers.ts. */
export interface TrackersForm { urls: string; refreshHours: string; maxTrackers: string }

export const NGOSANG_ALL = 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt';
export const MAX_LIST_URLS = 5;
export const MAX_URL_CHARS = 2048;

export const trackersToForm = (d: TrackersDto): TrackersForm => ({
  urls: d.urls.join('\n'), refreshHours: String(d.refreshHours), maxTrackers: String(d.maxTrackers),
});

/** One URL per line (blank lines ignored, duplicates dropped, order kept). */
export function parseUrlLines(text: string): string[] {
  const out: string[] = [];
  for (const l of text.split(/\r?\n/)) { const u = l.trim(); if (u && !out.includes(u)) out.push(u); }
  return out;
}

/** Adds `url` to the textarea text unless it is already there. */
export const addUrlLine = (text: string, url: string): string => {
  const urls = parseUrlLines(text);
  return (urls.includes(url) ? urls : [...urls, url]).join('\n');
};

/** First problem a user can fix before saving, or null. The server remains the authority (https, public host). */
export function validateTrackersForm(f: TrackersForm): string | null {
  const urls = parseUrlLines(f.urls);
  if (urls.length > MAX_LIST_URLS) return `At most ${MAX_LIST_URLS} list URLs`;
  for (const u of urls) {
    if (u.length > MAX_URL_CHARS) return `URL is longer than ${MAX_URL_CHARS} characters`;
    let p: URL;
    try { p = new URL(u); } catch { return `Not a valid URL: ${u.slice(0, 60)}`; }
    if (p.protocol !== 'https:') return `List URLs must use https: ${u.slice(0, 60)}`;
    if (p.username || p.password) return 'List URLs must not contain credentials';
  }
  const h = Number(f.refreshHours), m = Number(f.maxTrackers);
  if (!Number.isInteger(h) || h < 1 || h > 720) return 'Refresh interval must be 1 to 720 hours';
  if (!Number.isInteger(m) || m < 1 || m > 1000) return 'Max trackers must be 1 to 1000';
  return null;
}

/** Only what differs from the saved state. */
export function trackersPatch(cur: TrackersDto, f: TrackersForm): TrackersUpdateDto {
  const patch: TrackersUpdateDto = {};
  const urls = parseUrlLines(f.urls);
  if (JSON.stringify(urls) !== JSON.stringify(cur.urls)) patch.urls = urls;
  if (Number(f.refreshHours) !== cur.refreshHours) patch.refreshHours = Number(f.refreshHours);
  if (Number(f.maxTrackers) !== cur.maxTrackers) patch.maxTrackers = Number(f.maxTrackers);
  return patch;
}
