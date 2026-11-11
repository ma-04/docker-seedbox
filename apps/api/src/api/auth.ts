import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { now, type UserRow } from '../lib/types.js';
import type { Ctx } from './context.js';
import { ApiError, forbidden, unauthorized } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest { user: UserRow }
  interface FastifyContextConfig { guard?: 'user' | 'admin' | 'public' }
}

const sha = (s: string) => createHash('sha256').update(s).digest();
const header = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'seedbox';

const BAD_ESCAPE = /%(2f|5c|2e|00)/i;
const API_PREFIX_ANY_CASE = /^\/api(\/|$)/i;

/**
 * Root-level checks that run for every request, matched or not. They never decide
 * *authorisation*: that is done per matched route by `requireUser` / `requireAdmin`, which are
 * attached to encapsulated plugins in app.ts. Deriving "is this an admin route" from the URL
 * string is what allowed `/api/%61dmin/users` to skip the admin check.
 */
export function registerGuards(app: FastifyInstance, ctx: Ctx): void {
  const secretHash = sha(ctx.config.gatewaySecret);

  app.addHook('onRequest', async (req) => {
    const given = header(req.headers['x-gateway-secret']);
    if (given === undefined || !timingSafeEqual(sha(given), secretHash)) throw unauthorized();

    const path = req.url.split('?')[0]!;
    // /dl/* validates its own (signed) path.
    if (!path.startsWith('/dl/')) {
      // Fastify decodes percent-escapes before routing; refuse the ones that hide separators/dots.
      if (BAD_ESCAPE.test(path)) throw new ApiError(400, 'validation', 'Invalid path');
      if (path.includes('//') || path.split('/').some((s) => s === '.' || s === '..')) throw new ApiError(400, 'validation', 'Invalid path');
      if (API_PREFIX_ANY_CASE.test(path) && !path.startsWith('/api/') && path !== '/api') throw new ApiError(400, 'validation', 'Invalid path');
    }

    // CSRF defence in depth: the SPA sends a custom header that cross-site forms cannot set.
    if ((path === '/api' || path.startsWith('/api/')) && req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS'
      && header(req.headers[CSRF_HEADER]) !== CSRF_VALUE) {
      throw new ApiError(403, 'csrf', 'Missing X-Requested-With header');
    }
  });
}

/** Loads (auto-provisioning) the calling user. Attach to the plugin holding every authenticated route. */
export function makeRequireUser(ctx: Ctx) {
  const { db, config } = ctx;
  return async function requireUser(req: FastifyRequest): Promise<void> {
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
    req.user = user;
  };
}

/** Attach to the plugin holding every admin route (after requireUser). */
export async function requireAdmin(req: FastifyRequest): Promise<void> {
  if (!req.user?.is_admin) throw forbidden('Admin only');
}

/** Tags every route registered in this (encapsulated) scope with its guard level, for the route-table test. */
export function tagRoutes(scope: FastifyInstance, guard: 'user' | 'admin' | 'public'): void {
  scope.addHook('onRoute', (r) => { r.config = { ...(r.config as object | undefined), guard }; });
}

export function decorateUser(app: FastifyInstance): void {
  app.decorateRequest('user', undefined as unknown as UserRow);
}
