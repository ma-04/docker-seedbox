import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { Download, IndexerInfo, SearchBackend, SearchHit, SearchQuery } from '../lib/search/backend.js';
import { SearchError } from '../lib/search/backend.js';
import { JackettBackend } from '../lib/search/jackett.js';
import { KEY } from '../lib/search/fixtures.js';
import { sealToken } from '../lib/search/token.js';
import { alice, bob, fakeVpn, GW, makeLocalDest, root, setup, torrentFile } from './testutil.js';

const H1 = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';
const H2 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

class FakeBackend implements SearchBackend {
  readonly kind = 'jackett' as const;
  readonly uiPath = '/jackett/';
  queries: SearchQuery[] = [];
  downloads: string[] = [];
  hits: SearchHit[] = [];
  dl: (ref: string) => Promise<Download> = async () => ({ kind: 'torrent', data: torrentFile('from-jackett.bin', 5000) });
  indexerList: IndexerInfo[] | Error = [{ id: 'sbmock', name: 'SeedboxE2E' }];
  gate: Promise<void> | null = null;
  async search(q: SearchQuery): Promise<SearchHit[]> { this.queries.push(q); if (this.gate) await this.gate; return this.hits; }
  async indexers(): Promise<IndexerInfo[]> { if (this.indexerList instanceof Error) throw this.indexerList; return this.indexerList; }
  async download(ref: string): Promise<Download> { this.downloads.push(ref); return this.dl(ref); }
}
const hit = (o: Partial<SearchHit>): SearchHit => ({
  title: 'T', size: 1, seeders: 1, leechers: 0, indexerId: 'sbmock', indexerName: 'SeedboxE2E', categories: [2000], publishedAt: 1, magnet: null, link: '/jackett/dl/sbmock/?path=X', ...o,
});
const magnet = (h: string, dn = 'Found') => `magnet:?xt=urn:btih:${h}&dn=${dn}&tr=udp%3A%2F%2Ftracker.example.org%3A1337`;

function env(b: FakeBackend | null = new FakeBackend(), vpn = fakeVpn()) {
  return { ...setup(vpn, undefined, { searchBackend: b }), b: b! };
}

describe('search switched off', () => {
  it('every search route answers 404 search_disabled and /me says so', async () => {
    const e = env(null);
    expect((await e.call(alice, 'GET', '/api/me')).json().searchEnabled).toBe(false);
    for (const [m, u] of [['GET', '/api/search?q=abc'], ['GET', '/api/search/meta'], ['POST', '/api/search/add'], ['GET', '/jackett/'], ['GET', '/jackett/UI/Dashboard']] as const) {
      const r = await e.call(u.startsWith('/jackett') || m === 'POST' ? root : alice, m, u, m === 'POST' ? { token: 'x', destinationId: 1 } : undefined);
      expect(r.statusCode, u).toBe(404);
      expect(r.json().error.code, u).toBe('search_disabled');
    }
    const a = (await e.call(root, 'GET', '/api/admin/search')).json();
    expect(a).toMatchObject({ enabled: false, backend: null, uiPath: null, flaresolverr: 'disabled' });
  });
});

