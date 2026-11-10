import type { FastifyInstance } from 'fastify';
import { now } from '../../lib/types.js';
import type { Ctx } from '../context.js';
import { ACTIVE_SQL, JOB_SELECT, jobDto, type JobJoin } from '../mappers.js';

export function registerEvents(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  const closers = new Set<() => void>();
  app.addHook('preClose', async () => { for (const c of [...closers]) c(); });

  app.get('/api/events', (req, reply) => {
    const userId = req.user.id;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    const sigs = new Map<number, string>();
    let watermark = now();
    const q = db.prepare(`${JOB_SELECT} WHERE j.user_id = ? AND (j.state IN ${ACTIVE_SQL} OR j.updated_at >= ?)`);
    const poll = () => {
      try {
        const rows = q.all(userId, watermark - 1) as JobJoin[];
        for (const r of rows) {
          const sig = [r.updated_at, r.state, r.upload_progress, r.upload_speed, r.t_progress, r.t_dl_speed, r.t_state, r.t_name, r.error].join('|');
          if (sigs.get(r.id) === sig) continue;
          sigs.set(r.id, sig);
          res.write(`event: job\ndata: ${JSON.stringify(jobDto(r))}\n\n`);
          if (r.updated_at > watermark) watermark = r.updated_at;
        }
      } catch { /* db closed or busy: try again next tick */ }
    };
    poll();
    const pollTimer = setInterval(poll, ctx.ssePollMs);
    const pingTimer = setInterval(() => res.write(`event: ping\ndata: ${now()}\n\n`), ctx.ssePingMs);
    const close = () => {
      clearInterval(pollTimer); clearInterval(pingTimer); closers.delete(close);
      if (!res.writableEnded) res.end();
    };
    closers.add(close);
    req.raw.on('close', close);
  });
}
