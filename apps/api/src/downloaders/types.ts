/**
 * Pluggable download backend (docs/architecture.md § Downloader interface).
 * The worker only talks to this interface; today `torrent` (qBittorrent) is the single implementation.
 * A future direct-link / Drive-source downloader implements the same three calls and is selected by
 * `kind`, without touching the job state machine.
 */
export type DownloadSource =
  | { magnet: string }
  | { torrent: Buffer };

export interface DownloadAddInput {
  /** Stable identifier of the download (for torrents: lowercase hex infohash). Used as `ref` afterwards. */
  id: string;
  source: DownloadSource;
  /** Absolute directory the content must be written to. */
  savePath: string;
}

export type DownloadState = 'downloading' | 'completed' | 'error' | 'metadata-pending';

export interface DownloadStatus {
  state: DownloadState;
  name: string;
  /** Total bytes to download (0 while metadata is pending). */
  totalSize: number;
  /** 0..1 */
  progress: number;
  /** bytes/s */
  dlSpeed: number;
  /** Share ratio (seeding); 0 for downloaders that do not seed. */
  ratio: number;
  /** Absolute path of the downloaded file (single) or root folder (multi). */
  contentPath: string;
  savePath: string;
  /** Raw backend state, for logs/diagnostics only. */
  rawState?: string;
}

export interface Downloader {
  readonly kind: string;
  /** Idempotent: adding something that is already present must succeed. */
  add(input: DownloadAddInput): Promise<void>;
  /** `null` when the downloader does not know the ref (never added, or removed behind our back). */
  status(ref: string): Promise<DownloadStatus | null>;
  remove(ref: string, deleteData: boolean): Promise<void>;
  /** Lowercase ids of everything the downloader holds in the app's category (used to find torrents we do not track). */
  list(): Promise<string[]>;
}

/**
 * The downloader could not be reached or answered with a server/auth error (restarting, network down).
 * Says nothing about the torrent itself: callers must never fail jobs because of it.
 */
export class DownloaderUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) { super(message, options); this.name = 'DownloaderUnavailableError'; }
}
