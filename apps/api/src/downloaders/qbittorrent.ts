/** qBittorrent Web API v2 client (fetch). The WebUI whitelists the compose subnet, so no login is normally needed. */
import { DownloaderUnavailableError, type DownloadAddInput, type Downloader, type DownloadState, type DownloadStatus } from './types.js';

export interface QbtOptions {
  baseUrl: string;
  username?: string;
  password?: string;
  category?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface QbtTorrent {
  hash: string; name: string; size?: number; total_size?: number; progress: number; dlspeed: number; state: string;
  ratio: number; content_path: string; save_path: string;
}

const META = new Set(['metaDL', 'forcedMetaDL']);
const ERROR = new Set(['error', 'missingFiles']);
const UPLOAD = new Set(['uploading', 'stalledUP', 'pausedUP', 'stoppedUP', 'queuedUP', 'checkingUP', 'forcedUP']);

/** Map a qBittorrent state string (4.x and 5.x names) to the worker's vocabulary. */
export function mapQbtState(state: string, progress: number): DownloadState {
  if (ERROR.has(state)) return 'error';
  if (META.has(state)) return 'metadata-pending';
  if (state === 'moving') return 'downloading';
  if (UPLOAD.has(state) || progress >= 1) return 'completed';
  return 'downloading';
}

/**
 * qBittorrent's `urls` field is newline separated: anything with a CR/LF would add extra downloads (or make it fetch
 * arbitrary URLs). Exactly one magnet URI, no whitespace or control characters, ever.
 */
export function singleUrl(u: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/^magnet:\?[^\s\u0000-\u001f\u007f-\u009f]+$/i.test(u)) throw new Error('Refusing to send a malformed magnet link to qBittorrent');
  return u;
}

export class QbittorrentDownloader implements Downloader {
  readonly kind = 'torrent';
  private readonly base: string;
  private readonly category: string;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;
  private cookie: string | null = null;
  private categoryReady = false;

  constructor(private readonly opts: QbtOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.category = opts.category ?? 'seedbox';
    this.f = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  private async raw(path: string, init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {}): Promise<Response> {
    const headers: Record<string, string> = { ...init.headers };
    if (this.cookie) headers.cookie = this.cookie;
    try {
      return await this.f(`${this.base}/api/v2${path}`, { ...init, headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new DownloaderUnavailableError(`qBittorrent unreachable (${(err as Error).message})`, { cause: err });
    }
  }

  private async login(): Promise<boolean> {
    const { username, password } = this.opts;
    if (!username || !password) return false;
    const res = await this.raw('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', referer: this.base },
      body: new URLSearchParams({ username, password }).toString(),
    });
    const text = (await res.text()).trim();
    if (!res.ok || text !== 'Ok.') return false;
    const sid = /(?:^|,\s*)(SID=[^;,\s]+)/.exec(res.headers.get('set-cookie') ?? '');
    this.cookie = sid ? sid[1]! : this.cookie;
    return true;
  }

  /** Request with a single login-and-retry on 403. Body must be re-creatable, hence a factory. */
  private async call(path: string, init: () => { method?: string; body?: BodyInit; headers?: Record<string, string> } = () => ({})): Promise<Response> {
    let res = await this.raw(path, init());
    if (res.status === 403 && (await this.login())) res = await this.raw(path, init());
    if (!res.ok && res.status !== 409) {
      const msg = `qBittorrent ${path.split('?')[0]} failed (${res.status})`;
      throw res.status >= 500 || res.status === 403 ? new DownloaderUnavailableError(msg) : new Error(msg);
    }
    return res;
  }

  private form(data: Record<string, string>) {
    return () => ({
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(data).toString(),
    });
  }

  private async ensureCategory(): Promise<void> {
    if (this.categoryReady) return;
    await this.call('/torrents/createCategory', this.form({ category: this.category, savePath: '' })); // 409 = already exists
    this.categoryReady = true;
  }

  async add(input: DownloadAddInput): Promise<void> {
    await this.ensureCategory();
    const build = () => {
      const fd = new FormData();
      if ('magnet' in input.source) fd.append('urls', singleUrl(input.source.magnet));
      else fd.append('torrents', new Blob([new Uint8Array(input.source.torrent)], { type: 'application/x-bittorrent' }), `${input.id}.torrent`);
      fd.append('category', this.category);
      fd.append('savepath', input.savePath);
      fd.append('autoTMM', 'false');
      fd.append('contentLayout', 'Original');
      fd.append('paused', 'false');
      return { method: 'POST', body: fd };
    };
    const res = await this.call('/torrents/add', build);
    const text = (await res.text()).trim();
    if (/^fails/i.test(text)) {
      // qBittorrent answers "Fails." both for invalid input and for an already-present torrent.
      if (await this.status(input.id)) return;
      throw new Error('qBittorrent rejected the torrent');
    }
  }

  async status(ref: string): Promise<DownloadStatus | null> {
    const res = await this.call(`/torrents/info?hashes=${encodeURIComponent(ref.toLowerCase())}`);
    const list = (await res.json()) as QbtTorrent[];
    const t = list.find((x) => x.hash.toLowerCase() === ref.toLowerCase());
    if (!t) return null;
    return {
      state: mapQbtState(t.state, t.progress),
      name: t.name,
      totalSize: t.size ?? t.total_size ?? 0,
      progress: t.progress,
      dlSpeed: t.dlspeed,
      ratio: t.ratio,
      contentPath: t.content_path,
      savePath: t.save_path,
      rawState: t.state,
    };
  }

  async list(): Promise<string[]> {
    const res = await this.call(`/torrents/info?category=${encodeURIComponent(this.category)}`);
    const list = (await res.json()) as QbtTorrent[];
    return list.map((x) => x.hash.toLowerCase());
  }

  async remove(ref: string, deleteData: boolean): Promise<void> {
    await this.call('/torrents/delete', this.form({ hashes: ref.toLowerCase(), deleteFiles: deleteData ? 'true' : 'false' }));
  }

  /** GET /app/preferences. Callers must pick only the keys they need; the full object contains secrets. */
  async getPreferences(): Promise<Record<string, unknown>> {
    const res = await this.call('/app/preferences');
    const j = (await res.json()) as unknown;
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('qBittorrent returned unexpected preferences');
    return j as Record<string, unknown>;
  }

  /** POST /app/setPreferences with form field `json=<object>` (only the given keys are changed). */
  async setPreferences(prefs: Record<string, unknown>): Promise<void> {
    await this.call('/app/setPreferences', this.form({ json: JSON.stringify(prefs) }));
  }
}
