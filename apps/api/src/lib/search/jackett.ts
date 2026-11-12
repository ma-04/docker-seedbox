/**
 * Jackett (Torznab) search backend. Jackett runs in the VPN sidecar's network namespace, so every tracker-site request it
 * makes goes through the tunnel (or nowhere, while the kill switch holds); the API only ever talks to Jackett itself, at
 * the exact configured origin (`JACKETT_URL`, compose: http://vpn:9117), which the sidecar's firewall opens to the api
 * container alone.
 *
 * The API key never leaves this file: it is added to each request URL here, stripped from every link Jackett returns
 * (`jackett_apikey`), and request URLs never appear in errors or logs.
 *
 * Downloads (`download()`): the link must point at Jackett's own `/dl/` endpoint on the configured origin; that is the
 * one narrow exemption from the SSRF guard (an internal compose host, so `assertPublicEndpoint` would refuse it).
 * Redirects are followed by hand: `magnet:` is returned for the caller to validate; another Jackett `/dl/` URL is
 * followed (at most 3 hops); anything else is refused. A public http(s) target is checked with the SSRF guard (so the
 * reason is precise) but still NOT fetched: the API container is outside the VPN namespace and would leak its address
 * to the tracker site. In practice Jackett follows such redirects itself (inside the VPN) and never hands one back.
 */
import { assertPublicEndpoint, NetGuardError, type GuardOptions } from '../netguard.js';
import { SearchError, type Download, type IndexerInfo, type SearchBackend, type SearchHit, type SearchQuery } from './backend.js';
import { parseTorznabIndexers, parseTorznabResults } from './torznab.js';

export const JACKETT_BASE_PATH = '/jackett';
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_TORRENT_BYTES = 5 * 1024 * 1024;
export const MAX_MAGNET_CHARS = 16 * 1024;
export const MAX_DOWNLOAD_HOPS = 3;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface JackettOptions {
  /** Origin only, e.g. http://vpn:9117 (validated by lib/config.ts). */
  origin: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Search and indexer list. Jackett waits for its slowest indexer (its own per-indexer timeout applies). */
  timeoutMs?: number;
  downloadTimeoutMs?: number;
  maxResponseBytes?: number;
  /** DNS seam for the SSRF guard (tests). */
  lookup?: GuardOptions['lookup'];
}

