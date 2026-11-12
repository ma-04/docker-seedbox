/**
 * Wire types for the REST API (JSON). The web app imports this file type-only.
 * Timestamps are unix seconds; progress values are 0..1; speeds are bytes/second.
 * Errors: HTTP 4xx/5xx with `{ error: { code: string, message: string } }`.
 */
import type { Settings } from './settings.js';
import type { DestinationType, JobState, VpnStatus } from './types.js';

export interface ErrorDto { error: { code: string; message: string } }

export interface MeDto {
  user: { id: number; username: string; email: string | null; displayName: string | null };
  isAdmin: boolean;
  limits: { maxActiveJobs: number; maxTorrentBytes: number };
  /** What deleting a completed job does to its files: local files are always deleted; S3 files only when true; Drive files are kept. */
  cleanup: { deleteRemoteOnJobDelete: boolean };
  /** True when an admin has configured the Google OAuth client, so "Connect Google Drive" can work. */
  googleConnectAvailable: boolean;
  /** Authelia logout URL (or null in external auth mode). */
  logoutUrl: string | null;
  /** Torrent search is configured (SEARCH_BACKEND); false = the UI hides it and /api/search* answers 404. */
  searchEnabled: boolean;
}

export interface DestinationDto {
  id: number;
  name: string;
  type: DestinationType;
  /** true = admin-managed, visible to everyone; false = owned by the current user. */
  shared: boolean;
  enabled: boolean;
  isDefault: boolean;
  /** Masked config (secrets = "********"). Empty object when a non-admin views a shared destination. */
  config: Record<string, unknown>;
  createdAt: number;
}

/** POST /destinations (own, s3 only) and POST /admin/destinations (any type). */
export interface DestinationCreateDto {
  name: string;
  type: DestinationType;
  /** Fields of GDriveConfig | S3Config | LocalConfig without `type`. */
  config: Record<string, unknown>;
  /**
   * Admin only, optional: one rclone config section (`[name]` + key=value lines) of type `drive` or `s3`.
   * Its credentials (client id/secret, refresh token, root_folder_id / endpoint, keys) fill in missing `config` fields.
   */
  rcloneConfig?: string;
  enabled?: boolean;
  isDefault?: boolean;
}
export interface DestinationUpdateDto { name?: string; config?: Record<string, unknown>; enabled?: boolean; isDefault?: boolean }
export interface TestResultDto { ok: boolean; message: string }

export interface JobDto {
  id: number;
  state: JobState;
  name: string | null;
  infohash: string;
  totalSize: number;
  downloadProgress: number;
  downloadSpeed: number;
  uploadProgress: number;
  uploadSpeed: number;
  destination: { id: number; name: string; type: DestinationType };
  error: string | null;
  folderUrl: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  /** Present on admin listings only. */
  user?: { id: number; username: string };
}
/** POST /jobs as JSON; the multipart variant has fields `torrent` (file) and `destinationId`. */
export interface JobCreateDto { magnet: string; destinationId: number }
export interface JobFilesDto { folderUrl: string | null; files: { path: string; size: number; url: string | null }[] }

export interface VpnConfigDto {
  id: number; name: string; endpointHost: string | null; enabled: boolean;
  lastUsedAt: number | null; lastError: string | null; active: boolean; createdAt: number;
}
export interface VpnConfigCreateDto { name: string; config: string }
export interface VpnConfigUpdateDto { name?: string; enabled?: boolean; config?: string }
/** GET /admin/vpn/status. `reachable` false = the vpn sidecar did not answer (other fields are then defaults). */
export interface VpnStatusDto extends VpnStatus { reachable: boolean; activeConfigId: number | null }
export interface VpnRotateDto { configId?: number }

/** GET/PUT /admin/settings. `google.oauthClientSecret` is masked on read; PUT accepts a partial object. */
export type SettingsDto = Omit<Settings, Extract<keyof Settings, `trackers.${string}` | `search.${string}`>>;

