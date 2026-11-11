import { validation } from './errors.js';

/** Credentials extracted from one rclone config section; keys use our config field names. */
export interface RcloneParsed { type: 'gdrive' | 's3'; fields: Record<string, string> }

export function parseRcloneConfig(text: string): RcloneParsed {
  if (text.length > 16_384) throw validation('rcloneConfig is too large');
  const kv: Record<string, string> = {};
  let seenSection = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[')) {
      if (seenSection) break; // only the first section
      seenSection = true;
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    kv[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  const out: Record<string, string> = {};
  const set = (k: string, v: string | undefined) => { if (v) out[k] = v; };
  if (kv.type === 'drive') {
    set('clientId', kv.client_id);
    set('clientSecret', kv.client_secret);
    set('rootFolderId', kv.root_folder_id);
    if (kv.token) {
      try {
        const t = JSON.parse(kv.token) as { refresh_token?: unknown };
        if (typeof t.refresh_token === 'string') set('refreshToken', t.refresh_token);
      } catch {
        throw validation('rcloneConfig: token is not valid JSON');
      }
    }
    return { type: 'gdrive', fields: out };
  }
  if (kv.type === 's3') {
    set('endpoint', kv.endpoint);
    set('region', kv.region);
    set('accessKeyId', kv.access_key_id);
    set('secretAccessKey', kv.secret_access_key);
    return { type: 's3', fields: out };
  }
  throw validation('rcloneConfig: type must be "drive" or "s3"');
}
