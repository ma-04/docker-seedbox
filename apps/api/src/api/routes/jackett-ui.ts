/**
 * Admin-only passthrough to Jackett's own web UI (indexer management) at https://APP_HOST/jackett/.
 *
 * Why through the API and not straight from the gateway: the VPN sidecar's firewall lets exactly ONE address open
 * connections to Jackett's port, the api container's, and the admin check stays where every other admin check is (the
 * requireAdmin plugin), identical in AUTH_MODE=authelia and external and in every hosts layout.
 *
 * What crosses: method, path + query, the body (<= 1 MiB), a handful of content headers, and only Jackett's own cookies
 * (the login cookie of this app, Remote-*, X-Gateway-Secret, Authorization and X-Forwarded-* never reach Jackett).
 * Back: status, content headers, Jackett's own Set-Cookie, and Location rewritten to a path on this host.
 * Writes must be same-origin (Origin / Sec-Fetch-Site): the X-Requested-With CSRF rule only covers /api/*.
 *
 * Jackett's API key never reaches the browser: it is removed from every text response (Jackett's UI shows it, and builds
 * download / feed / manual-search URLs with it) and from Location, so it cannot end up in browser history, the gateway's
 * error log or a copied link; requests that carry an `apikey` / `jackett_apikey` parameter (now empty) get the real key
 * added here, and a server-config save keeps the real key. Responses carry a restrictive CSP (Jackett's UI needs
 * `'unsafe-eval'` for its Handlebars templates and inline styles; nothing from other origins, no framing).
 */
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { JACKETT_BASE_PATH } from '../../lib/search/jackett.js';
import type { Ctx } from '../context.js';
import { ApiError } from '../errors.js';

export const MAX_UI_BODY = 1024 * 1024;
const UI_TIMEOUT_MS = 120_000;
/** Cookies Jackett itself sets (auth cookie + its "cookies enabled" probe). Everything else stays with us. */
const JACKETT_COOKIES = new Set(['Jackett', 'TestCookie']);
const REQ_HEADERS = ['accept', 'accept-language', 'content-type', 'cache-control', 'if-none-match', 'if-modified-since', 'x-requested-with'];
const RES_HEADERS = ['content-type', 'cache-control', 'etag', 'last-modified', 'expires', 'content-disposition', 'vary'];
const KEY_PARAMS = ['apikey', 'jackett_apikey'];
/** Text responses are buffered (to remove the key) up to this size; Jackett's largest (the indexer list) is ~2 MB. */
export const MAX_TEXT_RESPONSE = 16 * 1024 * 1024;
const TEXT_TYPE = /^(text\/|application\/(json|javascript|x-javascript|xml|rss\+xml|xhtml\+xml)|[^;]*\+json)/i;
export const JACKETT_UI_CSP = "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; "
  + "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; "
  + "frame-ancestors 'none'";

/** Path + query with the real key put into every (present) key parameter; anything else unchanged. */
export function withServerKey(pathAndQuery: string, key: string): string {
  const q = pathAndQuery.indexOf('?');
  if (q < 0) return pathAndQuery;
  const params = new URLSearchParams(pathAndQuery.slice(q + 1));
  if (!KEY_PARAMS.some((p) => params.has(p))) return pathAndQuery;
  for (const p of KEY_PARAMS) if (params.has(p)) params.set(p, key);
  return `${pathAndQuery.slice(0, q)}?${params.toString()}`;
}

/** Every occurrence of the key removed (the key is 16-128 letters/digits, so it is never part of other markup). */
export const stripKey = (text: string, key: string): string => (key ? text.split(key).join('') : text);

/** A JSON body (Jackett's server-config save) keeps the real key whatever the browser sent. */
export function bodyWithServerKey(body: Buffer, contentType: string | undefined, key: string): Buffer {
  if (!body.length || !/json/i.test(contentType ?? '')) return body;
  let v: unknown;
  try { v = JSON.parse(body.toString('utf8')); } catch { return body; }
  if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.prototype.hasOwnProperty.call(v, 'api_key')) return body;
  (v as Record<string, unknown>).api_key = key;
  return Buffer.from(JSON.stringify(v), 'utf8');
}

/** Keep only Jackett's cookies from a Cookie header. */
export function filterCookies(header: string | undefined): string {
  if (!header) return '';
  return header.split(';').map((c) => c.trim()).filter((c) => JACKETT_COOKIES.has(c.split('=')[0]!.trim())).join('; ');
}

