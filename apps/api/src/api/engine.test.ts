import { describe, expect, it } from 'vitest';
import type { EngineClient } from './engine.js';
import { alice, root, setup } from './testutil.js';

// A realistic-ish /app/preferences payload including fields that must never leak.
const prefs = (): Record<string, unknown> => ({
  dl_limit: 5 * 1024 * 1024, up_limit: 0, max_connec: 200, max_connec_per_torrent: 100, max_uploads: -1, max_uploads_per_torrent: -1,
  queueing_enabled: true, max_active_downloads: 3, max_active_uploads: 3, max_active_torrents: 5,
  dht: true, pex: false, lsd: true, encryption: 1, anonymous_mode: false,
  listen_port: 51413, random_port: false, add_trackers_enabled: true, add_trackers: 'udp://tracker.example.test:1337/announce',
  save_path: '/downloads', web_ui_password: 'hunter2', autorun_program: 'rm -rf /', web_ui_username: 'admin',
});

function fakeEngine(over: Partial<EngineClient> = {}) {
  const sets: Record<string, unknown>[] = [];
  let gets = 0;
  const engine: EngineClient = {
    getPreferences: async () => { gets++; return prefs(); },
    setPreferences: async (p) => { sets.push(p); },
    ...over,
  };
  return { engine, sets, gets: () => gets };
}
const URL = '/api/admin/engine/settings';

