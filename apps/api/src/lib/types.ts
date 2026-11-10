/** Shared domain types. Authoritative schema: migrations/001_init.sql; contract: docs/architecture.md. */
export type JobState = 'queued' | 'downloading' | 'uploading' | 'completed' | 'failed' | 'cancelled';
export type TorrentState = 'pending' | 'downloading' | 'downloaded' | 'error' | 'removed';
export type DestinationType = 'gdrive' | 's3' | 'local';

export interface GDriveConfig {
  type: 'gdrive';
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  rootFolderId: string;
  sharing: 'none' | 'anyone' | 'user';
  proxyBaseUrl?: string;
  proxySigningKey?: string;
  linkTtlSeconds?: number;
}
export interface S3Config {
  type: 's3';
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  prefix?: string;
  forcePathStyle?: boolean;
  publicBaseUrl?: string;
  linkTtlSeconds?: number;
}
export interface LocalConfig {
  type: 'local';
  subdir?: string;
  publicBaseUrl?: string;
  linkTtlSeconds?: number;
}
export type DestinationConfig = GDriveConfig | S3Config | LocalConfig;

/** Fields never returned by the API (replaced by MASK; MASK on update means "unchanged"). */
export const SECRET_FIELDS: Record<DestinationType, readonly string[]> = {
  gdrive: ['clientSecret', 'refreshToken', 'proxySigningKey'],
  s3: ['secretAccessKey'],
  local: [],
};
export const MASK = '********';

export interface UserRow {
  id: number; username: string; email: string | null; display_name: string | null;
  is_admin: number; disabled: number; max_active_jobs: number | null; created_at: number; last_seen_at: number;
}
export interface DestinationRow {
  id: number; owner_user_id: number | null; name: string; type: DestinationType; config_enc: string;
  enabled: number; is_default: number; created_at: number;
}
export interface TorrentRow {
  id: number; infohash: string; name: string | null; source_enc: string; total_size: number; state: TorrentState;
  progress: number; dl_speed: number; save_path: string | null; error: string | null; added_at: number; completed_at: number | null;
}
export interface JobRow {
  id: number; user_id: number; torrent_id: number; destination_id: number; state: JobState;
  upload_progress: number; upload_speed: number; remote_path: string | null; folder_url: string | null;
  error: string | null; created_at: number; updated_at: number; completed_at: number | null;
}
export interface JobFileRow { id: number; job_id: number; path: string; size: number }
export interface VpnConfigRow {
  id: number; name: string; config_enc: string; endpoint_host: string | null; enabled: number;
  last_used_at: number | null; last_error: string | null; created_at: number;
}
/** Decrypted torrents.source_enc */
export type TorrentSource = { magnet: string } | { torrentB64: string };

export interface VpnStatus {
  mode: 'off' | 'required'; connected: boolean; name: string | null; publicIp: string | null;
  lastHandshakeSec: number | null; since: number | null;
}

export const now = (): number => Math.floor(Date.now() / 1000);
export const userSlug = (username: string): string => username.toLowerCase().replace(/[^a-z0-9._-]/g, '_');