// ---- torrent search (docs/architecture.md § Torrent search) ----
export type SearchCategoryId = 'movies' | 'tv' | 'music' | 'audiobooks' | 'books' | 'software' | 'games' | 'anime' | 'other' | 'xxx';
/** GET /search/meta: what the search form may offer (enabled categories only). */
export interface SearchMetaDto {
  categories: { id: SearchCategoryId; label: string }[];
  indexers: { id: string; name: string }[];
  /** false when the indexer list could not be loaded (the filter is then hidden; searching may still work). */
  indexersOk: boolean;
}
/** One result of GET /search?q=&cat=&indexer=. `token` is opaque: pass it to POST /search/add as is (expires after 30 min). */
export interface SearchResultDto {
  token: string;
  title: string;
  size: number;
  seeders: number;
  leechers: number;
  indexer: { id: string | null; name: string | null };
  category: SearchCategoryId;
  publishedAt: number | null;
}
export interface SearchResponseDto { results: SearchResultDto[]; cached: boolean }
/** POST /search/add. Answers like POST /jobs (201 new job, 200 existing one). */
export interface SearchAddDto { token: string; destinationId: number }
/** GET/PUT /admin/search. */
export interface SearchAdminDto {
  enabled: boolean;
  backend: 'jackett' | null;
  /** Where the backend's own admin UI is proxied for admins (e.g. "/jackett/"), or null. */
  uiPath: string | null;
  reachable: boolean;
  indexerCount: number | null;
  /** Short, fixed text when the backend is not reachable / refused. */
  error: string | null;
  /** FlareSolverr companion: not enabled, or whether the VPN sidecar can reach it on loopback. */
  flaresolverr: 'disabled' | 'ok' | 'unreachable';
  categories: { id: SearchCategoryId; label: string; enabled: boolean }[];
  /** The admin's VPN mode. With `off`, search answers 503 `search_vpn_off` unless `allowWithoutVpn`. */
  vpnMode: 'off' | 'required';
  allowWithoutVpn: boolean;
}
export interface SearchAdminUpdateDto { disabledCategories?: SearchCategoryId[]; allowWithoutVpn?: boolean }

/** GET/PUT /admin/trackers. See docs/architecture.md § Tracker lists. */
export interface TrackerListStatusDto {
  url: string; lastFetchedAt: number | null; lastAttemptAt: number | null; ok: boolean; error: string | null; trackerCount: number;
}
export interface TrackersDto {
  enabled: boolean; urls: string[]; refreshHours: number; maxTrackers: number;
  lists: TrackerListStatusDto[];
  /** manualCount: the admin's own trackers. effectiveCount: what the engine is given (manual + fetched, deduplicated, capped). */
  manualCount: number; effectiveCount: number;
  refreshRequestedAt: number | null;
}
export interface TrackersUpdateDto { urls?: string[]; refreshHours?: number; maxTrackers?: number }

export interface UserDto {
  id: number; username: string; email: string | null; displayName: string | null; isAdmin: boolean;
  disabled: boolean; maxActiveJobs: number | null; activeJobs: number; createdAt: number; lastSeenAt: number;
}
export interface UserUpdateDto { disabled?: boolean; maxActiveJobs?: number | null }

/** SSE on GET /events: `event: job` with `data: JobDto` whenever one of the caller's jobs changes; `event: ping` every 20 s. */

/**
 * GET/PUT /admin/engine/settings: a fixed whitelist of qBittorrent preferences (never the WebUI itself).
 * Speeds are KB/s (1 KB = 1024 B; qBittorrent's API uses bytes/s), 0 = unlimited.
 * Connection/upload-slot/queue limits: -1 = unlimited (0 is accepted on write and treated as unlimited by qBittorrent).
 * `listenPort` is 0 while `randomPort` is on. `addTrackers` is newline-separated.
 */
export interface EngineSettingsDto {
  downloadLimitKBps: number; uploadLimitKBps: number;
  maxConnections: number; maxConnectionsPerTorrent: number; maxUploads: number; maxUploadsPerTorrent: number;
  queueingEnabled: boolean; maxActiveDownloads: number; maxActiveUploads: number; maxActiveTorrents: number;
  dht: boolean; pex: boolean; lsd: boolean; encryption: 'prefer' | 'require' | 'disable'; anonymousMode: boolean;
  listenPort: number; randomPort: boolean;
  addTrackersEnabled: boolean; addTrackers: string;
}
export type EngineSettingsUpdateDto = Partial<EngineSettingsDto>;
