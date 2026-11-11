import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { makeS3Client } from '../../lib/s3client.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { enqueueDeletion } from '../../lib/deletions.js';
import { encryptConfig, getDestination } from '../../lib/destinations.js';
import type { TestResultDto } from '../../lib/dto.js';
import { getAccessToken, getFile } from '../../lib/gdrive.js';
import { assertPublicEndpoint, NetGuardError } from '../../lib/netguard.js';
import { now, type DestinationConfig, type DestinationRow, type DestinationType, type JobRow, type UserRow } from '../../lib/types.js';
import type { Ctx } from '../context.js';
import { applyConfigPatch, validateConfig } from '../destconfig.js';
import { conflict, forbidden, idParam, notFound, parse, validation } from '../errors.js';
import { ACTIVE_SQL, destinationDto } from '../mappers.js';
import { enforce, RATE } from '../ratelimit.js';
import { parseRcloneConfig } from '../rclone.js';

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(['gdrive', 's3', 'local']),
  config: z.record(z.unknown()).default({}),
  rcloneConfig: z.string().max(16384).optional(),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});
const updateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  config: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

/** Short, non-leaky failure category for users (no internal addresses, no upstream text). */
export function errorCategory(err: unknown): string {
  const e = err as { name?: string; code?: string; message?: string; $metadata?: { httpStatusCode?: number }; cause?: { code?: string } };
  const text = `${e?.name ?? ''} ${e?.code ?? e?.cause?.code ?? ''} ${e?.message ?? ''}`;
  const status = e?.$metadata?.httpStatusCode;
  if (/NoSuchBucket/i.test(text)) return 'bucket not found';
  if (/CERT|SSL|TLS|self[- ]signed|EPROTO|altnames/i.test(text)) return 'tls error';
  if (/InvalidAccessKeyId|SignatureDoesNotMatch|AccessDenied|Forbidden|Unauthorized|InvalidToken|token refresh failed/i.test(text) || status === 401 || status === 403) return 'auth failed';
  if (/Abort|Timeout|ETIMEDOUT|timed out/i.test(text)) return 'timeout';
  return 'unreachable';
}

/** Run the SSRF guard over every user-controlled URL of a config. Throws NetGuardError (safe message). */
export async function guardConfig(ctx: Ctx, config: DestinationConfig, allowPrivate: boolean): Promise<void> {
  if (config.type !== 's3') return;
  const opts = { allowPrivate, lookup: ctx.lookup };
  await assertPublicEndpoint(config.endpoint, opts);
  if (config.publicBaseUrl) await assertPublicEndpoint(config.publicBaseUrl, opts);
}

/**
 * `shared` = admin-managed destination (private addresses and http allowed). `detailed` = the
 * caller is an admin and may see the raw error text; everyone else only gets a short category.
 */
export async function testDestination(ctx: Ctx, type: DestinationType, config: DestinationConfig, who: { shared: boolean; detailed: boolean }): Promise<TestResultDto> {
  try {
    await guardConfig(ctx, config, who.shared);
    if (config.type === 'gdrive') {
      const creds = { clientId: config.clientId, clientSecret: config.clientSecret, refreshToken: config.refreshToken };
      await getAccessToken(creds, ctx.config.google);
      const f = await getFile(creds, ctx.config.google, config.rootFolderId).catch((err: unknown) => {
        if (/\(404\)/.test(String((err as Error).message))) {
          throw new Error('Root folder not found (404). With an OAuth token of scope drive.file only folders created by this same OAuth client are visible: '
            + 'create the folder with it (e.g. rclone mkdir) and use that folder id, or authorize with the full drive scope.');
        }
        throw err;
      });
      return { ok: true, message: `Connected. Root folder: ${f.name}` };
    }
    if (config.type === 's3') {
      const client = makeS3Client(config, { shared: who.shared, maxAttempts: 1 });
      try {
        const prefix = config.prefix?.replace(/^\/+/, '');
        await client.send(new ListObjectsV2Command({ Bucket: config.bucket, MaxKeys: 1, ...(prefix ? { Prefix: prefix } : {}) }),
          { abortSignal: AbortSignal.timeout(10_000) });
      } finally { client.destroy(); }
      return { ok: true, message: `Bucket "${config.bucket}" is reachable` };
    }
    const lib = resolve(ctx.config.downloadsDir, 'library');
    const dir = resolve(lib, (config.subdir ?? '').replace(/^\/+/, ''));
    if (dir !== lib && !dir.startsWith(lib + sep)) return { ok: false, message: 'Invalid subdirectory' };
    await mkdir(dir, { recursive: true });
    const probe = join(dir, `.seedbox-test-${randomBytes(4).toString('hex')}`);
    await writeFile(probe, 'ok');
    await rm(probe, { force: true });
    return { ok: true, message: `Folder ${dir} is writable` };
  } catch (err) {
    if (err instanceof NetGuardError) return { ok: false, message: `${type} test failed: ${err.message}` };
    if (!who.detailed) return { ok: false, message: `${type} test failed: ${errorCategory(err)}` };
    const msg = String((err as Error).message ?? err).replace(/\s+/g, ' ').slice(0, 200);
    return { ok: false, message: `${type} test failed: ${msg}` };
  }
}

