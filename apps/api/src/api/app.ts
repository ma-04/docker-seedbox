import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '../lib/config.js';
import type { Db } from '../lib/db.js';
import type { MeDto } from '../lib/dto.js';
import { getSetting } from '../lib/settings.js';
import { vpnClient, type VpnClient } from '../lib/vpn.js';
import { decorateUser, makeRequireUser, registerGuards, requireAdmin, tagRoutes } from './auth.js';
import { RateLimiter } from './ratelimit.js';
import type { GuardOptions } from '../lib/netguard.js';
import type { Ctx } from './context.js';
import { QbittorrentDownloader } from '../downloaders/qbittorrent.js';
import type { EngineClient } from './engine.js';
import { ApiError } from './errors.js';
import { loggerOptions } from './logging.js';
import { registerAdmin } from './routes/admin.js';
import { registerAdminDestinations, registerDestinations } from './routes/destinations.js';
import { registerDl } from './routes/dl.js';
import { registerEngine } from './routes/engine.js';
import { registerTrackers } from './routes/trackers.js';
import { registerEvents } from './routes/events.js';
import { registerAdminJobs, registerJobs } from './routes/jobs.js';
import { registerJackettUi } from './routes/jackett-ui.js';
import { registerAdminSearch, registerSearch } from './routes/search.js';
import type { SearchBackend } from '../lib/search/backend.js';
import { JackettBackend } from '../lib/search/jackett.js';
import { SearchService } from '../lib/search/service.js';

export interface BuildAppOptions {
  db: Db; config: Config; vpn?: VpnClient; engine?: EngineClient; fetchImpl?: typeof fetch;
  logger?: boolean | object; ssePollMs?: number; ssePingMs?: number;
  sseMaxPerUser?: number; sseMaxTotal?: number; vpnLockWaitMs?: number; limiter?: RateLimiter; lookup?: GuardOptions['lookup'];
  /** Test seam: a search backend to use instead of the one from config.search (null = off). */
  searchBackend?: SearchBackend | null;
}

export interface RouteInfo { method: string | string[]; url: string; config?: { guard?: string } }
declare module 'fastify' { interface FastifyInstance { routeTable: RouteInfo[] } }

const envInt = (k: string, d: number) => { const n = Number(process.env[k]); return Number.isInteger(n) && n > 0 ? n : d; };

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const { db, config } = opts;
  const fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const backend: SearchBackend | null = opts.searchBackend !== undefined ? opts.searchBackend
    : config.search ? new JackettBackend({ origin: config.search.jackettUrl, apiKey: config.search.jackettApiKey, fetchImpl, lookup: opts.lookup }) : null;
  const ctx: Ctx = {
    db, config,
    vpn: opts.vpn ?? vpnClient(config),
    engine: opts.engine ?? new QbittorrentDownloader({ baseUrl: config.qbtUrl, fetchImpl, timeoutMs: 8000 }),
    fetchImpl,
    ssePollMs: opts.ssePollMs ?? 1000,
    ssePingMs: opts.ssePingMs ?? 20_000,
    sseMaxPerUser: opts.sseMaxPerUser ?? envInt('SSE_MAX_PER_USER', 5),
    sseMaxTotal: opts.sseMaxTotal ?? envInt('SSE_MAX_TOTAL', 200),
    limiter: opts.limiter ?? new RateLimiter(),
    vpnLockWaitMs: opts.vpnLockWaitMs ?? 15_000,
    lookup: opts.lookup,
    search: backend ? new SearchService(backend) : null,
  };
  const app = Fastify({ logger: loggerOptions(opts.logger) as never, trustProxy: true });

  app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5 } });
  const routeTable: RouteInfo[] = [];
  app.decorate('routeTable', routeTable);
  app.addHook('onRoute', (r) => { routeTable.push(r as unknown as RouteInfo); });
  decorateUser(app);
  registerGuards(app, ctx);
  tagRoutes(app, 'public');

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } }));
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).headers(err.headers).send({ error: { code: err.code, message: err.message } });
    const status = err.statusCode;
    if (status && status >= 400 && status < 500) {
      const code = status === 429 ? 'limit_exceeded' : status === 413 ? 'limit_exceeded' : 'validation';
      return reply.code(status).send({ error: { code, message: status === 413 ? 'Payload too large' : 'Invalid request' } });
    }
    req.log.error({ err: { message: err.message, stack: err.stack } }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal', message: 'Internal server error' } });
  });

  app.get('/api/health', async () => ({ ok: true }));

  // Public: health + signed downloads. Everything else lives in the guarded plugins below, so
  // authorisation follows the MATCHED route and never the URL string.
  registerDl(app, ctx);

  const requireUser = makeRequireUser(ctx);
  app.register(async (authed) => {
    tagRoutes(authed, 'user');
    authed.addHook('onRequest', requireUser);
    authed.get('/api/me', async (req): Promise<MeDto> => {
      const u = req.user;
      return {
        user: { id: u.id, username: u.username, email: u.email, displayName: u.display_name },
        isAdmin: !!u.is_admin,
        limits: { maxActiveJobs: u.max_active_jobs ?? getSetting(db, 'limits.maxActiveJobsPerUser'), maxTorrentBytes: getSetting(db, 'limits.maxTorrentBytes') },
        cleanup: { deleteRemoteOnJobDelete: getSetting(db, 'cleanup.deleteRemoteOnJobDelete') },
        googleConnectAvailable: false,
        logoutUrl: config.logoutUrl,
        searchEnabled: !!ctx.search,
      };
    });

    registerDestinations(authed, ctx);
    registerJobs(authed, ctx);
    registerEvents(authed, ctx);
    registerSearch(authed, ctx);

    authed.register(async (admin) => {
      tagRoutes(admin, 'admin');
      admin.addHook('onRequest', requireAdmin);
      registerAdmin(admin, ctx);
      registerAdminDestinations(admin, ctx);
      registerAdminJobs(admin, ctx);
      registerEngine(admin, ctx);
      registerTrackers(admin, ctx);
      registerAdminSearch(admin, ctx);
      registerJackettUi(admin, ctx);
    });
  });
  return app;
}
