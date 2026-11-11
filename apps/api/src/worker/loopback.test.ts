import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Go never proxies requests to localhost/loopback, so an S3 endpoint that redirects rclone to 127.0.0.1 skips the egress
// proxy and reaches the worker container's own loopback (docs: SECURITY.md "Outbound requests"). That is only harmless
// while nothing else listens there: the API port lives in the api container, not in the worker.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? sources(join(dir, e.name)) : /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [join(dir, e.name)] : []);

describe('worker loopback exposure', () => {
  it('the only listening socket reachable from the worker entrypoint is the token-protected egress proxy on 127.0.0.1', () => {
    // Everything imported (transitively) by worker.ts: its own tree minus the API-only entrypoint and routes.
    const rel = (f: string): string => f.slice(SRC.length + 1);
    const worker = sources(SRC).filter((f) => rel(f) !== 'api.ts' && !rel(f).startsWith('api/'));
    const listeners = worker.filter((f) => /\.listen\s*\(|\bcreateServer\s*\(|\bfastify\s*\(|\bnet\.Server\b|dgram\.createSocket/.test(readFileSync(f, 'utf8')));
    expect(listeners.map(rel)).toEqual(['worker/egress-proxy.ts']);
  });

  it('the egress proxy binds 127.0.0.1 only, on an ephemeral port, and demands the proxy token', () => {
    const src = readFileSync(join(SRC, 'worker/egress-proxy.ts'), 'utf8');
    expect(src).toMatch(/\.listen\(0, '127\.0\.0\.1'/);
    expect(src).not.toMatch(/0\.0\.0\.0|'::'/);
    expect(src).toMatch(/407/);
  });

  it('worker.ts does not import the API server', () => {
    const entry = readFileSync(join(SRC, 'worker.ts'), 'utf8');
    expect(entry).not.toMatch(/from '\.\/api(\.js|\/)/);
    expect(entry).not.toMatch(/fastify/);
  });
});
