import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { now, type UserRow } from '../lib/types.js';
import type { Ctx } from './context.js';
import { forbidden, unauthorized } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest { user: UserRow }
}

const sha = (s: string) => createHash('sha256').update(s).digest();
const header = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

export function registerAuth(app: FastifyInstance, ctx: Ctx): void {
  const { db, config } = ctx;
  app.decorateRequest('user', undefined as unknown as UserRow);
  const secretHash = sha(config.gatewaySecret);

  app.addHook('onRequest', async (req) => {
    const given = header(req.headers['x-gateway-secret']);
    if (given === undefined || !timingSafeEqual(sha(given), secretHash)) throw unauthorized();

    const path = req.url.split('?')[0]!;
    if (!path.startsWith('/api/') || path === '/api/health') return;

    const username = header(req.headers['remote-user'])?.trim();
    if (!username || username.length > 128) throw unauthorized('Missing user');
    const email = header(req.headers['remote-email'])?.trim().slice(0, 256) || null;
    const display = header(req.headers['remote-name'])?.trim().slice(0, 256) || null;
    const groups = (header(req.headers['remote-groups']) ?? '').split(',').map((g) => g.trim()).filter(Boolean);
    const isAdmin = groups.includes(config.adminGroup) ? 1 : 0;
    const t = now();

    let user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
    if (!user) {
      db.prepare('INSERT OR IGNORE INTO users (username, email, display_name, is_admin, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(username, email, display, isAdmin, t, t);
      user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow;
    } else if (user.is_admin !== isAdmin || user.email !== email || user.display_name !== display || t - user.last_seen_at >= 60) {
      const seen = t - user.last_seen_at >= 60 ? t : user.last_seen_at;
      db.prepare('UPDATE users SET email = ?, display_name = ?, is_admin = ?, last_seen_at = ? WHERE id = ?').run(email, display, isAdmin, seen, user.id);
      user = { ...user, email, display_name: display, is_admin: isAdmin, last_seen_at: seen };
    }
    if (user.disabled) throw forbidden('Account disabled');
    if (path.startsWith('/api/admin/') && !user.is_admin) throw forbidden('Admin only');
    req.user = user;
  });
}