/** Jackett answers redirects with its own absolute URL (http://vpn:9117/jackett/...): make it a path on this host. */
export function rewriteLocation(loc: string, jackettOrigin: string, requestUrl: string): string | null {
  let u: URL;
  try { u = new URL(loc, jackettOrigin + requestUrl); } catch { return null; }
  if (u.origin !== jackettOrigin) return null;
  if (u.pathname !== JACKETT_BASE_PATH && !u.pathname.startsWith(`${JACKETT_BASE_PATH}/`)) return null;
  return u.pathname + u.search;
}

/** Same-origin check for writes: an Origin (if sent) must be this app's, a Sec-Fetch-Site (if sent) must be same-origin, one of the two must be there. */
export function sameOrigin(req: FastifyRequest, appOrigin: string): boolean {
  const origin = req.headers.origin;
  const site = req.headers['sec-fetch-site'];
  if (typeof origin === 'string' && origin !== appOrigin) return false;
  if (typeof site === 'string' && site !== 'same-origin') return false;
  return typeof origin === 'string' || typeof site === 'string';
}

export function registerJackettUi(app: FastifyInstance, ctx: Ctx): void {
  app.register(async (ui) => {
    // The UI posts JSON and forms; pass every body through untouched (no parsing), capped.
    ui.removeAllContentTypeParsers();
    ui.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_UI_BODY }, (_req, body, done) => done(null, body));

    const appOrigin = `${ctx.config.publicScheme}://${ctx.config.appHost}`;
    const handler = async (req: FastifyRequest, reply: FastifyReply) => {
      const s = ctx.config.search;
      if (!s || !ctx.search?.backend.uiPath) throw new ApiError(404, 'search_disabled', 'Torrent search is not enabled on this server');
      if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req, appOrigin)) throw new ApiError(403, 'csrf', 'Cross-origin request refused');
      const path = req.url;
      if (path === JACKETT_BASE_PATH) return reply.redirect(`${JACKETT_BASE_PATH}/`, 302);
      if (!path.startsWith(`${JACKETT_BASE_PATH}/`)) throw new ApiError(404, 'not_found', 'Not found');

      const headers: Record<string, string> = { 'accept-encoding': 'identity' };
      for (const h of REQ_HEADERS) { const v = req.headers[h]; if (typeof v === 'string') headers[h] = v; }
      const cookies = filterCookies(req.headers.cookie);
      if (cookies) headers.cookie = cookies;
      const raw = req.method === 'GET' || req.method === 'HEAD' ? undefined : (req.body as Buffer | undefined);
      const body = raw ? bodyWithServerKey(raw, req.headers['content-type'], s.jackettApiKey) : undefined;

      let res: Response;
      try {
        res = await ctx.fetchImpl(s.jackettUrl + withServerKey(path, s.jackettApiKey), {
          method: req.method, headers, body: body && body.length ? new Uint8Array(body) : undefined,
          redirect: 'manual', signal: AbortSignal.timeout(UI_TIMEOUT_MS),
        });
      } catch {
        throw new ApiError(502, 'search_unavailable', 'Jackett is unreachable');
      }
      reply.code(res.status);
      for (const h of RES_HEADERS) { const v = res.headers.get(h); if (v) reply.header(h, v); }
      const setCookies = res.headers.getSetCookie().filter((c) => JACKETT_COOKIES.has(c.split('=')[0]!.trim()));
      if (setCookies.length) reply.header('set-cookie', setCookies);
      const loc = res.headers.get('location');
      if (loc) reply.header('location', stripKey(rewriteLocation(loc, s.jackettUrl, path) ?? `${JACKETT_BASE_PATH}/`, s.jackettApiKey));
      reply.header('cache-control', res.headers.get('cache-control') ?? 'no-store');
      reply.header('content-security-policy', JACKETT_UI_CSP);
      if (!res.body || req.method === 'HEAD') { await res.body?.cancel().catch(() => {}); return reply.send(); }
      if (!TEXT_TYPE.test(res.headers.get('content-type') ?? '')) {
        return reply.send(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)); // images, fonts, .torrent
      }
      // Text: buffered so the key can be removed (it may span chunk boundaries).
      const reader = res.body.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_TEXT_RESPONSE) { await reader.cancel().catch(() => {}); throw new ApiError(502, 'search_bad_response', 'Jackett response too large'); }
        chunks.push(Buffer.from(value));
      }
      return reply.send(stripKey(Buffer.concat(chunks).toString('utf8'), s.jackettApiKey));
    };
    const methods = ['GET', 'POST', 'PUT', 'DELETE'] as const;
    ui.route({ method: [...methods], url: JACKETT_BASE_PATH, handler });
    ui.route({ method: [...methods], url: `${JACKETT_BASE_PATH}/*`, handler });
  });
}