function makeHelpers(ctx: Ctx) {
  const { db, config } = ctx;
  const secret = config.appSecret;
  const own = (user: UserRow, id: number): DestinationRow => {
    const row = db.prepare('SELECT * FROM destinations WHERE id = ? AND owner_user_id = ?').get(id, user.id) as DestinationRow | undefined;
    if (!row) throw notFound('Destination');
    return row;
  };
  const shared = (id: number): DestinationRow => {
    const row = db.prepare('SELECT * FROM destinations WHERE id = ? AND owner_user_id IS NULL').get(id) as DestinationRow | undefined;
    if (!row) throw notFound('Destination');
    return row;
  };
  const cfgOf = (row: DestinationRow) => getDestination(db, secret, row.id)!.config;

  async function guardOrReject(cfg: DestinationConfig, shared: boolean): Promise<void> {
    try { await guardConfig(ctx, cfg, shared); } catch (e) {
      if (e instanceof NetGuardError) throw validation(e.message);
      throw e;
    }
  }

  function remove(row: DestinationRow): void {
    const active = db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE destination_id = ? AND state IN ${ACTIVE_SQL}`).get(row.id) as { n: number };
    if (active.n > 0) throw conflict('Destination has active jobs; cancel them first');
    db.transaction(() => {
      // Delivered files of a LOCAL destination go too (queued while the destination row still exists; the worker works from
      // the stored path). Remote data is never purged here, whatever cleanup.deleteRemoteOnJobDelete says: deleting a
      // destination is often how credentials get rotated, and that setting is about job deletes.
      for (const j of db.prepare("SELECT * FROM jobs WHERE destination_id = ? AND state IN ('completed','failed','cancelled')").all(row.id) as JobRow[]) enqueueDeletion(db, secret, j, { remote: false });
      // Finished jobs reference the destination (no cascade): drop them with it.
      db.prepare('DELETE FROM jobs WHERE destination_id = ?').run(row.id);
      db.prepare('DELETE FROM destinations WHERE id = ?').run(row.id);
    }).immediate();
  }

  async function insert(ownerId: number | null, body: z.infer<typeof createSchema>, admin: boolean): Promise<DestinationRow> {
    let raw: Record<string, unknown> = { ...body.config };
    if (admin && body.rcloneConfig) {
      const rc = parseRcloneConfig(body.rcloneConfig);
      if (rc.type !== body.type) throw validation(`rcloneConfig is of type ${rc.type}, destination type is ${body.type}`);
      raw = { ...rc.fields, ...Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== '' && v !== undefined)) };
    }
    if (body.type === 's3' && !raw.endpoint && typeof raw.region === 'string' && raw.region) raw.endpoint = `https://s3.${raw.region}.amazonaws.com`;
    const cfg = validateConfig(body.type, raw);
    await guardOrReject(cfg, ownerId === null);
    const isDefault = ownerId === null && body.isDefault ? 1 : 0;
    return db.transaction(() => {
      if (isDefault) db.prepare('UPDATE destinations SET is_default = 0 WHERE owner_user_id IS NULL').run();
      const info = db.prepare('INSERT INTO destinations (owner_user_id, name, type, config_enc, enabled, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(ownerId, body.name, body.type, encryptConfig(secret, cfg), body.enabled === false ? 0 : 1, isDefault, now());
      return db.prepare('SELECT * FROM destinations WHERE id = ?').get(info.lastInsertRowid) as DestinationRow;
    })();
  }

  async function update(row: DestinationRow, body: z.infer<typeof updateSchema>, allowDefault: boolean): Promise<DestinationRow> {
    const newConfig = body.config ? applyConfigPatch(cfgOf(row), body.config) : null;
    if (newConfig) await guardOrReject(newConfig, row.owner_user_id === null);
    db.transaction(() => {
      if (allowDefault && body.isDefault === true) db.prepare('UPDATE destinations SET is_default = 0 WHERE owner_user_id IS NULL').run();
      db.prepare('UPDATE destinations SET name = ?, enabled = ?, is_default = ?, config_enc = ? WHERE id = ?').run(
        body.name ?? row.name, body.enabled === undefined ? row.enabled : body.enabled ? 1 : 0,
        allowDefault && body.isDefault !== undefined ? (body.isDefault ? 1 : 0) : row.is_default,
        newConfig ? encryptConfig(secret, newConfig) : row.config_enc, row.id);
    })();
    return db.prepare('SELECT * FROM destinations WHERE id = ?').get(row.id) as DestinationRow;
  }

  return { own, shared, cfgOf, insert, update, remove, secret };
}

export function registerDestinations(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  const { own, cfgOf, insert, update, remove, secret } = makeHelpers(ctx);
  app.get('/api/destinations', async (req) => {
    const rows = db.prepare('SELECT * FROM destinations WHERE (owner_user_id IS NULL AND enabled = 1) OR owner_user_id = ? ORDER BY owner_user_id IS NOT NULL, name')
      .all(req.user.id) as DestinationRow[];
    return rows.map((r) => destinationDto(secret, r, r.owner_user_id === null));
  });

  app.post('/api/destinations', async (req, reply) => {
    const body = parse(createSchema, req.body);
    if (body.type !== 's3') throw forbidden('Only S3 destinations can be created here');
    enforce(ctx.limiter, req.user.id, 'dest-create', RATE.destinationCreate);
    const row = await insert(req.user.id, { ...body, rcloneConfig: undefined }, false);
    return reply.code(201).send(destinationDto(secret, row, false));
  });

  app.patch('/api/destinations/:id', async (req) => {
    const row = own(req.user, parse(idParam, (req.params as { id: string }).id));
    const body = parse(updateSchema, req.body);
    if (body.config && row.type !== 's3') throw forbidden('Only S3 destination settings can be edited');
    return destinationDto(secret, await update(row, body, false), false);
  });

  app.delete('/api/destinations/:id', async (req, reply) => {
    remove(own(req.user, parse(idParam, (req.params as { id: string }).id)));
    return reply.code(204).send();
  });

  app.post('/api/destinations/:id/test', async (req) => {
    enforce(ctx.limiter, req.user.id, 'dest-test', RATE.destinationTest);
    const row = own(req.user, parse(idParam, (req.params as { id: string }).id));
    return testDestination(ctx, row.type, cfgOf(row), { shared: false, detailed: !!req.user.is_admin });
  });
}

/** Admin routes: register ONLY inside the requireAdmin plugin (see app.ts). */
export function registerAdminDestinations(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  const { shared, cfgOf, insert, update, remove, secret } = makeHelpers(ctx);
  app.get('/api/admin/destinations', async () => {
    const rows = db.prepare('SELECT * FROM destinations WHERE owner_user_id IS NULL ORDER BY name').all() as DestinationRow[];
    return rows.map((r) => destinationDto(secret, r, false));
  });
  app.post('/api/admin/destinations', async (req, reply) => {
    enforce(ctx.limiter, req.user.id, 'dest-create', RATE.destinationCreate);
    const row = await insert(null, parse(createSchema, req.body), true);
    return reply.code(201).send(destinationDto(secret, row, false));
  });
  app.patch('/api/admin/destinations/:id', async (req) => {
    const row = shared(parse(idParam, (req.params as { id: string }).id));
    return destinationDto(secret, await update(row, parse(updateSchema, req.body), true), false);
  });
  app.delete('/api/admin/destinations/:id', async (req, reply) => {
    remove(shared(parse(idParam, (req.params as { id: string }).id)));
    return reply.code(204).send();
  });
  app.post('/api/admin/destinations/:id/test', async (req) => {
    enforce(ctx.limiter, req.user.id, 'dest-test', RATE.destinationTest);
    const row = shared(parse(idParam, (req.params as { id: string }).id));
    return testDestination(ctx, row.type, cfgOf(row), { shared: true, detailed: true });
  });
}