/** Read a body, refusing more than `max` bytes (declared or actual). */
async function readCapped(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new SearchError('bad_response', 'The search backend response is too large');
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new SearchError('bad_response', 'The search backend response is too large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export class JackettBackend implements SearchBackend {
  readonly kind = 'jackett' as const;
  readonly uiPath = `${JACKETT_BASE_PATH}/`;
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: JackettOptions) {
    this.origin = new URL(o.origin).origin;
    this.fetchImpl = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  }

  private torznabUrl(indexer: string | null, params: Record<string, string>): string {
    const u = new URL(`${this.origin}${JACKETT_BASE_PATH}/api/v2.0/indexers/${encodeURIComponent(indexer ?? 'all')}/results/torznab/api`);
    u.searchParams.set('apikey', this.o.apiKey);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.href;
  }

  private async get(url: string, timeoutMs: number, signal?: AbortSignal, redirect: RequestRedirect = 'error'): Promise<Response> {
    const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
    try {
      return await this.fetchImpl(url, {
        method: 'GET', redirect, signal: AbortSignal.any(signals),
        headers: { accept: 'application/rss+xml, application/xml, application/x-bittorrent, */*;q=0.1', 'user-agent': 'docker-seedbox' },
      });
    } catch (e) {
      const name = (e as { name?: string }).name;
      // Never the URL (it carries the API key) and never the upstream text.
      throw new SearchError('unavailable', name === 'TimeoutError' || name === 'AbortError' ? 'The search backend did not answer in time' : 'The search backend is unreachable');
    }
  }

  private async torznab(url: string, signal?: AbortSignal): Promise<string> {
    const res = await this.get(url, this.o.timeoutMs ?? 45_000, signal);
    const body = await readCapped(res, this.o.maxResponseBytes ?? MAX_RESPONSE_BYTES);
    // Torznab reports errors as <error code=.. description=..> (Jackett: with HTTP 200 or 4xx); parse those too.
    if (res.status >= 500) throw new SearchError('unavailable', `The search backend failed (HTTP ${res.status})`);
    if (res.status !== 200 && !body.subarray(0, 512).toString('utf8').includes('<error')) {
      throw new SearchError(res.status === 401 || res.status === 403 ? 'rejected' : 'unavailable', `The search backend failed (HTTP ${res.status})`);
    }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { throw new SearchError('bad_response', 'The search backend sent an invalid response (not UTF-8)'); }
    return text;
  }

  async search(q: SearchQuery, signal?: AbortSignal): Promise<SearchHit[]> {
    const xml = await this.torznab(this.torznabUrl(q.indexer, { t: 'search', q: q.q, cat: q.cats.join(','), limit: '100' }), signal);
    const { items } = parseTorznabResults(xml);
    const hits: SearchHit[] = [];
    for (const it of items) {
      const link = this.toRef(it.link);
      // A link can itself be a magnet; the explicit magneturl attribute wins.
      const magnet = it.magnet ?? (it.link && /^magnet:\?/i.test(it.link) ? it.link : null);
      if (!magnet && !link) continue; // nothing we could add
      hits.push({ ...it, magnet: magnet && magnet.length <= MAX_MAGNET_CHARS ? magnet : null, link });
    }
    return hits.filter((h) => h.magnet || h.link);
  }

  async indexers(signal?: AbortSignal): Promise<IndexerInfo[]> {
    return parseTorznabIndexers(await this.torznab(this.torznabUrl(null, { t: 'indexers', configured: 'true' }), signal));
  }

  /**
   * A Jackett download URL as a secret-free reference (path + query without the API key), or null when the URL is not
   * Jackett's own /dl/ endpoint on the configured origin.
   */
  toRef(raw: string | null): string | null {
    if (!raw || raw.length > 8192) return null;
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    if (!this.isDlUrl(u)) return null;
    u.searchParams.delete('jackett_apikey');
    u.searchParams.delete('apikey');
    return u.pathname + u.search;
  }

  /** The SSRF exemption: the exact configured origin, Jackett's /dl/ path, no credentials. Nothing else. */
  isDlUrl(u: URL): boolean {
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === this.origin && !u.username && !u.password
      && u.pathname.startsWith(`${JACKETT_BASE_PATH}/dl/`) && !u.pathname.split('/').some((s) => s === '..' || s === '.');
  }

  async download(ref: string, signal?: AbortSignal): Promise<Download> {
    if (!ref.startsWith(`${JACKETT_BASE_PATH}/dl/`)) throw new SearchError('link_refused', 'This result has no downloadable link');
    let url = new URL(this.origin + ref);
    if (!this.isDlUrl(url)) throw new SearchError('link_refused', 'This result has no downloadable link');
    for (let hop = 0; ; hop++) {
      url.searchParams.set('jackett_apikey', this.o.apiKey);
      const res = await this.get(url.href, this.o.downloadTimeoutMs ?? 60_000, signal, 'manual');
      if (REDIRECTS.has(res.status)) {
        await res.body?.cancel().catch(() => {});
        const loc = res.headers.get('location');
        if (!loc) throw new SearchError('bad_response', 'The search backend sent a redirect without a target');
        if (/^magnet:/i.test(loc.trim())) {
          if (loc.length > MAX_MAGNET_CHARS) throw new SearchError('bad_response', 'The magnet link is too long');
          return { kind: 'magnet', magnet: loc.trim() };
        }
        let next: URL;
        try { next = new URL(loc, url); } catch { throw new SearchError('bad_response', 'The search backend sent an invalid redirect'); }
        if (this.isDlUrl(next)) {
          if (hop + 1 >= MAX_DOWNLOAD_HOPS) throw new SearchError('link_refused', 'Too many redirects');
          url = next;
          continue;
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new SearchError('link_refused', 'The indexer link uses an unsupported scheme');
        // Re-validated with the SSRF guard (which says why a private/internal target is refused), but never fetched from
        // here: the API container is outside the VPN namespace.
        try {
          await assertPublicEndpoint(next.href, { allowPrivate: false, lookup: this.o.lookup });
        } catch (e) {
          if (e instanceof NetGuardError) throw new SearchError('link_refused', 'The indexer link redirects to a private or internal address');
          throw e;
        }
        throw new SearchError('link_refused', 'The indexer link points outside Jackett; it is not fetched from outside the VPN');
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {});
        throw new SearchError('unavailable', `Jackett could not download this torrent (HTTP ${res.status})`);
      }
      return { kind: 'torrent', data: await readCapped(res, MAX_TORRENT_BYTES) };
    }
  }
}
