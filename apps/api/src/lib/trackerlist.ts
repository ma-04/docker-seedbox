/**
 * Tracker-list parsing and fetching (docs/architecture.md § Tracker lists).
 *
 * The app, not qBittorrent, downloads the lists: every hop is vetted with the SSRF guard, the TCP connection itself is
 * pinned to a vetted address (vettedLookup), redirects are followed by hand (max 3, each hop re-vetted), the body is capped
 * and the request has a deadline. Every entry is filtered with the SAME policy as user-submitted trackers (sanitiseTracker).
 */
import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { assertPublicEndpoint, NetGuardError, parseHttpUrl, type GuardOptions } from './netguard.js';
import { vettedLookup, type ResolveAll } from './s3client.js';
import { sanitiseTracker } from './source.js';

export class TrackerListError extends Error {}

export const MAX_LIST_BYTES = 1024 * 1024;
export const MAX_LIST_URLS = 5;
export const MAX_ENTRY_CHARS = 512;
export const MAX_URL_CHARS = 2048;
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 3;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

// ---------------------------------------------------------------- parsing

export interface ParsedList {
  trackers: string[];
  /** Tokens that failed the tracker policy or were too long. */
  invalid: number;
  duplicates: number;
  /** Valid, unique entries beyond `max`. */
  overCap: number;
  sha256: string;
}

/** Canonical form: scheme and host lower-cased, IDN host punycoded (also for udp:, whose host the URL parser leaves opaque). */
function normalise(href: string): string | null {
  const u = new URL(href);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ascii = host.includes(':') ? host.toLowerCase() : domainToASCII(host.toLowerCase());
  if (!ascii) return null;
  const h = ascii.includes(':') ? `[${ascii}]` : ascii;
  return `${u.protocol}//${h}${u.port ? `:${u.port}` : ''}${u.pathname}${u.search}${u.hash}`;
}

/**
 * One tracker per line; blank lines and `#` comments are ignored; commas and whitespace also separate entries.
 * Throws TrackerListError when the body does not look like a tracker list (HTML, binary, mostly garbage, nothing usable);
 * the caller then keeps the previous good list.
 */
export function parseTrackerList(body: Buffer | string, max: number): ParsedList {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  if (buf.includes(0)) throw new TrackerListError('The response is binary, not a tracker list');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { throw new TrackerListError('The response is not valid UTF-8 text'); }
  if (/<\s*(!doctype|html|head|body)\b/i.test(text.slice(0, 4096))) throw new TrackerListError('The response looks like a web page, not a tracker list');

  const seen = new Set<string>();
  const trackers: string[] = [];
  let tokens = 0, invalid = 0, duplicates = 0, overCap = 0;
  for (const line of text.replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    for (const tok of l.split(/[\s,]+/)) {
      if (!tok) continue;
      tokens++;
      const clean = tok.length > MAX_ENTRY_CHARS ? null : sanitiseTracker(tok);
      const norm = clean ? normalise(clean) : null;
      if (!norm) { invalid++; continue; }
      if (seen.has(norm)) { duplicates++; continue; }
      seen.add(norm);
      if (trackers.length >= max) { overCap++; continue; }
      trackers.push(norm);
    }
  }
  if (tokens === 0) throw new TrackerListError('The list is empty');
  if (invalid / tokens > 0.2) throw new TrackerListError('Too many entries are not valid trackers');
  if (trackers.length === 0) throw new TrackerListError('The list contains no usable trackers');
  return { trackers, invalid, duplicates, overCap, sha256: createHash('sha256').update(buf).digest('hex') };
}

// ---------------------------------------------------------------- fetching

export type GuardFn = (url: string) => Promise<URL>;
export interface Response { status: number; headers: IncomingMessage['headers']; body: AsyncIterable<Buffer | string>; destroy(): void }
export type RequestFn = (url: URL, o: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

export interface FetchOptions {
  /** Called with every URL (first request and each redirect hop) immediately before it is requested. */
  guard?: GuardFn;
  request?: RequestFn;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Test seam for the default guard / request. */
  lookup?: GuardOptions['lookup'];
  resolve?: ResolveAll;
  /** TEST ONLY (config.trackerListAllowPrivate): allow http and private addresses. */
  allowPrivate?: boolean;
}

/** Default transport: https with a connect-time vetted lookup (no DNS-rebinding window); plain http only in allowPrivate mode. */
export function makeRequest(o: { allowPrivate?: boolean; resolve?: ResolveAll } = {}): RequestFn {
  return (url, { signal, headers }) => new Promise((resolve, reject) => {
    const https = url.protocol === 'https:';
    const opts = {
      method: 'GET', headers, signal, agent: false as const,
      ...(o.allowPrivate ? {} : { lookup: vettedLookup(o.resolve) }),
    };
    const req = (https ? httpsRequest : httpRequest)(url, opts, (res) => {
      resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res, destroy: () => res.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}

function safeMessage(e: unknown): string {
  if (e instanceof TrackerListError || e instanceof NetGuardError) return e.message;
  const code = (e as { code?: string }).code;
  const name = (e as { name?: string }).name;
  if (name === 'AbortError' || name === 'TimeoutError' || code === 'ABORT_ERR' || code === 'ETIMEDOUT') return 'The request timed out';
  if (code === 'EBLOCKED') return 'List host is not publicly routable';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'List host could not be resolved';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'Could not connect to the list host';
  if (typeof code === 'string' && code.startsWith('ERR_TLS') || code === 'CERT_HAS_EXPIRED' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return 'TLS certificate check failed';
  return 'Could not download the list';
}

/** Download one list body. Throws TrackerListError whose message is safe to store and show. */
export async function fetchTrackerListBody(url: string, opts: FetchOptions = {}): Promise<Buffer> {
  const guard: GuardFn = opts.guard ?? (opts.allowPrivate
    ? async (u) => parseHttpUrl(u)
    : (u) => assertPublicEndpoint(u, { allowPrivate: false, lookup: opts.lookup }));
  const request = opts.request ?? makeRequest({ allowPrivate: opts.allowPrivate, resolve: opts.resolve });
  const maxBytes = opts.maxBytes ?? MAX_LIST_BYTES;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      const u = await guard(current); // immediately before the request; the connection is pinned to a vetted address
      const res = await request(u, {
        signal: ac.signal,
        headers: { 'user-agent': 'docker-seedbox', accept: 'text/plain, */*;q=0.1', 'accept-encoding': 'identity' },
      });
      if (REDIRECTS.has(res.status)) {
        res.destroy();
        const loc = res.headers.location;
        if (!loc) throw new TrackerListError('Redirect without a location');
        if (hop >= maxRedirects) throw new TrackerListError('Too many redirects');
        try { current = new URL(loc, u).href; } catch { throw new TrackerListError('Invalid redirect location'); }
        continue;
      }
      if (res.status !== 200) { res.destroy(); throw new TrackerListError(`The server answered HTTP ${res.status}`); }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) { res.destroy(); throw new TrackerListError('The list is too large'); }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of res.body) {
        const b = typeof c === 'string' ? Buffer.from(c) : c;
        size += b.length;
        if (size > maxBytes) { res.destroy(); throw new TrackerListError('The list is too large'); }
        chunks.push(b);
      }
      return Buffer.concat(chunks);
    }
  } catch (e) {
    throw new TrackerListError(safeMessage(e));
  } finally { clearTimeout(timer); }
}