describe('engine settings', () => {
  it('is admin only', async () => {
    const f = fakeEngine();
    const env = setup(undefined, f.engine);
    expect((await env.call(alice, 'GET', URL)).statusCode).toBe(403);
    expect((await env.call(alice, 'PUT', URL, { dht: false })).statusCode).toBe(403);
    expect(f.gets()).toBe(0);
    expect(f.sets).toEqual([]);
  });

  it('GET maps units/enums and returns only whitelisted fields', async () => {
    const env = setup(undefined, fakeEngine().engine);
    const r = await env.call(root, 'GET', URL);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      downloadLimitKBps: 5120, uploadLimitKBps: 0, maxConnections: 200, maxConnectionsPerTorrent: 100, maxUploads: -1, maxUploadsPerTorrent: -1,
      queueingEnabled: true, maxActiveDownloads: 3, maxActiveUploads: 3, maxActiveTorrents: 5,
      dht: true, pex: false, lsd: true, encryption: 'require', anonymousMode: false,
      listenPort: 51413, randomPort: false, addTrackersEnabled: true, addTrackers: 'udp://tracker.example.test:1337/announce',
    });
    for (const leak of ['hunter2', 'rm -rf', '/downloads', 'admin']) expect(r.body).not.toContain(leak);
  });

  it('GET maps -1 limits to 0 and falls back for a missing random_port', async () => {
    const p = { ...prefs(), dl_limit: -1, encryption: 2, listen_port: 0 };
    delete p.random_port;
    const env = setup(undefined, fakeEngine({ getPreferences: async () => p }).engine);
    expect((await env.call(root, 'GET', URL)).json()).toMatchObject({ downloadLimitKBps: 0, encryption: 'disable', randomPort: true, listenPort: 0 });
  });

  it('PUT sends only mapped whitelisted keys with converted units and returns fresh settings', async () => {
    const f = fakeEngine();
    const env = setup(undefined, f.engine);
    const r = await env.call(root, 'PUT', URL, {
      downloadLimitKBps: 2048, uploadLimitKBps: 0, encryption: 'disable', dht: false, listenPort: 6881, maxUploads: -1,
      addTrackers: ' udp://a.example.test:80/announce \r\n\r\nhttps://b.example.test/announce\n',
    });
    expect(r.statusCode).toBe(200);
    expect(f.sets).toEqual([{
      dl_limit: 2048 * 1024, up_limit: 0, encryption: 2, dht: false, listen_port: 6881, max_uploads: -1,
      add_trackers: 'udp://a.example.test:80/announce\nhttps://b.example.test/announce',
    }]);
    expect(r.json().downloadLimitKBps).toBe(5120); // re-read from the engine
  });

  it('GET reads random_port (older builds) or listen_port 0 (5.3) as random, and a real listen_port as fixed', async () => {
    const get = async (p: Record<string, unknown>) => (await setup(undefined, fakeEngine({ getPreferences: async () => p }).engine).call(root, 'GET', URL)).json();
    const noRandom = (o: Record<string, unknown>) => { const p = { ...prefs(), ...o }; delete p.random_port; return p; };
    expect(await get(noRandom({ listen_port: 0 }))).toMatchObject({ randomPort: true, listenPort: 0 });
    expect(await get(noRandom({ listen_port: 6881 }))).toMatchObject({ randomPort: false, listenPort: 6881 });
    expect(await get({ ...prefs(), random_port: true, listen_port: 40000 })).toMatchObject({ randomPort: true });
    expect(await get({ ...prefs(), random_port: false, listen_port: 6881 })).toMatchObject({ randomPort: false, listenPort: 6881 });
  });

  it('PUT randomPort true sends listen_port 0 plus random_port; false sends the explicit port and requires it', async () => {
    const f = fakeEngine();
    const env = setup(undefined, f.engine);
    expect((await env.call(root, 'PUT', URL, { randomPort: true, listenPort: 7000 })).statusCode).toBe(200);
    expect(f.sets[0]).toEqual({ random_port: true, listen_port: 0 });
    expect((await env.call(root, 'PUT', URL, { randomPort: true })).statusCode).toBe(200);
    expect(f.sets[1]).toEqual({ random_port: true, listen_port: 0 });
    expect((await env.call(root, 'PUT', URL, { randomPort: false, listenPort: 6881 })).statusCode).toBe(200);
    expect(f.sets[2]).toEqual({ random_port: false, listen_port: 6881 });
    const bad = await env.call(root, 'PUT', URL, { randomPort: false });
    expect(bad.statusCode).toBe(400);
    expect(f.sets).toHaveLength(3);
  });

  it('PUT with an empty body does not call setPreferences', async () => {
    const f = fakeEngine();
    const env = setup(undefined, f.engine);
    expect((await env.call(root, 'PUT', URL, {})).statusCode).toBe(200);
    expect(f.sets).toEqual([]);
  });

  it.each([
    ['autorun_program', { autorun_program: 'rm -rf /' }],
    ['web_ui_password', { web_ui_password: 'x' }],
    ['save_path', { save_path: '/etc' }],
    ['mixed known+unknown', { dht: true, autorun_enabled: true }],
    ['qbt key instead of friendly name', { dl_limit: 1 }],
    ['negative speed', { downloadLimitKBps: -5 }],
    ['absurd speed', { uploadLimitKBps: 99_999_999 }],
    ['fraction', { maxConnections: 1.5 }],
    ['connections too low', { maxConnections: -2 }],
    ['port too low', { listenPort: 80 }],
    ['port too high', { listenPort: 70000 }],
    ['bad encryption', { encryption: 'maybe' }],
    ['wrong type', { dht: 'yes' }],
  ])('PUT rejects %s without calling the engine', async (_n, body) => {
    const f = fakeEngine();
    const env = setup(undefined, f.engine);
    const r = await env.call(root, 'PUT', URL, body);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation');
    expect(f.sets).toEqual([]);
    expect(f.gets()).toBe(0);
  });

  describe('addTrackers validation', () => {
    const put = (addTrackers: string) => {
      const f = fakeEngine();
      const env = setup(undefined, f.engine);
      return env.call(root, 'PUT', URL, { addTrackers }).then((r) => ({ r, f }));
    };
    it('accepts http, https, udp, ws, wss and blank', async () => {
      const list = ['http://a.test/a', 'https://a.test/a', 'udp://a.test:1/a', 'ws://a.test/a', 'wss://a.test/a'].join('\n');
      const { r, f } = await put(list);
      expect(r.statusCode).toBe(200);
      expect(f.sets[0]).toEqual({ add_trackers: list });
      expect((await put('')).r.statusCode).toBe(200);
    });
    it.each([['ftp://a.test/x'], ['javascript:alert(1)'], ['not a url'], ['http://'], ['udp://ok.test:1/a\nfile:///etc/passwd']])('rejects %s', async (v) => {
      const { r, f } = await put(v);
      expect(r.statusCode).toBe(400);
      expect(f.sets).toEqual([]);
    });
    it('rejects more than 50 lines and more than 4 KB', async () => {
      const many = Array.from({ length: 51 }, (_, i) => `udp://t${i}.test:1/a`).join('\n');
      expect((await put(many)).r.statusCode).toBe(400);
      expect((await put(`https://a.test/${'x'.repeat(4100)}`)).r.statusCode).toBe(400);
      const fifty = Array.from({ length: 50 }, (_, i) => `udp://t${i}.test:1/a`).join('\n');
      expect((await put(fifty)).r.statusCode).toBe(200);
    });
  });

  it('engine down: GET and PUT give 502 engine_unavailable without leaking upstream detail', async () => {
    const boom = async () => { throw new Error('connect ECONNREFUSED 10.9.8.7:8080 secret-upstream-body'); };
    const env = setup(undefined, fakeEngine({ getPreferences: boom, setPreferences: boom }).engine);
    for (const r of [await env.call(root, 'GET', URL), await env.call(root, 'PUT', URL, { dht: true })]) {
      expect(r.statusCode).toBe(502);
      expect(r.json().error.code).toBe('engine_unavailable');
      expect(r.body).not.toMatch(/ECONNREFUSED|10\.9\.8\.7|secret-upstream/);
    }
  });

  it('502 when the engine returns an unusable preferences payload', async () => {
    const env = setup(undefined, fakeEngine({ getPreferences: async () => ({ dht: true }) }).engine);
    expect((await env.call(root, 'GET', URL)).statusCode).toBe(502);
  });

  it('default client talks to qBittorrent over the injectable fetch (form field json=)', async () => {
    const seen: { url: string; body?: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      seen.push({ url, body: init.body as string | undefined });
      return url.endsWith('/app/preferences') ? Response.json(prefs()) : new Response('');
    }) as unknown as typeof fetch;
    const { buildApp } = await import('./app.js');
    const base = setup();
    const app = buildApp({ db: base.db, config: base.config, vpn: base.vpn, fetchImpl });
    const r = await app.inject({ method: 'PUT', url: URL, payload: { downloadLimitKBps: 1 }, headers: { 'x-gateway-secret': 'test-gateway-secret', 'x-requested-with': 'seedbox', 'remote-user': 'root', 'remote-groups': 'admins' } });
    expect(r.statusCode).toBe(200);
    expect(seen[0]!.url).toMatch(/\/api\/v2\/app\/setPreferences$/);
    expect(new URLSearchParams(seen[0]!.body).get('json')).toBe('{"dl_limit":1024}');
  });
});