describe('GET /api/search', () => {
  it('validates the query (length cap, category, indexer)', async () => {
    const e = env();
    expect((await e.call(alice, 'GET', '/api/me')).json().searchEnabled).toBe(true);
    for (const q of ['q=a', `q=${'x'.repeat(201)}`, 'q=abc&cat=nope', 'q=abc&indexer=bad%20id', 'q=abc&extra=1', 'q=abc&cat=xxx']) {
      const r = await e.call(alice, 'GET', `/api/search?${q}`);
      expect(r.statusCode, q).toBe(400);
    }
    expect(e.b.queries).toHaveLength(0);
  });

  it('maps categories, drops disabled ones (XXX by default, also from All), sorts by seeders, issues opaque tokens', async () => {
    const e = env();
    e.b.hits = [
      hit({ title: 'Low', seeders: 1, categories: [2000, 100001] }),
      hit({ title: 'Adult', seeders: 99, categories: [6000, 100003] }),
      hit({ title: 'High', seeders: 50, categories: [5000, 5070], magnet: magnet(H1), link: null }),
    ];
    const r = await e.call(alice, 'GET', '/api/search?q=%20some%20%20thing%20&indexer=sbmock');
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.results.map((x: { title: string; category: string }) => `${x.title}:${x.category}`)).toEqual(['High:anime', 'Low:movies']);
    expect(e.b.queries[0]).toEqual({ q: 'some thing', cats: [2000, 5000, 3000, 3030, 7000, 4000, 1000, 4050, 5070, 8000], indexer: 'sbmock' });
    const text = r.body;
    expect(text).not.toContain('/jackett/dl');
    expect(text).not.toContain('magnet:');
    expect(text).not.toContain(KEY);
    // the same query again is served from the cache, the tokens are fresh
    const again = await e.call(alice, 'GET', '/api/search?q=some%20THING&indexer=sbmock');
    expect(again.json().cached).toBe(true);
    expect(e.b.queries).toHaveLength(1);
  });

  it('a category the admin switched off cannot be searched; switching XXX on makes it searchable', async () => {
    const e = env();
    expect((await e.call(alice, 'GET', '/api/search?q=abc&cat=xxx')).statusCode).toBe(400);
    expect((await e.call(alice, 'PUT', '/api/admin/search', { disabledCategories: [] })).statusCode).toBe(403);
    expect((await e.call(root, 'PUT', '/api/admin/search', { disabledCategories: ['movies'] })).statusCode).toBe(200);
    expect((await e.call(alice, 'GET', '/api/search?q=abc&cat=xxx')).statusCode).toBe(200);
    expect(e.b.queries.at(-1)!.cats).toEqual([6000]);
    expect((await e.call(alice, 'GET', '/api/search?q=abc&cat=movies')).statusCode).toBe(400);
    const meta = (await e.call(alice, 'GET', '/api/search/meta')).json();
    expect(meta.categories.map((c: { id: string }) => c.id)).not.toContain('movies');
    expect(meta.categories.map((c: { id: string }) => c.id)).toContain('xxx');
    expect(meta.indexers).toEqual([{ id: 'sbmock', name: 'SeedboxE2E' }]);
    for (const bad of [{ disabledCategories: ['nope'] }, { disabledCategories: ['tv', 'tv'] }, { other: 1 }]) {
      expect((await e.call(root, 'PUT', '/api/admin/search', bad)).statusCode).toBe(400);
    }
  });

  it('backend failures become 502 with fixed texts; busy users get 429', async () => {
    const e = env();
    e.b.search = async () => { throw new SearchError('unavailable', 'The search backend is unreachable'); };
    const r = await e.call(alice, 'GET', '/api/search?q=abc');
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toEqual({ code: 'search_unavailable', message: 'The search backend is unreachable' });

    const e2 = env();
    let open!: () => void;
    e2.b.gate = new Promise((r2) => { open = r2; });
    const p1 = e2.call(alice, 'GET', '/api/search?q=one');
    const p2 = e2.call(alice, 'GET', '/api/search?q=two');
    await new Promise((r2) => setTimeout(r2, 20));
    const third = await e2.call(alice, 'GET', '/api/search?q=three');
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('search_busy');
    const p4 = e2.call(bob, 'GET', '/api/search?q=four'); // bob is not blocked by alice's limit
    await new Promise((r2) => setTimeout(r2, 20));
    expect(e2.b.queries.map((q) => q.q)).toEqual(['one', 'two', 'four']);
    open();
    expect((await p1).statusCode).toBe(200);
    expect((await p4).statusCode).toBe(200);
    expect((await p2).statusCode).toBe(200);
  });

  it('is rate limited per user (20/min)', async () => {
    const e = env();
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await e.call(alice, 'GET', `/api/search?q=query${i}`)).statusCode;
    expect(last).toBe(429);
    expect((await e.call(bob, 'GET', '/api/search?q=query')).statusCode).toBe(200);
  });
});

