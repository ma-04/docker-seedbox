import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { encrypt } from '../../lib/crypto.js';
import type { SettingsDto, UserDto, VpnConfigDto, VpnStatusDto } from '../../lib/dto.js';
import { getAllSettings, getSetting, setSetting, type SettingKey } from '../../lib/settings.js';
import { now, type UserRow, type VpnConfigRow } from '../../lib/types.js';
import { acquireVpnLockWait, connectVpn, isVpnConflict, parseWgConfig, releaseVpnLock } from '../../lib/vpn.js';
import type { Ctx } from '../context.js';
import { ApiError, conflict, idParam, notFound, parse, validation } from '../errors.js';
import { ACTIVE_SQL, userDto } from '../mappers.js';

const HIDDEN_SETTINGS = ['google.oauthClientId', 'google.oauthClientSecret'] as const;

const settingsSchema = z.object({
  'vpn.mode': z.enum(['off', 'required']),
  'vpn.rotation': z.enum(['manual', 'interval', 'on-failure']),
  'vpn.rotationMinutes': z.number().int().min(1).max(525_600),
  'limits.maxActiveJobsPerUser': z.number().int().min(1).max(1000),
  'limits.maxTorrentBytes': z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  'limits.minFreeDiskBytes': z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  'seeding.ratio': z.number().min(0).max(1000),
  'seeding.maxMinutes': z.number().int().min(0).max(525_600),
  'cleanup.failedGraceMinutes': z.number().int().min(0).max(525_600),
  'cleanup.deleteRemoteOnJobDelete': z.boolean(),
  'limits.metadataTimeoutMinutes': z.number().int().min(0).max(525_600),
}).partial().strip();

const vpnCreate = z.object({ name: z.string().trim().min(1).max(64), config: z.string().min(1).max(16_384) });
const vpnUpdate = z.object({ name: z.string().trim().min(1).max(64).optional(), enabled: z.boolean().optional(), config: z.string().min(1).max(16_384).optional() });
const rotateBody = z.object({ configId: z.number().int().positive().optional() }).strip();
const userUpdate = z.object({ disabled: z.boolean().optional(), maxActiveJobs: z.number().int().min(0).max(1000).nullable().optional() });

