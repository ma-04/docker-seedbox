import type { FastifyInstance } from 'fastify';
import { decryptJson, deriveKey } from '../../lib/crypto.js';
import type { LocalConfig } from '../../lib/types.js';
import { normalizePath, verify } from '../../lib/signing.js';
import type { Ctx } from '../context.js';
import { ApiError, notFound } from '../errors.js';

const rfc5987 = (s: string) => encodeURIComponent(s).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function registerDl(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  const key = deriveKey(ctx.config.appSecret, 'local-links');

  /**
   * Signed links are stateless, so revocation is enforced here: the path must belong to a file of
   * a *completed* job whose owner is not disabled. Deleting the job (or disabling the user) kills
   * its local links even before `exp`. Path layout: `<subdir>/<remote_path>/<job_files.path>`.
   */
  function coveredByLiveJob(segs: string[]): boolean {
    const dests = db.prepare("SELECT id, config_enc FROM destinations WHERE type = 'local'").all() as { id: number; config_enc: string }[];
    const q = db.prepare(`SELECT 1 FROM jobs j JOIN users u ON u.id = j.user_id JOIN job_files f ON f.job_id = j.id
      WHERE j.destination_id = ? AND j.state = 'completed' AND u.disabled = 0 AND j.remote_path = ? AND f.path = ? LIMIT 1`);
    for (const d of dests) {
      const sub = (decryptJson<LocalConfig>(ctx.config.appSecret, d.config_enc).subdir ?? '').split('/').filter(Boolean);
      if (!sub.every((x, i) => segs[i] === x)) continue;
      const rest = segs.slice(sub.length);
      for (let k = 1; k < rest.length; k++) {
        if (q.get(d.id, rest.slice(0, k).join('/'), rest.slice(k).join('/'))) return true;
      }
    }
    return false;
  }

  app.get('/dl/*', async (req, reply) => {
    const [pathname] = req.raw.url!.split('?');
    const rawSegs = pathname!.slice('/dl'.length).split('/').slice(1);
    let segs: string[];
    try { segs = rawSegs.map(decodeURIComponent); } catch { throw notFound('File'); }
    if (segs.some((s) => s.includes('/'))) throw notFound('File');
    const path = '/' + segs.join('/');
    if (!normalizePath(path)) throw notFound('File');
    const q = req.query as Record<string, unknown>;
    const res = verify(key, path, typeof q.exp === 'string' ? q.exp : '', typeof q.sig === 'string' ? q.sig : '');
    if (res === 'bad-signature') throw new ApiError(403, 'forbidden', 'Invalid link');
    if (res === 'expired') throw new ApiError(410, 'gone', 'Link expired');
    if (!coveredByLiveJob(segs)) throw notFound('File');
    return reply
      .code(200)
      .header('X-Accel-Redirect', '/_protected/' + segs.map(encodeURIComponent).join('/'))
      .header('Content-Disposition', `attachment; filename*=UTF-8''${rfc5987(segs[segs.length - 1]!)}`)
      .header('Content-Type', 'application/octet-stream')
      // These survive X-Accel-Redirect, so user-uploaded html/svg can never execute on the files host.
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .send('');
  });
}