describe('POST /api/search/add', () => {
  async function tokens(e: ReturnType<typeof env>) {
    const r = await e.call(alice, 'GET', '/api/search?q=abc');
    return r.json().results as { title: string; token: string }[];
  }

  it('a magnet result goes through the normal magnet path (canonicalised, deduplicated)', async () => {
    const e = env();
    const dest = await makeLocalDest(e);
    e.b.hits = [hit({ title: 'M', magnet: `${magnet(H1)}&ws=http%3A%2F%2Fevil%2Fx&x.pe=10.0.0.1:1`, link: null })];
    const [t] = await tokens(e);
    const r = await e.call(alice, 'POST', '/api/search/add', { token: t!.token, destinationId: dest });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ infohash: H1, state: 'queued', name: 'Found' });
    expect(e.b.downloads).toHaveLength(0);
    const row = e.db.prepare('SELECT source_enc FROM torrents WHERE infohash = ?').get(H1) as { source_enc: string };
    const { decryptJson } = await import('../lib/crypto.js');
    expect(decryptJson<{ magnet: string }>(e.config.appSecret, row.source_enc).magnet).not.toMatch(/ws=|x\.pe/);
    // adding again returns the same job
    expect((await e.call(alice, 'POST', '/api/search/add', { token: t!.token, destinationId: dest })).statusCode).toBe(200);
  });

  it('a .torrent result is fetched through the backend and strictly validated', async () => {
    const e = env();
    const dest = await makeLocalDest(e);
    e.b.hits = [hit({ title: 'T', link: '/jackett/dl/sbmock/?path=AAA' })];
    const [t] = await tokens(e);
    const r = await e.call(alice, 'POST', '/api/search/add', { token: t!.token, destinationId: dest });
    expect(r.statusCode).toBe(201);
    expect(r.json().name).toBe('from-jackett.bin');
    expect(e.b.downloads).toEqual(['/jackett/dl/sbmock/?path=AAA']);

    // A torrent with a duplicate info key (the parser-differential attack) is refused like an upload would be.
    e.b.dl = async () => ({ kind: 'torrent', data: Buffer.concat([Buffer.from('d4:infod6:lengthi1e4:name1:a12:piece lengthi16384e6:pieces20:'), Buffer.alloc(20), Buffer.from('e4:infod6:lengthi2eee')]) });
    const bad = await e.call(alice, 'POST', '/api/search/add', { token: t!.token, destinationId: dest });
    expect(bad.statusCode).toBe(400);
  });

  it('a .torrent link that redirects to a magnet is added as that (sanitised) magnet', async () => {
    const e = env();
    const dest = await makeLocalDest(e);
    e.b.hits = [hit({ title: 'R' })];
    e.b.dl = async () => ({ kind: 'magnet', magnet: magnet(H2, 'Redirected') });
    const [t] = await tokens(e);
    const r = await e.call(alice, 'POST', '/api/search/add', { token: t!.token, destinationId: dest });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ infohash: H2, name: 'Redirected' });
    // a hostile magnet from the redirect is refused by the same policy as a typed one
    e.b.dl = async () => ({ kind: 'magnet', magnet: `magnet:?xt=urn:btih:${H1}&xt=urn:btih:${H2}` });
    expect((await e.call(alice, 'POST', '/api/search/add', { token: t!.token, destinationId: dest })).statusCode).toBe(400);
  });

  it('refused links and backend failures are reported without upstream detail', async () => {
    const e = env();
    const dest = await makeLocalDest(e);
    e.b.hits = [hit({})];
    e.b.dl = async () => { throw new SearchError('link_refused', 'The indexer link points outside Jackett; it is not fetched from outside the VPN'); };
    const [t] = await tokens(e);
    const r = await e.call(alice, 'POST', '/api/search/add', { token: t!.token, destinationId: dest });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('search_link_refused');
  });

  it('tokens are bound to the user, expire, cannot be forged; limits and destination access still apply', async () => {
    const e = env();
    const dest = await makeLocalDest(e);
    e.b.hits = [hit({ magnet: magnet(H1), link: null })];
    const [t] = await tokens(e);
    const stolen = await e.call(bob, 'POST', '/api/search/add', { token: t!.token, destinationId: dest });
    expect(stolen.statusCode).toBe(400);
    expect(stolen.json().error.code).toBe('search_token');
    const aliceId = (e.db.prepare("SELECT id FROM users WHERE username = 'alice'").get() as { id: number }).id;
    const expired = sealToken(e.config.appSecret, { u: aliceId, e: 1, m: magnet(H1) });
    expect((await e.call(alice, 'POST', '/api/search/add', { token: expired, destinationId: dest })).statusCode).toBe(410);
    const forged = sealToken('another-secret-of-at-least-32-characters!', { u: aliceId, e: 2_000_000_000, m: magnet(H1) });
    expect((await e.call(alice, 'POST', '/api/search/add', { token: forged, destinationId: dest })).statusCode).toBe(400);
    // bob's own S3 destination is not alice's to use
    const own = await e.call(bob, 'POST', '/api/destinations', { name: 'b', type: 's3', config: { endpoint: 'https://s3.example.test', region: 'r', accessKeyId: 'a', secretAccessKey: 's', bucket: 'b' } });
    expect((await e.call(alice, 'POST', '/api/search/add', { token: t!.token, destinationId: own.json().id })).statusCode).toBe(404);
    // size limit (a new query: the earlier one is cached)
    e.db.prepare("INSERT INTO settings (key, value_json) VALUES ('limits.maxTorrentBytes', '100')").run();
    e.b.hits = [hit({ link: '/jackett/dl/sbmock/?path=big' })];
    const big = (await e.call(alice, 'GET', '/api/search?q=bigone')).json().results[0];
    expect((await e.call(alice, 'POST', '/api/search/add', { token: big.token, destinationId: dest })).statusCode).toBe(413);
    // CSRF header is required like on every other mutation
    expect((await e.call(alice, 'POST', '/api/search/add', { token: t!.token, destinationId: dest }, { headers: { 'x-requested-with': '' } })).statusCode).toBe(403);
  });
});

