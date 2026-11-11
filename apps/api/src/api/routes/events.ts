import type { FastifyInstance } from 'fastify';
import { now } from '../../lib/types.js';
import type { Ctx } from '../context.js';
import { ApiError } from '../errors.js';
import { ACTIVE_SQL, JOB_SELECT, jobDto, type JobJoin } from '../mappers.js';

interface Sub {
  userId: number;
  write: (chunk: string) => void;
  close: () => void;
  sigs: Map<number, string>;
  watermark: number;
}

const sigOf = (r: JobJoin) => [r.updated_at, r.state, r.upload_progress, r.upload_speed, r.t_progress, r.t_dl_speed, r.t_state, r.t_name, r.error].join('|');

/**
 * Server-sent events. One shared poller (a single timer and a single query per tick, for all
 * subscribers) fans job changes out to per-user subscriber sets. Caps: `sseMaxPerUser` streams
 * per user (the oldest is closed to make room) and `sseMaxTotal` overall (503). Streams of users
 * who become disabled are closed on the next tick.
 */
export function registerEvents(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  const byUser = new Map<number, Sub[]>(); // insertion order = oldest first
  let total = 0;
  let pollTimer: NodeJS.Timeout | undefined;
  let pingTimer: NodeJS.Timeout | undefined;

  const subs = (): Sub[] => [...byUser.values()].flat();

  function remove(sub: Sub): void {
    const list = byUser.get(sub.userId);
    if (!list) return;
    const i = list.indexOf(sub);
    if (i < 0) return;
    list.splice(i, 1);
    total--;
    if (list.length === 0) byUser.delete(sub.userId);
    if (total === 0) stopTimers();
  }

  function stopTimers(): void {
    if (pollTimer) clearInterval(pollTimer);
    if (pingTimer) clearInterval(pingTimer);
    pollTimer = pingTimer = undefined;
  }

  function tick(): void {
    const all = subs();
    if (all.length === 0) return;
    try {
      const ids = [...byUser.keys()];
      const marks = ids.map(() => '?').join(',');
      const disabled = db.prepare(`SELECT id FROM users WHERE disabled = 1 AND id IN (${marks})`).all(...ids) as { id: number }[];
      for (const { id } of disabled) for (const s of [...(byUser.get(id) ?? [])]) s.close();

      const live = ids.filter((id) => byUser.has(id));
      if (live.length === 0) return;
      const lowest = Math.min(...subs().map((s) => s.watermark)) - 1;
      const rows = db.prepare(`${JOB_SELECT} WHERE j.user_id IN (${live.map(() => '?').join(',')}) AND (j.state IN ${ACTIVE_SQL} OR j.updated_at >= ?)`)
        .all(...live, lowest) as JobJoin[];
      for (const r of rows) {
        const sig = sigOf(r);
        for (const s of byUser.get(r.user_id) ?? []) {
          if (s.sigs.get(r.id) === sig) continue;
          s.sigs.set(r.id, sig);
          s.write(`event: job\ndata: ${JSON.stringify(jobDto(r))}\n\n`);
          if (r.updated_at > s.watermark) s.watermark = r.updated_at;
        }
      }
    } catch { /* db closed or busy: try again next tick */ }
  }

  function startTimers(): void {
    if (pollTimer) return;
    pollTimer = setInterval(tick, ctx.ssePollMs);
    pingTimer = setInterval(() => { for (const s of subs()) s.write(`event: ping\ndata: ${now()}\n\n`); }, ctx.ssePingMs);
    pollTimer.unref();
    pingTimer.unref();
  }

  app.addHook('preClose', async () => { for (const s of subs()) s.close(); });

  app.get('/api/events', (req, reply) => {
    const userId = req.user.id;
    const mine = byUser.get(userId) ?? [];
    if (mine.length < ctx.sseMaxPerUser && total >= ctx.sseMaxTotal) {
      throw new ApiError(503, 'unavailable', 'Too many open event streams', { 'Retry-After': '5' });
    }
    // Evict the oldest streams of this user to stay within the per-user cap.
    while ((byUser.get(userId)?.length ?? 0) >= ctx.sseMaxPerUser) byUser.get(userId)![0]!.close();

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    const sub: Sub = {
      userId, sigs: new Map(), watermark: now(),
      write: (chunk) => { if (!res.writableEnded) res.write(chunk); },
      close: () => { remove(sub); if (!res.writableEnded) res.end(); },
    };
    // Initial snapshot for this subscriber only (not a poll).
    try {
      const rows = db.prepare(`${JOB_SELECT} WHERE j.user_id = ? AND (j.state IN ${ACTIVE_SQL} OR j.updated_at >= ?)`).all(userId, sub.watermark - 1) as JobJoin[];
      for (const r of rows) {
        sub.sigs.set(r.id, sigOf(r));
        sub.write(`event: job\ndata: ${JSON.stringify(jobDto(r))}\n\n`);
        if (r.updated_at > sub.watermark) sub.watermark = r.updated_at;
      }
    } catch { /* next tick */ }

    const list = byUser.get(userId) ?? [];
    list.push(sub);
    byUser.set(userId, list);
    total++;
    startTimers();
    req.raw.on('close', () => remove(sub));
  });
}
