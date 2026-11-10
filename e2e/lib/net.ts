import http from 'node:http';
import https from 'node:https';
import { env } from './env';

export interface RawResponse { status: number; headers: http.IncomingHttpHeaders; body: Buffer }

/**
 * Plain HTTP(S) request without redirects or cookies, honouring E2E_CONNECT (tunnel mode) for *.seedbox.test.
 * Used for everything that must not go through the browser: signed download links, spoofed headers, Range, S3.
 */
export function raw(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<RawResponse> {
  const u = new URL(url);
  const secure = u.protocol === 'https:';
  let host = u.hostname;
  let port = Number(u.port || (secure ? 443 : 80));
  if (env.connect && host.endsWith('.seedbox.test')) {
    const [h, p] = env.connect.split(':');
    host = h!; port = Number(p);
  }
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request({
      host, port, path: u.pathname + u.search, method: opts.method ?? 'GET',
      headers: { host: u.host, 'accept-encoding': 'identity', ...opts.headers },
      servername: u.hostname, rejectUnauthorized: false,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(60_000, () => req.destroy(new Error(`timeout: ${url}`)));
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
