/**
 * Search front of the API: a short-TTL result cache per (query, categories, indexer), coalescing of identical in-flight
 * searches, and concurrency caps (per user and in total) so a few users cannot pin the backend (Jackett fans every
 * query out to every indexer). Results are cached WITHOUT tokens: tokens are user-bound and minted per response.
 */
import type { IndexerInfo, SearchBackend, SearchHit, SearchQuery } from './backend.js';

export class SearchBusyError extends Error {
  constructor(readonly scope: 'user' | 'global') { super(scope === 'user' ? 'You already have searches running; wait for them to finish' : 'The search backend is busy; try again in a moment'); }
}

export interface SearchServiceOptions {
  ttlMs?: number; maxEntries?: number; perUser?: number; global?: number; indexerTtlMs?: number; nowMs?: () => number;
}

export class SearchService {
  private readonly cache = new Map<string, { at: number; hits: SearchHit[] }>();
  private readonly inflight = new Map<string, Promise<SearchHit[]>>();
  private readonly running = new Map<number, number>();
  private total = 0;
  private indexerCache: { at: number; list: IndexerInfo[] } | null = null;
  private readonly o: Required<SearchServiceOptions>;

  constructor(readonly backend: SearchBackend, o: SearchServiceOptions = {}) {
    this.o = { ttlMs: 5 * 60_000, maxEntries: 200, perUser: 2, global: 8, indexerTtlMs: 60_000, nowMs: Date.now, ...o };
  }

  static normalise(q: string): string { return q.normalize('NFC').replace(/\s+/g, ' ').trim(); }
  static key(q: SearchQuery): string { return JSON.stringify([SearchService.normalise(q.q).toLowerCase(), [...q.cats].sort((a, b) => a - b), q.indexer]); }

  async search(userId: number, query: SearchQuery): Promise<{ hits: SearchHit[]; cached: boolean }> {
    const q = { ...query, q: SearchService.normalise(query.q) };
    const key = SearchService.key(q);
    const now = this.o.nowMs();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < this.o.ttlMs) return { hits: hit.hits, cached: true };

    if ((this.running.get(userId) ?? 0) >= this.o.perUser) throw new SearchBusyError('user');
    let p = this.inflight.get(key);
    if (!p && this.total >= this.o.global) throw new SearchBusyError('global');
    this.running.set(userId, (this.running.get(userId) ?? 0) + 1);
    try {
      if (!p) {
        this.total++;
        p = this.backend.search(q).finally(() => { this.total--; this.inflight.delete(key); });
        this.inflight.set(key, p);
        p.then((hits) => this.put(key, hits), () => {});
      }
      return { hits: await p, cached: false };
    } finally {
      const n = (this.running.get(userId) ?? 1) - 1;
      if (n <= 0) this.running.delete(userId); else this.running.set(userId, n);
    }
  }

  private put(key: string, hits: SearchHit[]): void {
    const now = this.o.nowMs();
    for (const [k, v] of this.cache) if (now - v.at >= this.o.ttlMs) this.cache.delete(k);
    while (this.cache.size >= this.o.maxEntries) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { at: now, hits });
  }

  /** Configured indexers, cached briefly (`fresh` bypasses the cache: admin status card). */
  async indexers(fresh = false): Promise<IndexerInfo[]> {
    const now = this.o.nowMs();
    if (!fresh && this.indexerCache && now - this.indexerCache.at < this.o.indexerTtlMs) return this.indexerCache.list;
    const list = await this.backend.indexers();
    this.indexerCache = { at: now, list };
    return list;
  }
}