export function registerAdmin(app: FastifyInstance, ctx: Ctx): void {
  const { db, config, vpn } = ctx;

  // ---- VPN configs
  const vpnDto = (r: VpnConfigRow, active: number | null): VpnConfigDto => ({
    id: r.id, name: r.name, endpointHost: r.endpoint_host, enabled: !!r.enabled, lastUsedAt: r.last_used_at,
    lastError: r.last_error, active: r.id === active, createdAt: r.created_at,
  });
  const vpnRow = (id: number): VpnConfigRow => {
    const r = db.prepare('SELECT * FROM vpn_configs WHERE id = ?').get(id) as VpnConfigRow | undefined;
    if (!r) throw notFound('VPN config');
    return r;
  };
  const checkWg = (text: string): string | null => {
    try { return parseWgConfig(text).endpointHost; } catch (e) { throw validation((e as Error).message); }
  };
  const deactivate = async (id: number) => {
    if (getSetting(db, 'vpn.activeConfigId') !== id) return;
    setSetting(db, 'vpn.activeConfigId', null);
    try { await vpn.disconnect(); } catch { /* worker reconciles */ }
  };
  const uniqueName = <T>(fn: () => T): T => {
    try { return fn(); } catch (e) {
      if (String((e as Error).message).includes('UNIQUE')) throw conflict('A VPN config with that name already exists');
      throw e;
    }
  };

  app.get('/api/admin/vpn/configs', async () => {
    const active = getSetting(db, 'vpn.activeConfigId');
    return (db.prepare('SELECT * FROM vpn_configs ORDER BY name').all() as VpnConfigRow[]).map((r) => vpnDto(r, active));
  });
  app.post('/api/admin/vpn/configs', async (req, reply) => {
    const b = parse(vpnCreate, req.body);
    const host = checkWg(b.config);
    const id = uniqueName(() => Number(db.prepare('INSERT INTO vpn_configs (name, config_enc, endpoint_host, enabled, created_at) VALUES (?, ?, ?, 1, ?)')
      .run(b.name, encrypt(config.appSecret, b.config), host, now()).lastInsertRowid));
    return reply.code(201).send(vpnDto(vpnRow(id), getSetting(db, 'vpn.activeConfigId')));
  });
  app.patch('/api/admin/vpn/configs/:id', async (req) => {
    const id = parse(idParam, (req.params as { id: string }).id);
    const row = vpnRow(id);
    const b = parse(vpnUpdate, req.body);
    const host = b.config !== undefined ? checkWg(b.config) : row.endpoint_host;
    uniqueName(() => db.prepare('UPDATE vpn_configs SET name = ?, enabled = ?, config_enc = ?, endpoint_host = ? WHERE id = ?').run(
      b.name ?? row.name, b.enabled === undefined ? row.enabled : b.enabled ? 1 : 0,
      b.config !== undefined ? encrypt(config.appSecret, b.config) : row.config_enc, host, id));
    if (b.enabled === false) await deactivate(id);
    return vpnDto(vpnRow(id), getSetting(db, 'vpn.activeConfigId'));
  });
  app.delete('/api/admin/vpn/configs/:id', async (req, reply) => {
    const id = parse(idParam, (req.params as { id: string }).id);
    vpnRow(id);
    await deactivate(id);
    db.prepare('DELETE FROM vpn_configs WHERE id = ?').run(id);
    return reply.code(204).send();
  });
  app.get('/api/admin/vpn/status', async (): Promise<VpnStatusDto> => {
    const activeConfigId = getSetting(db, 'vpn.activeConfigId');
    try {
      return { ...(await vpn.status()), reachable: true, activeConfigId };
    } catch {
      return { mode: getSetting(db, 'vpn.mode'), connected: false, name: null, publicIp: null, lastHandshakeSec: null, since: null, reachable: false, activeConfigId };
    }
  });
  app.post('/api/admin/vpn/rotate', async (req) => {
    const b = parse(rotateBody, req.body ?? {});
    // Serialised with the worker's reconcile (DB lock): two concurrent connects could leave the tunnel on the wrong config.
    const token = await acquireVpnLockWait(db, ctx.vpnLockWaitMs);
    if (!token) throw conflict('Another VPN change is in progress; try again in a moment');
    try {
      await connectVpn(db, config, vpn, b.configId);
    } catch (e) {
      if (String((e as Error).message).startsWith('No enabled VPN config')) throw conflict('No enabled VPN config available');
      if (isVpnConflict(e)) throw conflict('Set VPN mode to required first');
      throw new ApiError(502, 'internal', 'VPN connection failed; see the config\'s last error');
    } finally { releaseVpnLock(db, token); }
    const active = getSetting(db, 'vpn.activeConfigId');
    return vpnDto(vpnRow(active!), active);
  });

  // ---- settings
  const settingsOut = (): SettingsDto => {
    const s = getAllSettings(db) as Record<string, unknown>;
    for (const k of HIDDEN_SETTINGS) delete s[k];
    for (const k of Object.keys(s)) if (k.startsWith('trackers.') || k.startsWith('search.')) delete s[k]; // own endpoints: /admin/trackers, /admin/engine/settings, /admin/search
    return s as unknown as SettingsDto;
  };
  app.get('/api/admin/settings', async () => settingsOut());
  app.put('/api/admin/settings', async (req) => {
    const patch = parse(settingsSchema, req.body ?? {}) as Record<string, unknown>;
    const prevMode = getSetting(db, 'vpn.mode');
    const newMode = patch['vpn.mode'] as 'off' | 'required' | undefined;
    if (newMode === 'required' && prevMode !== 'required') {
      const n = (db.prepare('SELECT COUNT(*) AS n FROM vpn_configs WHERE enabled = 1').get() as { n: number }).n;
      if (n === 0) throw conflict('Add and enable a VPN config before requiring the VPN');
    }
    db.transaction(() => {
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) setSetting(db, k as SettingKey, v as never);
    }).immediate();
    if (newMode && newMode !== prevMode) {
      try { await vpn.setMode(newMode); } catch { /* worker reconciles */ }
    }
    return settingsOut();
  });

  // ---- users
  const userRows = (where = '', ...args: unknown[]) =>
    db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM jobs j WHERE j.user_id = u.id AND j.state IN ${ACTIVE_SQL}) AS active_jobs FROM users u ${where} ORDER BY u.username`)
      .all(...args) as (UserRow & { active_jobs: number })[];
  app.get('/api/admin/users', async (): Promise<UserDto[]> => userRows().map(userDto));
  app.patch('/api/admin/users/:id', async (req): Promise<UserDto> => {
    const id = parse(idParam, (req.params as { id: string }).id);
    const b = parse(userUpdate, req.body);
    const [u] = userRows('WHERE u.id = ?', id);
    if (!u) throw notFound('User');
    if (b.disabled && id === req.user.id) throw conflict('You cannot disable your own account');
    db.prepare('UPDATE users SET disabled = ?, max_active_jobs = ? WHERE id = ?').run(
      b.disabled === undefined ? u.disabled : b.disabled ? 1 : 0, b.maxActiveJobs === undefined ? u.max_active_jobs : b.maxActiveJobs, id);
    return userDto(userRows('WHERE u.id = ?', id)[0]!);
  });
}
