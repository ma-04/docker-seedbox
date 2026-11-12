/**
 * Torrent search (docs/architecture.md § Torrent search). Any signed-in user can search and add a result; admins choose
 * which categories exist and see the backend's status. With search switched off (no SEARCH_BACKEND) every route here
 * answers 404 `search_disabled`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SearchAdminDto, SearchCategoryId, SearchMetaDto, SearchResponseDto, SearchResultDto } from '../../lib/dto.js';
import { SearchError, type SearchHit } from '../../lib/search/backend.js';
import { CATEGORY_IDS, enabledCategories, resultCategory, SEARCH_CATEGORIES, torznabCats } from '../../lib/search/categories.js';
import { SearchBusyError, type SearchService } from '../../lib/search/service.js';
import { openToken, sealToken, TOKEN_TTL_SECONDS, TokenError, MAX_TOKEN_CHARS } from '../../lib/search/token.js';
import { getSetting, setSetting } from '../../lib/settings.js';
import { now } from '../../lib/types.js';
import type { Ctx } from '../context.js';
import { ApiError, parse } from '../errors.js';
import { enforce, RATE } from '../ratelimit.js';
import { parseMagnet, parseTorrentFile, type ParsedSource } from '../torrent.js';
import { createJob } from './jobs.js';

export const MAX_QUERY_CHARS = 200;
const INDEXER = /^[A-Za-z0-9._-]{1,64}$/;

const searchQuery = z.object({
  q: z.string().trim().min(2, 'Enter at least 2 characters').max(MAX_QUERY_CHARS, `At most ${MAX_QUERY_CHARS} characters`),
  cat: z.enum(['all', ...CATEGORY_IDS]).default('all'),
  indexer: z.string().trim().max(64).regex(/^(|[A-Za-z0-9._-]{1,64})$/, 'Invalid indexer').optional(),
}).strict();
const addBody = z.object({ token: z.string().min(1).max(MAX_TOKEN_CHARS), destinationId: z.coerce.number().int().positive() }).strict();
const adminUpdate = z.object({
  disabledCategories: z.array(z.enum(CATEGORY_IDS)).max(CATEGORY_IDS.length).refine((a) => new Set(a).size === a.length, 'Duplicate category').optional(),
  allowWithoutVpn: z.boolean().optional(),
}).strict().refine((b) => b.disabledCategories !== undefined || b.allowWithoutVpn !== undefined, 'Nothing to change');

export const VPN_OFF_MESSAGE = 'Search is paused because the VPN is off: tracker sites would see this server\'s own address. '
  + 'An admin can set the VPN to required (Admin -> VPN) or explicitly allow search without the VPN (Admin -> Search).';
/** Anything that makes Jackett contact tracker sites waits for the VPN, unless an admin opted out. */
function assertVpnOrOptIn(ctx: Ctx): void {
  if (getSetting(ctx.db, 'vpn.mode') === 'off' && !getSetting(ctx.db, 'search.allowWithoutVpn')) {
    throw new ApiError(503, 'search_vpn_off', VPN_OFF_MESSAGE);
  }
}

const disabledError = () => new ApiError(404, 'search_disabled', 'Torrent search is not enabled on this server');

/** A backend failure as an API error; messages are the fixed texts of SearchError (never upstream content). */
export function searchApiError(e: unknown): unknown {
  if (e instanceof SearchBusyError) return new ApiError(e.scope === 'user' ? 429 : 503, 'search_busy', e.message, { 'Retry-After': '5' });
  if (!(e instanceof SearchError)) return e;
  if (e.code === 'link_refused') return new ApiError(422, 'search_link_refused', e.message);
  return new ApiError(502, `search_${e.code}`, e.message);
}

const disabledCats = (ctx: Ctx): string[] => getSetting(ctx.db, 'search.disabledCategories');

