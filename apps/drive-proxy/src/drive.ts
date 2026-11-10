import { getAccessToken } from './token';
import { HttpError, type Env } from './types';

const API = 'https://www.googleapis.com/drive/v3/files';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FIELDS = 'files(id,name,mimeType,size,md5Checksum,modifiedTime)';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  md5Checksum?: string;
  modifiedTime?: string;
}

export const q = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** fetch with a bearer token; on 401 refresh once and retry. */
export async function driveFetch(env: Env, url: string, init: RequestInit = {}): Promise<Response> {
  let token = await getAccessToken(env);
  const go = (t: string) => fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${t}` } });
  let res = await go(token);
  if (res.status === 401) {
    await res.body?.cancel();
    token = await getAccessToken(env, token);
    res = await go(token);
  }
  return res;
}

const QUOTA_REASONS = new Set(['downloadQuotaExceeded', 'userRateLimitExceeded', 'rateLimitExceeded', 'dailyLimitExceeded', 'sharingRateLimitExceeded']);

/** Read (a bounded part of) a Drive error body and return its first reason, if any. */
export async function errorReason(res: Response): Promise<string | undefined> {
  try {
    const text = (await res.text()).slice(0, 8192);
    return (JSON.parse(text) as { error?: { errors?: { reason?: string }[] } }).error?.errors?.[0]?.reason;
  } catch {
    return undefined;
  }
}

/** Throws the right HttpError for a non-ok Drive response (consumes the body). */
export async function throwForDrive(res: Response): Promise<never> {
  const reason = res.status === 403 || res.status === 429 ? await errorReason(res) : (await res.body?.cancel(), undefined);
  if (res.status === 429 || (res.status === 403 && reason && QUOTA_REASONS.has(reason))) {
    const ra = Number(res.headers.get('retry-after'));
    throw new HttpError(429, 'Too many requests, try again later', Number.isFinite(ra) && ra > 0 ? ra : 60);
  }
  if (res.status === 404) throw new HttpError(404, 'Not found');
  console.error(`drive error: HTTP ${res.status} ${reason ?? ''}`);
  throw new HttpError(502, 'Upstream error');
}

function ttl(env: Env): number {
  const n = Number(env.CACHE_TTL_SECONDS);
  return env.CACHE_TTL_SECONDS !== undefined && env.CACHE_TTL_SECONDS !== '' && Number.isFinite(n) && n >= 0 ? n : 300;
}

const NEGATIVE_TTL = 30;

function cacheKey(parent: string, name: string): Request {
  return new Request(`https://drive-proxy.cache.invalid/lookup/${encodeURIComponent(parent)}/${encodeURIComponent(name)}`);
}

async function lookupChild(env: Env, parent: string, name: string): Promise<DriveFile | null> {
  const key = cacheKey(parent, name);
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) {
    const v = (await hit.json()) as DriveFile | { missing: true };
    return 'missing' in v ? null : v;
  }

  const params = new URLSearchParams({
    q: `name = '${q(name)}' and '${q(parent)}' in parents and trashed = false`,
    fields: FIELDS,
    orderBy: 'modifiedTime desc',
    pageSize: '10',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  const res = await driveFetch(env, `${API}?${params}`);
  if (!res.ok) return throwForDrive(res);
  const files = ((await res.json()) as { files?: DriveFile[] }).files ?? [];
  // Newest first (Drive orders too; sort again so duplicates are deterministic).
  files.sort((a, b) => (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? ''));
  const found = files.find((f) => f.name === name) ?? null;

  const maxAge = found ? ttl(env) : Math.min(NEGATIVE_TTL, ttl(env));
  if (maxAge > 0) {
    await cache.put(
      key,
      new Response(JSON.stringify(found ?? { missing: true }), { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${maxAge}` } }),
    );
  }
  return found;
}

/** Resolve "/a/b/c" under the root; null unless it is a plain downloadable file. */
export async function resolveFile(env: Env, path: string): Promise<DriveFile | null> {
  const segs = path.split('/').slice(1);
  let parent = env.ROOT_FOLDER_ID;
  for (let i = 0; i < segs.length; i++) {
    const child = await lookupChild(env, parent, segs[i]!);
    if (!child) return null;
    if (i < segs.length - 1) {
      if (child.mimeType !== FOLDER_MIME) return null;
      parent = child.id;
    } else {
      if (child.mimeType.startsWith('application/vnd.google-apps.')) return null;
      return child;
    }
  }
  return null;
}

/** Start the media download. Retries once with acknowledgeAbuse when Drive flags the file. */
export async function download(env: Env, id: string, headers: Record<string, string>): Promise<Response> {
  const base = `${API}/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`;
  let res = await driveFetch(env, base, { headers });
  if (res.status === 403) {
    const clone = res.clone();
    if ((await errorReason(clone)) === 'cannotDownloadAbusiveFile') {
      await res.body?.cancel();
      res = await driveFetch(env, base + '&acknowledgeAbuse=true', { headers });
    }
  }
  return res;
}
