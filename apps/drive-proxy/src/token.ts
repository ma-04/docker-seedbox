import { HttpError, type Env } from './types';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SKEW_MS = 60_000;

let cached: { token: string; expiresAt: number } | null = null;
let inflight: Promise<string> | null = null;

export function resetTokenCache(): void {
  cached = null;
  inflight = null;
}

async function refresh(env: Env): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GDRIVE_CLIENT_ID,
      client_secret: env.GDRIVE_CLIENT_SECRET,
      refresh_token: env.GDRIVE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    console.error(`token refresh failed: HTTP ${res.status}`);
    await res.body?.cancel();
    throw new HttpError(502, 'Upstream error');
  }
  const json = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
  if (!json?.access_token) {
    console.error('token refresh returned no access_token');
    throw new HttpError(502, 'Upstream error');
  }
  cached = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return json.access_token;
}

export function getAccessToken(env: Env, forceRefreshOf?: string): Promise<string> {
  // forceRefreshOf: the token that just got a 401; only refresh if it is still the cached one.
  if (cached && cached.token !== forceRefreshOf && cached.expiresAt - SKEW_MS > Date.now()) return Promise.resolve(cached.token);
  if (!inflight) {
    inflight = refresh(env).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}
