import type { FastifyInstance } from 'fastify';
import { deriveKey } from '../../lib/crypto.js';
import { normalizePath, verify } from '../../lib/signing.js';
import type { Ctx } from '../context.js';
import { ApiError, notFound } from '../errors.js';

const rfc5987 = (s: string) => encodeURIComponent(s).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function registerDl(app: FastifyInstance, ctx: Ctx): void {
  const key = deriveKey(ctx.config.appSecret, 'local-links');
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
    return reply
      .code(200)
      .header('X-Accel-Redirect', '/_protected/' + segs.map(encodeURIComponent).join('/'))
      .header('Content-Disposition', `attachment; filename*=UTF-8''${rfc5987(segs[segs.length - 1]!)}`)
      .header('Content-Type', 'application/octet-stream')
      .send('');
  });
}
