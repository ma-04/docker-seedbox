import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { decryptJson, deriveKey, encryptJson } from '../../lib/crypto.js';
import { buildMagnet, canonicalizeMagnet, mergeTrackers } from '../../lib/source.js';
import { fullRemotePath, getDestination } from '../../lib/destinations.js';
import type { JobFilesDto } from '../../lib/dto.js';
import { getSetting } from '../../lib/settings.js';
import { normalizePath, signedUrl } from '../../lib/signing.js';
import { now, type DestinationRow, type JobFileRow, type JobRow, type TorrentRow, type TorrentSource, type UserRow } from '../../lib/types.js';
import type { Ctx } from '../context.js';
import { ApiError, idParam, limitExceeded, notFound, parse, validation } from '../errors.js';
import { ACTIVE_SQL, getJobJoin, JOB_SELECT, jobDto, type JobJoin } from '../mappers.js';
import { enforce, RATE } from '../ratelimit.js';
import { NetGuardError } from '../../lib/netguard.js';
import { guardConfig } from './destinations.js';
import { parseMagnet, parseTorrentFile, type ParsedSource } from '../torrent.js';

const jsonBody = z.object({ magnet: z.string().min(1).max(8192), destinationId: z.coerce.number().int().positive() });
const stateQuery = z.object({ state: z.enum(['queued', 'downloading', 'uploading', 'completed', 'failed', 'cancelled']).optional() });
const TORRENT_FILE_MAX = 5 * 1024 * 1024;
const WEEK = 7 * 86400;

/** Cancel a live job, or delete a finished one. Used by user and admin DELETE. */
function cancelOrDeleteJob(db: Ctx['db'], job: JobRow): void {
  if (job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled') {
    db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
  } else {
    db.prepare("UPDATE jobs SET state = 'cancelled', updated_at = ?, upload_speed = 0 WHERE id = ?").run(now(), job.id);
  }
}

/** New encrypted source for an existing torrent row after merging `parsed`'s trackers into a stored magnet; null = unchanged. */
export function mergeSource(secret: string, existingEnc: string, parsed: ParsedSource): string | null {
  let existing: TorrentSource;
  try { existing = decryptJson<TorrentSource>(secret, existingEnc); } catch { return null; }
  if (!('magnet' in existing)) return null; // a stored .torrent file is kept as is
  let trackers: string[] = [];
  let name: string | null = null;
  try { const c = canonicalizeMagnet(existing.magnet); trackers = c.trackers; name = c.name; } catch { /* legacy/unsafe stored value: rebuild from the new submission */ }
  const magnet = buildMagnet(parsed.infohash, name ?? parsed.name, mergeTrackers(trackers, parsed.trackers));
  return magnet === existing.magnet ? null : encryptJson(secret, { magnet });
}

