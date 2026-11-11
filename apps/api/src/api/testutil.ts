import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { loadConfig } from '../lib/config.js';
import { openDb } from '../lib/db.js';
import type { VpnStatus } from '../lib/types.js';
import type { VpnClient } from '../lib/vpn.js';
import { buildApp, type BuildAppOptions } from './app.js';
import type { EngineClient } from './engine.js';

export const GW = 'test-gateway-secret';
export type TestUser = { name: string; groups?: string };
export const alice: TestUser = { name: 'alice' };
export const bob: TestUser = { name: 'bob' };
export const root: TestUser = { name: 'root', groups: 'admins,staff' };

export function fakeVpn(overrides: Partial<VpnClient> = {}): VpnClient & { calls: string[] } {
  const calls: string[] = [];
  const status: VpnStatus = { mode: 'off', connected: true, name: 'x', publicIp: '203.0.113.5', lastHandshakeSec: 3, since: 1 };
  return {
    calls,
    status: async () => status,
    connect: async (n) => { calls.push(`connect:${n}`); return status; },
    disconnect: async () => { calls.push('disconnect'); },
    setMode: async (m) => { calls.push(`mode:${m}`); },
    ...overrides,
  };
}

export const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

/** Hosts of the three-host layout; pass `{ AUTH_HOST: '', FILES_HOST: '' }` as `hosts` for the single-domain one. */
export const THREE_HOSTS = { APP_HOST: 'app.example.test', AUTH_HOST: 'auth.example.test', FILES_HOST: 'files.example.test' };

export function setup(vpn = fakeVpn(), engine?: EngineClient, extra: Partial<BuildAppOptions> = {}, hosts: Partial<typeof THREE_HOSTS> = {}) {
  const downloads = mkdtempSync(join(tmpdir(), 'seedbox-test-'));
  const config = loadConfig({
    APP_SECRET: 's'.repeat(40), GATEWAY_SECRET: GW, VPN_CONTROL_TOKEN: 'vt', DOWNLOADS_DIR: downloads,
    ...THREE_HOSTS, ...hosts, PUBLIC_SCHEME: 'https',
  });
  const db = openDb(':memory:');
  const app = buildApp({ db, config, vpn, engine, ssePollMs: 50, ssePingMs: 80, lookup: publicLookup, ...extra });
  const call = (user: TestUser | null, method: InjectOptions['method'], url: string, payload?: unknown, extra: InjectOptions = {}) =>
    app.inject({
      method, url, payload: payload as InjectOptions['payload'],
      ...extra,
      headers: {
        'x-gateway-secret': GW,
        'x-requested-with': 'seedbox',
        ...(user ? { 'remote-user': user.name, ...(user.groups ? { 'remote-groups': user.groups } : {}) } : {}),
        ...(extra.headers ?? {}),
      },
    });
  return { app: app as FastifyInstance, db, config, vpn, call, downloads };
}
export type Env = ReturnType<typeof setup>;

export const HEX = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';
export const B32 = 'YEX6DQDLXISUVHOJ6UM3GNNKPQJWPKEK';
export const magnet = (h: string, name = 'Sample') => `magnet:?xt=urn:btih:${h}&dn=${encodeURIComponent(name)}`;

export async function makeLocalDest(env: Env, name = 'Library'): Promise<number> {
  const r = await env.call(root, 'POST', '/api/admin/destinations', { name, type: 'local', config: { subdir: 'lib' } });
  return r.json().id;
}

/** Minimal single-file .torrent (bencoded by hand). */
export function torrentFile(name = 'file.bin', length = 1000): Buffer {
  const pieces = Buffer.alloc(20, 7);
  return Buffer.concat([
    Buffer.from(`d4:infod6:lengthi${length}e4:name${name.length}:${name}12:piece lengthi16384e6:pieces20:`), pieces, Buffer.from('ee'),
  ]);
}

export function multipartBody(fields: Record<string, string>, file?: { name: string; data: Buffer }) {
  const b = '----seedboxtest';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) {
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="torrent"; filename="${file.name}"\r\nContent-Type: application/x-bittorrent\r\n\r\n`));
    parts.push(file.data, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${b}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}