describe('GET /api/admin/search (status card)', () => {
  it('reports reachability, indexer count and FlareSolverr through the sidecar probe', async () => {
    const b = new FakeBackend();
    const vpn = fakeVpn({ companions: async () => ({ flaresolverr: true }) });
    const e = setup(vpn, undefined, { searchBackend: b });
    (e.config as { search: unknown }).search = { backend: 'jackett', jackettUrl: 'http://vpn:9117', jackettApiKey: KEY, flaresolverr: true };
    expect((await e.call(alice, 'GET', '/api/admin/search')).statusCode).toBe(403);
    const ok = (await e.call(root, 'GET', '/api/admin/search')).json();
    expect(ok).toMatchObject({ enabled: true, backend: 'jackett', uiPath: '/jackett/', reachable: true, indexerCount: 1, error: null, flaresolverr: 'ok' });
    expect(ok.categories.find((c: { id: string }) => c.id === 'xxx').enabled).toBe(false);
    b.indexerList = new SearchError('rejected', 'The search backend refused the request (Torznab error 100)');
    vpn.companions = async () => ({ flaresolverr: false });
    const bad = (await e.call(root, 'GET', '/api/admin/search')).json();
    expect(bad).toMatchObject({ reachable: false, indexerCount: null, error: 'The search backend refused the request (Torznab error 100)', flaresolverr: 'unreachable' });
    // the meta endpoint keeps the last good list, and degrades instead of failing when there is none
    expect((await e.call(alice, 'GET', '/api/search/meta')).json()).toMatchObject({ indexersOk: true });
    const b2 = new FakeBackend();
    b2.indexerList = new SearchError('unavailable', 'The search backend is unreachable');
    const e2 = setup(fakeVpn(), undefined, { searchBackend: b2 });
    expect((await e2.call(alice, 'GET', '/api/search/meta')).json()).toMatchObject({ indexers: [], indexersOk: false });
  });
});

