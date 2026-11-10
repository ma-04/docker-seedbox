import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { encryptConfig, getDestination } from '../../lib/destinations.js';
import type { TestResultDto } from '../../lib/dto.js';
import { getAccessToken, getFile } from '../../lib/gdrive.js';
import { now, type DestinationConfig, type DestinationRow, type DestinationType, type UserRow } from '../../lib/types.js';
import type { Ctx } from '../context.js';
import { applyConfigPatch, validateConfig } from '../destconfig.js';
import { conflict, forbidden, idParam, notFound, parse, validation } from '../errors.js';
import { ACTIVE_SQL, destinationDto } from '../mappers.js';
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

export async function testDestination(ctx: Ctx, type: DestinationType, config: DestinationConfig): Promise<TestResultDto> {
  try {
    if (config.type === 'gdrive') {
      const creds = { clientId: config.clientId, clientSecret: config.clientSecret, refreshToken: config.refreshToken };
      await getAccessToken(creds, ctx.config.google);
      const f = await getFile(creds, ctx.config.google, config.rootFolderId);
      return { ok: true, message: `Connected. Root folder: ${f.name}` };
    }
    if (config.type === 's3') {
      const client = new S3Client({
        endpoint: config.endpoint, region: config.region, forcePathStyle: config.forcePathStyle ?? true, maxAttempts: 1,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      });
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
    const msg = String((err as Error).message ?? err).replace(/\s+/g, ' ').slice(0, 200);
    return { ok: false, message: `${type} test failed: ${msg}` };
  }
}

export function registerDestinations(app: FastifyInstance, ctx: Ctx): void {
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

  function remove(row: DestinationRow): void {
    const active = db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE destination_id = ? AND state IN ${ACTIVE_SQL}`).get(row.id) as { n: number };
    if (active.n > 0) throw conflict('Destination has active jobs; cancel them first');
    db.transaction(() => {
      // Finished jobs reference the destination (no cascade): drop them with it.
      db.prepare('DELETE FROM jobs WHERE destination_id = ?').run(row.id);
      db.prepare('DELETE FROM destinations WHERE id = ?').run(row.id);
    })();
  }

  function insert(ownerId: number | null, body: z.infer<typeof createSchema>, admin: boolean): DestinationRow {
    let raw: Record<string, unknown> = { ...body.config };
    if (admin && body.rcloneConfig) {
      const rc = parseRcloneConfig(body.rcloneConfig);
      if (rc.type !== body.type) throw validation(`rcloneConfig is of type ${rc.type}, destination type is ${body.type}`);
      raw = { ...rc.fields, ...Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== '' && v !== undefined)) };
    }
    if (body.type === 's3' && !raw.endpoint && typeof raw.region === 'string' && raw.region) raw.endpoint = `https://s3.${raw.region}.amazonaws.com`;
    const cfg = validateConfig(body.type, raw);
    const isDefault = ownerId === null && body.isDefault ? 1 : 0;
    return db.transaction(() => {
      if (isDefault) db.prepare('UPDATE destinations SET is_default = 0 WHERE owner_user_id IS NULL').run();
      const info = db.prepare('INSERT INTO destinations (owner_user_id, name, type, config_enc, enabled, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(ownerId, body.name, body.type, encryptConfig(secret, cfg), body.enabled === false ? 0 : 1, isDefault, now());
      return db.prepare('SELECT * FROM destinations WHERE id = ?').get(info.lastInsertRowid) as DestinationRow;
    })();
  }

  function update(row: DestinationRow, body: z.infer<typeof updateSchema>, allowDefault: boolean): DestinationRow {
    const newConfig = body.config ? applyConfigPatch(cfgOf(row), body.config) : null;
    db.transaction(() => {
      if (allowDefault && body.isDefault === true) db.prepare('UPDATE destinations SET is_default = 0 WHERE owner_user_id IS NULL').run();
      db.prepare('UPDATE destinations SET name = ?, enabled = ?, is_default = ?, config_enc = ? WHERE id = ?').run(
        body.name ?? row.name, body.enabled === undefined ? row.enabled : body.enabled ? 1 : 0,
        allowDefault && body.isDefault !== undefined ? (body.isDefault ? 1 : 0) : row.is_default,
        newConfig ? encryptConfig(secret, newConfig) : row.config_enc, row.id);
    })();
    return db.prepare('SELECT * FROM destinations WHERE id = ?').get(row.id) as DestinationRow;
  }

  // ---- user routes
  app.get('/api/destinations', async (req) => {
    const rows = db.prepare('SELECT * FROM destinations WHERE (owner_user_id IS NULL AND enabled = 1) OR owner_user_id = ? ORDER BY owner_user_id IS NOT NULL, name')
      .all(req.user.id) as DestinationRow[];
    return rows.map((r) => destinationDto(secret, r, r.owner_user_id === null));
  });

  app.post('/api/destinations', async (req, reply) => {
    const body = parse(createSchema, req.body);
    if (body.type !== 's3') throw forbidden('Only S3 destinations can be created here');
    const row = insert(req.user.id, { ...body, rcloneConfig: undefined }, false);
    return reply.code(201).send(destinationDto(secret, row, false));
  });

  app.patch('/api/destinations/:id', async (req) => {
    const row = own(req.user, parse(idParam, (req.params as { id: string }).id));
    const body = parse(updateSchema, req.body);
    if (body.config && row.type !== 's3') throw forbidden('Only S3 destination settings can be edited');
    return destinationDto(secret, update(row, body, false), false);
  });

  app.delete('/api/destinations/:id', async (req, reply) => {
    remove(own(req.user, parse(idParam, (req.params as { id: string }).id)));
    return reply.code(204).send();
  });

  app.post('/api/destinations/:id/test', async (req) => {
    const row = own(req.user, parse(idParam, (req.params as { id: string }).id));
    return testDestination(ctx, row.type, cfgOf(row));
  });

  // ---- admin routes
  app.get('/api/admin/destinations', async () => {
    const rows = db.prepare('SELECT * FROM destinations WHERE owner_user_id IS NULL ORDER BY name').all() as DestinationRow[];
    return rows.map((r) => destinationDto(secret, r, false));
  });
  app.post('/api/admin/destinations', async (req, reply) => {
    const row = insert(null, parse(createSchema, req.body), true);
    return reply.code(201).send(destinationDto(secret, row, false));
  });
  app.patch('/api/admin/destinations/:id', async (req) => {
    const row = shared(parse(idParam, (req.params as { id: string }).id));
    return destinationDto(secret, update(row, parse(updateSchema, req.body), true), false);
  });
  app.delete('/api/admin/destinations/:id', async (req, reply) => {
    remove(shared(parse(idParam, (req.params as { id: string }).id)));
    return reply.code(204).send();
  });
  app.post('/api/admin/destinations/:id/test', async (req) => {
    const row = shared(parse(idParam, (req.params as { id: string }).id));
    return testDestination(ctx, row.type, cfgOf(row));
  });
}
