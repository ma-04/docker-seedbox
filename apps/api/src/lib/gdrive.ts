/** Minimal Google Drive v3 client (fetch-based). Endpoints are overridable for tests via Config.google. */
import type { Config } from './config.js';

export interface DriveCreds { clientId: string; clientSecret: string; refreshToken: string }
type Google = Config['google'];

const tokenCache = new Map<string, { token: string; exp: number }>();

export async function getAccessToken(creds: DriveCreds, google: Google): Promise<string> {
  const hit = tokenCache.get(creds.refreshToken);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const res = await fetch(google.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId, client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken, grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Google token refresh failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { access_token: string; expires_in?: number };
  tokenCache.set(creds.refreshToken, { token: body.access_token, exp: Date.now() + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

async function drive<T>(creds: DriveCreds, google: Google, path: string, init: RequestInit = {}): Promise<T> {
  const token = await getAccessToken(creds, google);
  const res = await fetch(`${google.apiBaseUrl}/drive/v3${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Drive API ${init.method ?? 'GET'} ${path.split('?')[0]} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const FOLDER = 'application/vnd.google-apps.folder';
/** Escape a value for a Drive `q` string literal. */
export const q = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export async function findChild(creds: DriveCreds, google: Google, parentId: string, name: string, foldersOnly = false): Promise<{ id: string; mimeType: string } | null> {
  const query = `name = '${q(name)}' and '${q(parentId)}' in parents and trashed = false${foldersOnly ? ` and mimeType = '${FOLDER}'` : ''}`;
  const r = await drive<{ files: { id: string; mimeType: string }[] }>(creds, google,
    `/files?q=${encodeURIComponent(query)}&fields=files(id,mimeType)&pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  return r.files[0] ?? null;
}

/** Find or create a folder by name under parentId ('root' for My Drive). Returns its id. */
export async function ensureFolder(creds: DriveCreds, google: Google, parentId: string, name: string): Promise<string> {
  const existing = await findChild(creds, google, parentId, name, true);
  if (existing) return existing.id;
  const created = await drive<{ id: string }>(creds, google, '/files?fields=id&supportsAllDrives=true', {
    method: 'POST', body: JSON.stringify({ name, mimeType: FOLDER, parents: [parentId] }),
  });
  return created.id;
}

/** Resolve (creating as needed) a nested folder path under rootId. */
export async function ensureFolderPath(creds: DriveCreds, google: Google, rootId: string, segments: string[]): Promise<string> {
  let id = rootId;
  for (const s of segments) id = await ensureFolder(creds, google, id, s);
  return id;
}

/** Share a folder read-only with anyone-with-link, or with one email address. Idempotent enough for our use. */
export async function shareFolder(creds: DriveCreds, google: Google, folderId: string, target: 'anyone' | { email: string }): Promise<void> {
  const body = target === 'anyone' ? { type: 'anyone', role: 'reader' } : { type: 'user', role: 'reader', emailAddress: target.email };
  await drive(creds, google, `/files/${encodeURIComponent(folderId)}/permissions?supportsAllDrives=true&sendNotificationEmail=false`, {
    method: 'POST', body: JSON.stringify(body),
  });
}

export async function getFile(creds: DriveCreds, google: Google, fileId: string): Promise<{ id: string; name: string; webViewLink?: string }> {
  return drive(creds, google, `/files/${encodeURIComponent(fileId)}?fields=id,name,webViewLink&supportsAllDrives=true`);
}

export const folderUrl = (folderId: string): string => `https://drive.google.com/drive/folders/${folderId}`;
