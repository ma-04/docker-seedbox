import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '../lib/config.js';
import type { Db } from '../lib/db.js';
import type { MeDto } from '../lib/dto.js';
import { getSetting } from '../lib/settings.js';
import { vpnClient, type VpnClient } from '../lib/vpn.js';
import { registerAuth } from './auth.js';
import type { Ctx } from './context.js';
import { ApiError } from './errors.js';
import { registerAdmin } from './routes/admin.js';
import { registerDestinations } from './routes/destinations.js';
import { registerDl } from './routes/dl.js';
import { registerEvents } from './routes/events.js';
import { registerJobs } from './routes/jobs.js';

export interface BuildAppOptions {
  db: Db; config: Config; vpn?: VpnClient; fetchImpl?: typeof fetch;
  logger?: boolean | object; ssePollMs?: number; ssePingMs?: number;
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const { db, config } = opts;
  const ctx: Ctx = {
    db, config,
    vpn: opts.vpn ?? vpnClient(config),
    fetchImpl: opts.fetchImpl ?? ((...a) => globalThis.fetch(...a)),
    ssePollMs: opts.ssePollMs ?? 1000,
    ssePingMs: opts.ssePingMs ?? 20_000,
  };
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true });

  app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5 } });
  registerAuth(app, ctx);

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } }));
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    const status = err.statusCode;
    if (status && status >= 400 && status < 500) {
      const code = status === 429 ? 'limit_exceeded' : status === 413 ? 'limit_exceeded' : 'validation';
      return reply.code(status).send({ error: { code, message: status === 413 ? 'Payload too large' : 'Invalid request' } });
    }
    req.log.error({ err: { message: err.message, stack: err.stack } }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal', message: 'Internal server error' } });
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/me', async (req): Promise<MeDto> => {
    const u = req.user;
    return {
      user: { id: u.id, username: u.username, email: u.email, displayName: u.display_name },
      isAdmin: !!u.is_admin,
      limits: { maxActiveJobs: u.max_active_jobs ?? getSetting(db, 'limits.maxActiveJobsPerUser'), maxTorrentBytes: getSetting(db, 'limits.maxTorrentBytes') },
      googleConnectAvailable: false,
      logoutUrl: `${config.publicScheme}://${config.authHost}/logout`,
    };
  });

  registerDestinations(app, ctx);
  registerJobs(app, ctx);
  registerDl(app, ctx);
  registerEvents(app, ctx);
  registerAdmin(app, ctx);
  return app;
}