export function registerSearch(app: FastifyInstance, ctx: Ctx): void {
  const need = (): SearchService => { if (!ctx.search) throw disabledError(); return ctx.search; };

  app.get('/api/search/meta', async (): Promise<SearchMetaDto> => {
    const svc = need();
    const categories = enabledCategories(disabledCats(ctx)).map((c) => ({ id: c.id, label: c.label }));
    try {
      return { categories, indexers: await svc.indexers(), indexersOk: true };
    } catch (e) {
      if (e instanceof SearchError) return { categories, indexers: [], indexersOk: false };
      throw e;
    }
  });

  app.get('/api/search', async (req): Promise<SearchResponseDto> => {
    const svc = need();
    const p = parse(searchQuery, req.query);
    assertVpnOrOptIn(ctx);
    enforce(ctx.limiter, req.user.id, 'search', RATE.search);
    const disabled = disabledCats(ctx);
    let cats: number[];
    try { cats = torznabCats(p.cat, disabled); } catch { throw new ApiError(400, 'validation', 'cat: This category is not available'); }
    if (cats.length === 0) throw new ApiError(400, 'validation', 'cat: No search category is enabled');
    let res: { hits: SearchHit[]; cached: boolean };
    try {
      res = await svc.search(req.user.id, { q: p.q, cats, indexer: p.indexer && INDEXER.test(p.indexer) ? p.indexer : null });
    } catch (e) { throw searchApiError(e); }
    const exp = now() + TOKEN_TTL_SECONDS;
    const results: SearchResultDto[] = [];
    for (const h of res.hits) {
      const category = resultCategory(h.categories, disabled);
      if (!category) continue; // a disabled category (e.g. XXX) never reaches the browser, also not via "All"
      const token = sealToken(ctx.config.appSecret, { u: req.user.id, e: exp, ...(h.magnet ? { m: h.magnet } : { l: h.link! }) });
      results.push({
        token, title: h.title, size: h.size, seeders: h.seeders, leechers: h.leechers,
        indexer: { id: h.indexerId, name: h.indexerName }, category: category as SearchCategoryId, publishedAt: h.publishedAt,
      });
    }
    results.sort((a, b) => b.seeders - a.seeders);
    return { results, cached: res.cached };
  });

  app.post('/api/search/add', async (req, reply) => {
    const svc = need();
    const b = parse(addBody, req.body);
    enforce(ctx.limiter, req.user.id, 'job-create', RATE.jobCreate);
    let t: ReturnType<typeof openToken>;
    try { t = openToken(ctx.config.appSecret, b.token, req.user.id, now()); } catch (e) {
      if (e instanceof TokenError) throw new ApiError(e.message.includes('expired') ? 410 : 400, 'search_token', e.message);
      throw e;
    }
    // Everything below goes through the SAME validation as a user-submitted magnet / .torrent upload.
    let parsed: ParsedSource;
    if (t.m) parsed = await parseMagnet(t.m); // goes to qBittorrent like any magnet (it follows vpn.mode itself)
    else {
      assertVpnOrOptIn(ctx); // fetching the .torrent makes Jackett contact the tracker site
      let d: Awaited<ReturnType<typeof svc.backend.download>>;
      try { d = await svc.backend.download(t.l!); } catch (e) { throw searchApiError(e); }
      parsed = d.kind === 'magnet' ? await parseMagnet(d.magnet) : await parseTorrentFile(d.data);
    }
    const r = createJob(ctx, req.user, parsed, b.destinationId);
    return reply.code(r.created ? 201 : 200).send(r.job);
  });
}

/** Admin routes: register ONLY inside the requireAdmin plugin (see app.ts). */
export function registerAdminSearch(app: FastifyInstance, ctx: Ctx): void {
  async function dto(): Promise<SearchAdminDto> {
    const disabled = disabledCats(ctx);
    const categories = SEARCH_CATEGORIES.map((c) => ({ id: c.id, label: c.label, enabled: !disabled.includes(c.id) }));
    const svc = ctx.search;
    const vpn = { vpnMode: getSetting(ctx.db, 'vpn.mode'), allowWithoutVpn: getSetting(ctx.db, 'search.allowWithoutVpn') };
    if (!svc) return { enabled: false, backend: null, uiPath: null, reachable: false, indexerCount: null, error: null, flaresolverr: 'disabled', categories, ...vpn };
    let reachable = false, indexerCount: number | null = null, error: string | null = null;
    try { indexerCount = (await svc.indexers(true)).length; reachable = true; } catch (e) {
      error = e instanceof SearchError ? e.message : 'The search backend is unreachable';
    }
    let flaresolverr: SearchAdminDto['flaresolverr'] = 'disabled';
    if (ctx.config.search?.flaresolverr) {
      try { flaresolverr = (await ctx.vpn.companions?.())?.flaresolverr ? 'ok' : 'unreachable'; } catch { flaresolverr = 'unreachable'; }
    }
    return { enabled: true, backend: svc.backend.kind, uiPath: svc.backend.uiPath, reachable, indexerCount, error, flaresolverr, categories, ...vpn };
  }
  app.get('/api/admin/search', async () => dto());
  app.put('/api/admin/search', async (req) => {
    const b = parse(adminUpdate, req.body ?? {});
    if (b.disabledCategories) setSetting(ctx.db, 'search.disabledCategories', b.disabledCategories);
    if (b.allowWithoutVpn !== undefined) setSetting(ctx.db, 'search.allowWithoutVpn', b.allowWithoutVpn);
    return dto();
  });
}
