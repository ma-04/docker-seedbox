import type { FastifyInstance } from 'fastify';
import type { EngineSettingsDto } from '../../lib/dto.js';
import { getSetting, hasSetting, setSetting } from '../../lib/settings.js';
import { splitLines } from '../../lib/trackers.js';
import type { Ctx } from '../context.js';
import { engineUpdateSchema, fromPreferences, toPreferences } from '../engine.js';
import { ApiError, parse, validation } from '../errors.js';

const unavailable = () => new ApiError(502, 'engine_unavailable', 'Torrent engine is not reachable');

/** Admin-only (gated by the /api/admin/ prefix in auth). Only whitelisted preferences are read or written; the engine's WebUI is never proxied. */
export function registerEngine(app: FastifyInstance, ctx: Ctx): void {
  const read = async (): Promise<EngineSettingsDto> => {
    let prefs: Record<string, unknown>;
    try { prefs = await ctx.engine.getPreferences(); } catch (e) {
      app.log.warn({ err: (e as Error).message }, 'engine preferences unavailable');
      throw unavailable();
    }
    const dto = fromPreferences(prefs);
    if (!dto) throw unavailable();
    // The manual extra trackers and their switch live in our settings (the worker writes manual + fetched ones to the
    // engine). Before the worker's first run only the engine knows them.
    if (hasSetting(ctx.db, 'trackers.manual')) dto.addTrackers = splitLines(getSetting(ctx.db, 'trackers.manual')).join('\n');
    if (hasSetting(ctx.db, 'trackers.enabled')) dto.addTrackersEnabled = getSetting(ctx.db, 'trackers.enabled');
    return dto;
  };

  app.get('/api/admin/engine/settings', async () => read());
  app.put('/api/admin/engine/settings', async (req) => {
    const patch = parse(engineUpdateSchema, req.body ?? {});
    let prefs: Record<string, unknown>;
    try { prefs = toPreferences(patch); } catch (e) { throw validation((e as Error).message); }
    if (patch.addTrackers !== undefined) setSetting(ctx.db, 'trackers.manual', splitLines(patch.addTrackers).join('\n'));
    if (patch.addTrackersEnabled !== undefined) setSetting(ctx.db, 'trackers.enabled', patch.addTrackersEnabled);
    if (Object.keys(prefs).length) {
      try { await ctx.engine.setPreferences(prefs); } catch (e) {
        app.log.warn({ err: (e as Error).message }, 'engine setPreferences failed');
        throw unavailable();
      }
    }
    return read();
  });
}
