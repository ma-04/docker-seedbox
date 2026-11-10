import { contentDisposition, safeContentType } from './disposition';
import { download, resolveFile, throwForDrive, type DriveFile } from './drive';
import { canonicalPath, verify } from './signing';
import { HttpError, type Env } from './types';

const REQUIRED = ['GDRIVE_CLIENT_ID', 'GDRIVE_CLIENT_SECRET', 'GDRIVE_REFRESH_TOKEN', 'SIGNING_KEY', 'ROOT_FOLDER_ID'] as const;

function text(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body + '\n', {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex', ...extra },
  });
}

function cors(req: Request, env: Env, res: Response): Response {
  const origin = req.headers.get('origin');
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!origin || !allowed.length) return res;
  if (allowed.includes('*')) res.headers.set('access-control-allow-origin', '*');
  else if (allowed.includes(origin)) {
    res.headers.set('access-control-allow-origin', origin);
    res.headers.append('vary', 'Origin');
  } else return res;
  res.headers.set('access-control-expose-headers', 'Content-Length, Content-Range, Content-Disposition, ETag, Accept-Ranges');
  return res;
}

function fileHeaders(file: DriveFile): Headers {
  const h = new Headers({
    'content-type': safeContentType(file.mimeType),
    'content-security-policy': "default-src 'none'; sandbox",
    'accept-ranges': 'bytes',
    'content-disposition': contentDisposition(file.name),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex',
  });
  if (file.md5Checksum) h.set('etag', `"${file.md5Checksum}"`);
  if (file.modifiedTime) {
    const d = new Date(file.modifiedTime);
    if (!Number.isNaN(d.getTime())) h.set('last-modified', d.toUTCString());
  }
  return h;
}

async function handle(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'Method not allowed', { allow: 'GET, HEAD' });
  const url = new URL(req.url);
  if (url.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });

  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) {
    console.error(`drive-proxy misconfigured, missing binding(s): ${missing.join(', ')}`);
    return text(500, 'Server misconfigured');
  }

  const path = canonicalPath(url.pathname);
  if (!path) return text(404, 'Not found');

  const verdict = await verify(env.SIGNING_KEY, path, url.searchParams.get('exp'), url.searchParams.get('sig'));
  if (verdict === 'expired') return text(410, 'Link expired');
  if (verdict !== 'ok') return text(403, 'Forbidden');

  const file = await resolveFile(env, path);
  if (!file) return text(404, 'Not found');

  const headers = fileHeaders(file);
  if (req.method === 'HEAD') {
    if (file.size) headers.set('content-length', file.size);
    return new Response(null, { status: 200, headers });
  }

  // Forward Range. If-Range holding our own validators is satisfied already (our ETag/Last-Modified
  // come from the same metadata), so drop it; any other validator means "send the whole file".
  const up: Record<string, string> = {};
  const range = req.headers.get('range');
  const ifRange = req.headers.get('if-range');
  if (range) {
    if (!ifRange) up.range = range;
    else if (ifRange === headers.get('etag') || ifRange === headers.get('last-modified')) up.range = range;
  }

  const res = await download(env, file.id, up);
  if (res.status !== 200 && res.status !== 206 && res.status !== 416) return throwForDrive(res);

  const out = new Headers(headers);
  const cl = res.headers.get('content-length');
  if (cl) out.set('content-length', cl);
  else if (res.status === 200 && file.size) out.set('content-length', file.size);
  const cr = res.headers.get('content-range');
  if (cr) out.set('content-range', cr);
  return new Response(res.status === 416 ? null : res.body, { status: res.status, headers: out });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    let res: Response;
    try {
      res = await handle(req, env);
    } catch (e) {
      if (e instanceof HttpError) res = text(e.status, e.message, e.retryAfter ? { 'retry-after': String(e.retryAfter) } : {});
      else {
        console.error('unhandled error', e instanceof Error ? e.name : typeof e);
        res = text(502, 'Upstream error');
      }
    }
    return cors(req, env, res);
  },
} satisfies ExportedHandler<Env>;
