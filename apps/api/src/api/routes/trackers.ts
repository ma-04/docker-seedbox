import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TrackersDto } from '../../lib/dto.js';
import { assertPublicEndpoint, NetGuardError, parseHttpUrl } from '../../lib/netguard.js';
import { getSetting, setSetting } from '../../lib/settings.js';
import { MAX_LIST_URLS, MAX_URL_CHARS } from '../../lib/trackerlist.js';
import { trackersDto } from '../../lib/trackers.js';
import { now } from '../../lib/types.js';
import type { Ctx } from '../context.js';
import { ApiError, parse, validation } from '../errors.js';
import { enforce, RATE } from '../ratelimit.js';

const update = z.object({
  urls: z.array(z.string().trim().min(1).max(MAX_URL_CHARS)).max(MAX_LIST_URLS, `At most ${MAX_LIST_URLS} list URLs`).optional(),
  refreshHours: z.number().int().min(1).max(720).optional(),
  maxTrackers: z.number().int().min(1).max(1000).optional(),
}).strict();

/**
 * Admin-only tracker lists (docs/architecture.md § Tracker lists). The API never fetches a list: it validates the URLs
 * (https, no credentials, public host) and records settings; the worker downloads, parses and applies them.
 */
export function registerTrackers(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  const out = (): TrackersDto => trackersDto(db);

  async function checkUrl(raw: string): Promise<string> {
    try {
      if (ctx.config.trackerListAllowPrivate) return parseHttpUrl(raw).href; // hermetic test stack only
      const u = new URL(raw);
      if (u.protocol !== 'https:') throw new NetGuardError('List URL must use https');
      await assertPublicEndpoint(raw, { allowPrivate: false, lookup: ctx.lookup }); // credentials, private/single-label hosts, DNS answers
      return u.href;
    } catch (e) {
      if (e instanceof NetGuardError) throw validation(`${raw.slice(0, 80)}: ${e.message}`);
      throw validation(`${raw.slice(0, 80)}: Invalid URL`);
    }
  }

  app.get('/api/admin/trackers', async () => out());

  app.put('/api/admin/trackers', async (req) => {
    const b = parse(update, req.body ?? {});
    let urls: string[] | undefined;
    if (b.urls) {
      urls = [];
      for (const raw of b.urls) { const u = await checkUrl(raw); if (!urls.includes(u)) urls.push(u); }
    }
    const changed = (urls && JSON.stringify(urls) !== JSON.stringify(getSetting(db, 'trackers.listUrls')))
      || (b.maxTrackers !== undefined && b.maxTrackers !== getSetting(db, 'trackers.maxTrackers'));
    db.transaction(() => {
      if (urls) setSetting(db, 'trackers.listUrls', urls);
      if (b.refreshHours !== undefined) setSetting(db, 'trackers.refreshHours', b.refreshHours);
      if (b.maxTrackers !== undefined) setSetting(db, 'trackers.maxTrackers', b.maxTrackers);
      if (changed) requestRefresh();
    })();
    return out();
  });

  function requestRefresh(): void {
    // Strictly newer than the worker's last handled request, so two requests within one second are not merged away.
    setSetting(db, 'trackers.refreshRequestedAt', Math.max(now(), getSetting(db, 'trackers.refreshDoneAt') + 1));
  }

  app.post('/api/admin/trackers/refresh', async (req, reply) => {
    enforce(ctx.limiter, req.user.id, 'trackerRefresh', RATE.trackerRefresh);
    if (!getSetting(db, 'trackers.enabled')) throw new ApiError(409, 'conflict', 'Extra trackers are switched off (engine settings)');
    if (getSetting(db, 'trackers.listUrls').length === 0) throw new ApiError(409, 'conflict', 'No tracker list URLs are configured');
    requestRefresh();
    return reply.code(202).send(out());
  });
}