export function registerJobs(app: FastifyInstance, ctx: Ctx): void {
  const { db, config } = ctx;

  const maxActive = (u: UserRow): number => u.max_active_jobs ?? getSetting(db, 'limits.maxActiveJobsPerUser');
  function assertCapacity(u: UserRow): void {
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND state IN ${ACTIVE_SQL}`).get(u.id) as { n: number }).n;
    if (n >= maxActive(u)) throw limitExceeded(`Active job limit reached (${maxActive(u)})`);
  }

  function resetTorrentIfDead(torrentId: number): void {
    db.prepare("UPDATE torrents SET state = 'pending', progress = 0, dl_speed = 0, error = NULL, completed_at = NULL WHERE id = ? AND state IN ('error','removed')").run(torrentId);
  }

  const cancelOrDelete = (job: JobRow) => cancelOrDeleteJob(db, job);
  function retry(job: JobRow, user: UserRow): void {
    if (job.state !== 'failed' && job.state !== 'cancelled') throw new ApiError(409, 'conflict', 'Only failed or cancelled jobs can be retried');
    db.transaction(() => {
      assertCapacity(user);
      db.prepare("UPDATE jobs SET state = 'queued', error = NULL, upload_progress = 0, upload_speed = 0, completed_at = NULL, updated_at = ? WHERE id = ?").run(now(), job.id);
      resetTorrentIfDead(job.torrent_id);
    })();
  }

  const ownJob = (user: UserRow, id: number): JobJoin => {
    const j = getJobJoin(db, id);
    if (!j || j.user_id !== user.id) throw notFound('Job');
    return j;
  };

  app.get('/api/jobs', async (req) => {
    const { state } = parse(stateQuery, req.query);
    const rows = db.prepare(`${JOB_SELECT} WHERE j.user_id = ? ${state ? 'AND j.state = ?' : ''} ORDER BY j.created_at DESC, j.id DESC LIMIT 1000`)
      .all(...(state ? [req.user.id, state] : [req.user.id])) as JobJoin[];
    return rows.map((r) => jobDto(r));
  });

  app.get('/api/jobs/:id', async (req) => jobDto(ownJob(req.user, parse(idParam, (req.params as { id: string }).id))));

  app.post('/api/jobs', async (req, reply) => {
    enforce(ctx.limiter, req.user.id, 'job-create', RATE.jobCreate);
    const user = req.user;
    let parsed: ParsedSource;
    let destinationId: number;
    if (req.isMultipart()) {
      let file: Buffer | null = null;
      let dest: string | undefined;
      for await (const part of req.parts({ limits: { fileSize: TORRENT_FILE_MAX, files: 1, fields: 5 } })) {
        if (part.type === 'file') {
          if (part.fieldname === 'torrent' && !file) {
            file = await part.toBuffer();
            if (part.file.truncated) throw new ApiError(413, 'limit_exceeded', 'Torrent file is larger than 5 MB');
          } else part.file.resume();
        } else if (part.fieldname === 'destinationId') dest = String(part.value);
      }
      if (!file) throw validation('torrent: file is required');
      destinationId = parse(jsonBody.shape.destinationId, dest);
      parsed = await parseTorrentFile(file);
    } else {
      const body = parse(jsonBody, req.body);
      destinationId = body.destinationId;
      parsed = await parseMagnet(body.magnet);
    }

    const dest = db.prepare('SELECT * FROM destinations WHERE id = ? AND enabled = 1 AND (owner_user_id IS NULL OR owner_user_id = ?)').get(destinationId, user.id) as DestinationRow | undefined;
    if (!dest) throw notFound('Destination');

    const maxBytes = getSetting(db, 'limits.maxTorrentBytes');
    if (maxBytes > 0 && parsed.totalSize > maxBytes) throw new ApiError(413, 'limit_exceeded', `Torrent is larger than the allowed ${maxBytes} bytes`);

    const sourceEnc = encryptJson(config.appSecret, parsed.source);
    const t = now();
    const result = db.transaction((): { id: number; created: boolean } => {
      let tor = db.prepare('SELECT * FROM torrents WHERE infohash = ?').get(parsed.infohash) as TorrentRow | undefined;
      if (!tor) {
        const info = db.prepare('INSERT INTO torrents (infohash, name, source_enc, total_size, state, added_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(parsed.infohash, parsed.name, sourceEnc, parsed.totalSize, 'pending', t);
        tor = { id: Number(info.lastInsertRowid) } as TorrentRow;
      } else if (tor.state === 'error' || tor.state === 'removed') {
        db.prepare("UPDATE torrents SET state = 'pending', progress = 0, dl_speed = 0, error = NULL, completed_at = NULL, source_enc = ?, name = COALESCE(?, name), total_size = MAX(total_size, ?) WHERE id = ?")
          .run(sourceEnc, parsed.name, parsed.totalSize, tor.id);
      } else {
        // Torrents are deduplicated by infohash across users: keep the first source but MERGE the (sanitised) trackers
        // of this submission into it, and re-write a legacy stored magnet in canonical form.
        const merged = mergeSource(config.appSecret, tor.source_enc, parsed);
        db.prepare('UPDATE torrents SET name = COALESCE(name, ?), source_enc = COALESCE(?, source_enc) WHERE id = ?').run(parsed.name, merged, tor.id);
      }
      const existing = db.prepare("SELECT id FROM jobs WHERE user_id = ? AND torrent_id = ? AND destination_id = ? AND state NOT IN ('failed','cancelled') ORDER BY id DESC LIMIT 1")
        .get(user.id, tor.id, dest.id) as { id: number } | undefined;
      if (existing) return { id: existing.id, created: false };
      assertCapacity(user);
      const info = db.prepare("INSERT INTO jobs (user_id, torrent_id, destination_id, state, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)")
        .run(user.id, tor.id, dest.id, t, t);
      return { id: Number(info.lastInsertRowid), created: true };
    })();
    return reply.code(result.created ? 201 : 200).send(jobDto(getJobJoin(db, result.id)!));
  });

  app.delete('/api/jobs/:id', async (req, reply) => {
    cancelOrDelete(ownJob(req.user, parse(idParam, (req.params as { id: string }).id)));
    return reply.code(204).send();
  });
  app.post('/api/jobs/:id/retry', async (req) => {
    const j = ownJob(req.user, parse(idParam, (req.params as { id: string }).id));
    retry(j, req.user);
    return jobDto(getJobJoin(db, j.id)!);
  });

  app.get('/api/jobs/:id/files', async (req): Promise<JobFilesDto> => {
    const job = ownJob(req.user, parse(idParam, (req.params as { id: string }).id));
    if (job.state !== 'completed') return { folderUrl: null, files: [] };
    const dest = getDestination(db, config.appSecret, job.destination_id);
    if (!dest) return { folderUrl: null, files: [] };
    const cfg = dest.config;
    // Re-check right before presigning: DNS may have changed since the destination was saved.
    try { await guardConfig(ctx, cfg, dest.row.owner_user_id === null); } catch (e) {
      if (e instanceof NetGuardError) return { folderUrl: job.folder_url, files: (db.prepare('SELECT * FROM job_files WHERE job_id = ? ORDER BY path').all(job.id) as JobFileRow[]).map((f) => ({ path: f.path, size: f.size, url: null })) };
      throw e;
    }
    const files = db.prepare('SELECT * FROM job_files WHERE job_id = ? ORDER BY path').all(job.id) as JobFileRow[];
    const remote = job.remote_path ?? '';
    let link: (f: JobFileRow) => Promise<string | null> | string | null = () => null;

    if (cfg.type === 'local') {
      const base = cfg.publicBaseUrl || `${config.publicScheme}://${config.filesHost}`;
      const key = deriveKey(config.appSecret, 'local-links');
      link = (f) => {
        const p = '/' + fullRemotePath(cfg, remote, f.path);
        return normalizePath(p) ? signedUrl(base, key, p, cfg.linkTtlSeconds ?? 86400, '/dl') : null;
      };
    } else if (cfg.type === 'gdrive') {
      const { proxyBaseUrl, proxySigningKey } = cfg;
      if (proxyBaseUrl && proxySigningKey) {
        link = (f) => {
          const p = '/' + fullRemotePath(cfg, remote, f.path);
          return normalizePath(p) ? signedUrl(proxyBaseUrl, proxySigningKey, p, cfg.linkTtlSeconds ?? 86400) : null;
        };
      }
    } else {
      const ttl = Math.min(cfg.linkTtlSeconds || 86400, WEEK);
      const client = new S3Client({
        endpoint: cfg.endpoint, region: cfg.region, forcePathStyle: cfg.forcePathStyle ?? true,
        credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      });
      link = (f) => {
        const key = fullRemotePath(cfg, remote, f.path);
        if (cfg.publicBaseUrl) return `${cfg.publicBaseUrl.replace(/\/+$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
        return getSignedUrl(client, new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), { expiresIn: ttl });
      };
    }
    const out = await Promise.all(files.map(async (f) => ({ path: f.path, size: f.size, url: await link(f) })));
    return { folderUrl: job.folder_url, files: out };
  });
}

/** Admin routes: register ONLY inside the requireAdmin plugin (see app.ts). */
export function registerAdminJobs(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  const anyJob = (id: number): JobJoin => {
    const j = getJobJoin(db, id);
    if (!j) throw notFound('Job');
    return j;
  };
  const cancelOrDelete = (job: JobRow) => cancelOrDeleteJob(db, job);
  app.get('/api/admin/jobs', async (req) => {
    const { state } = parse(stateQuery, req.query);
    const rows = db.prepare(`${JOB_SELECT} ${state ? 'WHERE j.state = ?' : ''} ORDER BY j.created_at DESC, j.id DESC LIMIT 1000`).all(...(state ? [state] : [])) as JobJoin[];
    return rows.map((r) => jobDto(r, true));
  });
  app.delete('/api/admin/jobs/:id', async (req, reply) => {
    cancelOrDelete(anyJob(parse(idParam, (req.params as { id: string }).id)));
    return reply.code(204).send();
  });
}
