/**
 * Curated, admin-editable subset of qBittorrent preferences. This file is the whitelist:
 * nothing outside FIELDS is ever read from or written to the engine.
 * Verified against the qBittorrent Web API docs ("Get/Set application preferences") and the
 * WebUI/appcontroller sources: dl_limit/up_limit are bytes/s on the wire (the WebUI multiplies by 1024).
 */
import { z } from 'zod';
import type { EngineSettingsDto, EngineSettingsUpdateDto } from '../lib/dto.js';

export interface EngineClient {
  getPreferences(): Promise<Record<string, unknown>>;
  setPreferences(prefs: Record<string, unknown>): Promise<void>;
}

const ENC = ['prefer', 'require', 'disable'] as const; // qBittorrent: 0 prefer, 1 force on, 2 force off
const MAX_KBPS = 2_000_000; // qBittorrent parses limits as 32-bit int bytes/s
const limit = z.number().int().min(-1).max(100_000); // -1 (or 0) = unlimited
const slots = z.number().int().min(-1).max(100_000);
const TRACKER_URL = /^(https?|udp|wss?):\/\/[^\s/?#]+[^\s]*$/i;

export const addTrackersSchema = z.string().max(4096, 'At most 4 KB').superRefine((v, ctx) => {
  const lines = v.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 50) ctx.addIssue({ code: 'custom', message: 'At most 50 trackers' });
  for (const l of lines) if (!TRACKER_URL.test(l)) { ctx.addIssue({ code: 'custom', message: `Not a valid tracker URL (http, https, udp, ws, wss): ${l.slice(0, 60)}` }); break; }
});

interface Field<T> {
  key: string; schema: z.ZodType<T>;
  fromEngine(v: unknown): T | undefined; toEngine(v: T): unknown;
}
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const kbps = (key: string): Field<number> => ({
  key, schema: z.number().int().min(0).max(MAX_KBPS),
  fromEngine: (v) => { const n = num(v); return n === undefined ? undefined : n <= 0 ? 0 : Math.round(n / 1024); },
  toEngine: (v) => v * 1024,
});
const plain = (key: string, schema: z.ZodType<number>): Field<number> => ({ key, schema, fromEngine: num, toEngine: (v) => v });
const flag = (key: string): Field<boolean> => ({ key, schema: z.boolean(), fromEngine: bool, toEngine: (v) => v });

export const FIELDS: { [K in keyof EngineSettingsDto]: Field<EngineSettingsDto[K]> } = {
  downloadLimitKBps: kbps('dl_limit'),
  uploadLimitKBps: kbps('up_limit'),
  maxConnections: plain('max_connec', limit),
  maxConnectionsPerTorrent: plain('max_connec_per_torrent', limit),
  maxUploads: plain('max_uploads', slots),
  maxUploadsPerTorrent: plain('max_uploads_per_torrent', slots),
  queueingEnabled: flag('queueing_enabled'),
  maxActiveDownloads: plain('max_active_downloads', slots),
  maxActiveUploads: plain('max_active_uploads', slots),
  maxActiveTorrents: plain('max_active_torrents', slots),
  dht: flag('dht'), pex: flag('pex'), lsd: flag('lsd'),
  encryption: {
    key: 'encryption', schema: z.enum(ENC),
    fromEngine: (v) => (typeof v === 'number' ? ENC[v] : undefined), toEngine: (v) => ENC.indexOf(v),
  },
  anonymousMode: flag('anonymous_mode'),
  listenPort: plain('listen_port', z.number().int().min(1024).max(65535)),
  randomPort: flag('random_port'),
  addTrackersEnabled: flag('add_trackers_enabled'),
  addTrackers: {
    key: 'add_trackers', schema: addTrackersSchema,
    fromEngine: (v) => (typeof v === 'string' ? v : undefined), toEngine: (v) => v.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\n'),
  },
};

export const engineUpdateSchema = z.object(
  Object.fromEntries((Object.entries(FIELDS) as unknown as [string, Field<unknown>][]).map(([k, f]) => [k, f.schema.optional()])) as Record<string, z.ZodTypeAny>,
).strict();

/** Pick whitelisted keys from a raw preferences object. Returns null if any expected key is missing/mistyped. */
export function fromPreferences(prefs: Record<string, unknown>): EngineSettingsDto | null {
  const out: Record<string, unknown> = {};
  for (const [name, f] of Object.entries(FIELDS) as unknown as [string, Field<unknown>][]) {
    let v = f.fromEngine(prefs[f.key]);
    // qBittorrent >= 5.3 no longer reports random_port: a random port is listen_port === 0. Older builds report
    // random_port (with the last port still in listen_port). Either signal means "random".
    if (name === 'randomPort') v = prefs.random_port === true || prefs.listen_port === 0;
    else if (v === undefined) return null;
    out[name] = v;
  }
  return out as unknown as EngineSettingsDto;
}

/** Map a validated partial update to qBittorrent keys. Throws Error with a user-facing message on inconsistent input. */
export function toPreferences(u: EngineSettingsUpdateDto): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, f] of Object.entries(FIELDS) as unknown as [keyof EngineSettingsDto, Field<unknown>][]) {
    const v = u[name];
    if (v === undefined) continue;
    if (name === 'listenPort' && u.randomPort === true) continue; // random port wins; fixed port ignored
    out[f.key] = f.toEngine(v);
  }
  // 5.3 ignores random_port and treats listen_port 0 as "random"; older builds read random_port. Send both.
  if (u.randomPort === true) out.listen_port = 0;
  if (u.randomPort === false && u.listenPort === undefined) throw new Error('listenPort is required when turning randomPort off');
  return out;
}
