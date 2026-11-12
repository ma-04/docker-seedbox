/**
 * The search backend seam (docs/adr/0001-torrent-search-backend.md). The API talks to "a search backend", never to
 * Jackett directly: routes/search.ts, the result tokens and the add path only see this interface. Jackett (Torznab) is the
 * one implementation today (lib/search/jackett.ts); another Torznab aggregator such as Prowlarr would be a second class
 * selected by `SEARCH_BACKEND`, without touching the routes, the UI or the add path.
 */

export interface SearchQuery {
  /** Free text, already validated (length cap) by the route. */
  q: string;
  /** Torznab standard category ids to ask for (never empty). */
  cats: number[];
  /** One configured indexer's id, or null for all of them. */
  indexer: string | null;
}

export interface SearchHit {
  title: string;
  size: number;
  seeders: number;
  leechers: number;
  indexerId: string | null;
  indexerName: string | null;
  /** Torznab category ids as reported (standard and the tracker's own >= 100000). */
  categories: number[];
  publishedAt: number | null;
  /** A magnet link, when the backend provides one (preferred over `link`). */
  magnet: string | null;
  /**
   * Backend-specific reference for `download()`. Never contains a secret (the Jackett adapter strips its API key) and is
   * never sent to the browser in clear: it travels only inside a sealed result token.
   */
  link: string | null;
}

export interface IndexerInfo { id: string; name: string }

export type Download = { kind: 'magnet'; magnet: string } | { kind: 'torrent'; data: Buffer };

export type SearchErrorCode =
  /** backend unreachable, timed out, or answered with a server error */
  | 'unavailable'
  /** the backend refused the request (bad API key, unknown indexer) */
  | 'rejected'
  /** the response is not what the protocol says (malformed or hostile XML, size cap) */
  | 'bad_response'
  /** a download link or redirect that we will not follow (outside the backend, private address, unknown scheme) */
  | 'link_refused';

/** `message` is safe to show to any user: it never carries upstream bodies, URLs or the API key. */
export class SearchError extends Error {
  constructor(readonly code: SearchErrorCode, message: string) { super(message); }
}

export interface SearchBackend {
  readonly kind: 'jackett';
  /** Path of the backend's own admin UI on APP_HOST (proxied for admins only), or null when it has none. */
  readonly uiPath: string | null;
  search(query: SearchQuery, signal?: AbortSignal): Promise<SearchHit[]>;
  /** Configured indexers (for the filter and the admin status card). */
  indexers(signal?: AbortSignal): Promise<IndexerInfo[]>;
  /** Resolve a hit's `link` to a magnet or the bytes of a .torrent file (still untrusted: the caller validates). */
  download(link: string, signal?: AbortSignal): Promise<Download>;
}