describe('Jackett UI passthrough (/jackett/*, admins only)', () => {
  function ui() {
    const calls: { url: string; init: RequestInit }[] = [];
    let next: () => Response = () => new Response('<html>dash</html>', { headers: { 'content-type': 'text/html' } });
    const fetchImpl = (async (u: string | URL | Request, init: RequestInit = {}) => { calls.push({ url: String(u), init }); return next(); }) as typeof fetch;
    const e = setup(fakeVpn(), undefined, { fetchImpl, searchBackend: new JackettBackend({ origin: 'http://vpn:9117', apiKey: KEY, fetchImpl }) });
    (e.config as { search: unknown }).search = { backend: 'jackett', jackettUrl: 'http://vpn:9117', jackettApiKey: KEY, flaresolverr: false };
    return { ...e, calls, respond: (f: () => Response) => { next = f; } };
  }

  it('is admin-only and forwards nothing that identifies the user or the gateway', async () => {
    const e = ui();
    expect((await e.call(alice, 'GET', '/jackett/UI/Dashboard')).statusCode).toBe(403);
    expect((await e.call(null, 'GET', '/jackett/UI/Dashboard')).statusCode).toBe(401);
    expect(e.calls).toHaveLength(0);
    const r = await e.call(root, 'GET', '/jackett/UI/Dashboard?x=1', undefined, {
      headers: { cookie: 'seedbox_session=SECRET; Jackett=abc; TestCookie=1; other=z', authorization: 'Basic eA==', 'remote-email': 'r@x', accept: 'text/html' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('<html>dash</html>');
    expect(e.calls[0]!.url).toBe('http://vpn:9117/jackett/UI/Dashboard?x=1');
    const sent = e.calls[0]!.init.headers as Record<string, string>;
    expect(sent.cookie).toBe('Jackett=abc; TestCookie=1');
    expect(Object.keys(sent).sort()).toEqual(['accept', 'accept-encoding', 'cookie', 'x-requested-with']);
    expect(JSON.stringify(sent)).not.toMatch(/SECRET|remote|gateway|Basic/i);
    expect(e.calls[0]!.init.redirect).toBe('manual');
  });

  it('rewrites Jackett redirects to this host and passes only Jackett cookies back', async () => {
    const e = ui();
    e.respond(() => {
      const h = new Headers({ location: 'http://vpn:9117/jackett/UI/Login?ReturnUrl=%2Fjackett%2FUI%2FDashboard' });
      h.append('set-cookie', 'Jackett=new; path=/jackett; samesite=lax; httponly');
      h.append('set-cookie', 'seedbox_session=evil; path=/');
      return new Response(null, { status: 302, headers: h });
    });
    const r = await e.call(root, 'GET', '/jackett/UI/Dashboard');
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/jackett/UI/Login?ReturnUrl=%2Fjackett%2FUI%2FDashboard');
    expect(r.headers['set-cookie']).toEqual(['Jackett=new; path=/jackett; samesite=lax; httponly']);
    e.respond(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }));
    expect((await e.call(root, 'GET', '/jackett/x')).headers.location).toBe('/jackett/');
    e.respond(() => new Response(null, { status: 302, headers: { location: 'Dashboard' } }));
    expect((await e.call(root, 'GET', '/jackett/UI/Login')).headers.location).toBe('/jackett/UI/Dashboard');
  });

  it('writes must be same-origin and carry the raw body (capped)', async () => {
    const e = ui();
    e.respond(() => new Response(null, { status: 204 }));
    const body = JSON.stringify([{ id: 'sitelink', value: 'http://203.0.113.40:8080/' }]);
    const json = { 'content-type': 'application/json' };
    expect((await e.call(root, 'POST', '/jackett/api/v2.0/indexers/sbmock/config', body, { headers: json })).statusCode).toBe(403); // no Origin
    expect((await e.call(root, 'POST', '/jackett/api/v2.0/indexers/sbmock/config', body, { headers: { ...json, origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await e.call(root, 'POST', '/jackett/api/v2.0/indexers/sbmock/config', body, { headers: { ...json, 'sec-fetch-site': 'cross-site', origin: 'https://app.example.test' } })).statusCode).toBe(403);
    expect(e.calls).toHaveLength(0);
    const ok = await e.call(root, 'POST', '/jackett/api/v2.0/indexers/sbmock/config', body, { headers: { ...json, origin: 'https://app.example.test', 'sec-fetch-site': 'same-origin' } });
    expect(ok.statusCode).toBe(204);
    expect(Buffer.from(e.calls[0]!.init.body as Uint8Array).toString()).toBe(body);
    expect((e.calls[0]!.init.headers as Record<string, string>)['content-type']).toBe('application/json');
    const huge = await e.call(root, 'POST', '/jackett/x', 'x'.repeat(1024 * 1024 + 10), { headers: { 'content-type': 'text/plain', origin: 'https://app.example.test' } });
    expect(huge.statusCode).toBe(413);
  });

  it('Jackett down = 502 without detail; encoded path tricks are refused before any request', async () => {
    const e = ui();
    e.respond(() => { throw new TypeError('connect ECONNREFUSED vpn:9117'); });
    const r = await e.call(root, 'GET', '/jackett/UI/Dashboard');
    expect(r.statusCode).toBe(502);
    expect(r.body).not.toContain('ECONNREFUSED');
    // Sent verbatim over a socket (inject() would normalise them first): the root guard refuses them before routing.
    await e.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (e.app.server.address() as AddressInfo).port;
    for (const p of ['/jackett/%2e%2e/api/admin/users', '/jackett/..%2fapi', '/jackett//x', '/jackett/./x']) {
      const status = await new Promise<number>((resolve, reject) => {
        const r2 = request({ host: '127.0.0.1', port, path: p, headers: { 'x-gateway-secret': GW, 'remote-user': 'root', 'remote-groups': 'admins' } }, (res) => { res.resume(); resolve(res.statusCode!); });
        r2.on('error', reject);
        r2.end();
      });
      expect(status, p).toBe(400);
    }
    expect(e.calls).toHaveLength(1);
    expect((await e.app.inject({ method: 'GET', url: '/jackett/x', headers: { 'remote-user': 'root', 'remote-groups': 'admins' } })).statusCode).toBe(401); // no gateway secret
    await e.app.close();
  });
});
