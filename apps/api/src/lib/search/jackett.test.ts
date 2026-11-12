import { describe, expect, it } from 'vitest';
import { SearchError } from './backend.js';
import { dlLink, INDEXERS_XML, KEY, magnetOf, ORIGIN, torznabXml } from './fixtures.js';
import { JackettBackend, MAX_TORRENT_BYTES } from './jackett.js';

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
function fake(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.href, init });
    return handler(url, init);
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const privateLookup = async () => [{ address: '10.0.0.5', family: 4 }];
const xmlRes = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/rss+xml' } });
const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });
const backend = (h: Handler, lookup = publicLookup) => { const f = fake(h); return { b: new JackettBackend({ origin: ORIGIN, apiKey: KEY, fetchImpl: f.fetchImpl, lookup }), calls: f.calls }; };
const errOf = async (p: Promise<unknown>): Promise<SearchError> => { try { await p; } catch (e) { return e as SearchError; } throw new Error('expected a rejection'); };

describe('JackettBackend.search', () => {
  it('asks Jackett with the API key, categories and indexer; links come back without the key', async () => {
    const { b, calls } = backend(() => xmlRes(torznabXml([
      { title: 'With magnet', cats: [5000], magnet: magnetOf(), link: dlLink('AAA') },
      { title: 'Torrent only', cats: [2000], link: dlLink('BBB') },
      { title: 'Foreign link', cats: [2000], link: 'https://evil.example/x.torrent' },
      { title: 'Other origin', cats: [2000], link: dlLink('CCC', 'http://vpn:9118') },
      { title: 'Magnet as link', cats: [2000], link: magnetOf('a'.repeat(40), 'm') },
    ])));
    const hits = await b.search({ q: 'e2e search', cats: [2000, 5000], indexer: 'sbmock' });
    const u = new URL(calls[0]!.url);
    expect(u.origin + u.pathname).toBe('http://vpn:9117/jackett/api/v2.0/indexers/sbmock/results/torznab/api');
    expect(Object.fromEntries(u.searchParams)).toEqual({ apikey: KEY, t: 'search', q: 'e2e search', cat: '2000,5000', limit: '100' });
    expect(hits.map((h) => h.title)).toEqual(['With magnet', 'Torrent only', 'Magnet as link']);
    expect(hits[1]!.link).toBe('/jackett/dl/sbmock/?path=BBB&file=Some+File');
    expect(hits[2]!.magnet).toMatch(/^magnet:/);
    for (const h of hits) expect(JSON.stringify(h)).not.toContain(KEY);
  });

  it('defaults to the aggregate "all" indexer', async () => {
    const { b, calls } = backend(() => xmlRes(torznabXml([])));
    await b.search({ q: 'x', cats: [2000], indexer: null });
    expect(new URL(calls[0]!.url).pathname).toBe('/jackett/api/v2.0/indexers/all/results/torznab/api');
  });

  it('errors are fixed texts: no URL, no API key, no upstream body', async () => {
    const cases: [Handler, string][] = [
      [() => { throw new TypeError(`fetch failed for http://vpn:9117/?apikey=${KEY}`); }, 'unavailable'],
      [() => xmlRes('<error code="100" description="Invalid API Key"/>', 400), 'rejected'],
      [() => xmlRes(`boom ${KEY}`, 500), 'unavailable'],
      [() => xmlRes('<html>login</html>', 200), 'bad_response'],
      [() => new Response(Buffer.from([0xff, 0xfe, 0x00])), 'bad_response'],
      [() => new Response('x', { headers: { 'content-length': String(6 * 1024 * 1024) } }), 'bad_response'],
    ];
    for (const [h, code] of cases) {
      const e = await errOf(backend(h).b.search({ q: 'x', cats: [2000], indexer: null }));
      expect(e).toBeInstanceOf(SearchError);
      expect(e.code).toBe(code);
      expect(e.message).not.toContain(KEY);
      expect(e.message).not.toContain('vpn:9117');
    }
  });

  it('enforces the size cap while streaming (no content-length)', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream({ start(c) { for (let i = 0; i < 7; i++) c.enqueue(chunk); c.close(); } });
    const e = await errOf(backend(() => new Response(stream)).b.search({ q: 'x', cats: [2000], indexer: null }));
    expect(e.code).toBe('bad_response');
  });

  it('times out', async () => {
    const f = fake((_u, init) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('t'), { name: 'TimeoutError' })))));
    const b = new JackettBackend({ origin: ORIGIN, apiKey: KEY, fetchImpl: f.fetchImpl, timeoutMs: 50 });
    expect((await errOf(b.search({ q: 'x', cats: [2000], indexer: null }))).message).toMatch(/in time/);
  });

  it('lists configured indexers', async () => {
    const { b, calls } = backend(() => xmlRes(INDEXERS_XML));
    expect((await b.indexers()).map((i) => i.id)).toEqual(['sbmock', 'other-one']);
    expect(Object.fromEntries(new URL(calls[0]!.url).searchParams)).toMatchObject({ t: 'indexers', configured: 'true', apikey: KEY });
  });
});

describe('the SSRF exemption covers exactly Jackett /dl/ on the configured origin', () => {
  const { b } = backend(() => xmlRes(''));
  it.each([
    ['http://vpn:9117/jackett/dl/x/?path=1', true],
    ['http://VPN:9117/jackett/dl/x/?path=1', true], // the URL parser lower-cases hosts
    ['http://vpn:9118/jackett/dl/x/?path=1', false],
    ['https://vpn:9117/jackett/dl/x/?path=1', false],
    ['http://vpn/jackett/dl/x/', false],
    ['http://vpn:9117/jackett/api/v2.0/server/config', false],
    ['http://vpn:9117/jackett/dl', false],
    ['http://vpn:9117/other/jackett/dl/x', false],
    ['http://user:pw@vpn:9117/jackett/dl/x/', false],
    ['http://vpn.evil.example:9117/jackett/dl/x/', false],
    ['http://10.0.0.5:9117/jackett/dl/x/', false],
    ['http://169.254.169.254/jackett/dl/x/', false],
    ['file:///jackett/dl/x', false],
  ])('%s -> %s', (raw, ok) => {
    expect(b.isDlUrl(new URL(raw))).toBe(ok);
    expect(b.toRef(raw) !== null).toBe(ok);
  });
  it('download() refuses references that are not Jackett /dl/ paths, without any request', async () => {
    const { b: b2, calls } = backend(() => new Response('x'));
    for (const ref of ['/jackett/api/v2.0/server/config', 'http://evil.example/x', '//evil.example/jackett/dl/x', '/jackett/dl/../api/v2.0/x']) {
      expect((await errOf(b2.download(ref))).code).toBe('link_refused');
    }
    expect(calls).toHaveLength(0);
  });
});

describe('JackettBackend.download', () => {
  const ref = '/jackett/dl/sbmock/?path=AAA&file=X';

  it('fetches the .torrent from Jackett with the key added back, redirects handled by hand', async () => {
    const { b, calls } = backend(() => new Response(Buffer.from('d4:infod4:name1:aee'), { headers: { 'content-type': 'application/x-bittorrent' } }));
    const d = await b.download(ref);
    expect(d).toEqual({ kind: 'torrent', data: Buffer.from('d4:infod4:name1:aee') });
    expect(new URL(calls[0]!.url).searchParams.get('jackett_apikey')).toBe(KEY);
    expect(calls[0]!.init.redirect).toBe('manual');
  });

  it('a redirect to a magnet is returned as a magnet (the caller validates it like user input)', async () => {
    const m = 'magnet:?xt=urn:btih:5692f09fa9723a2777e5af44f94219dc456865ec&dn=multi';
    const { b } = backend(() => redirect(m));
    expect(await b.download(ref)).toEqual({ kind: 'magnet', magnet: m });
  });

  it('follows a redirect to another Jackett /dl/ URL (bounded)', async () => {
    let n = 0;
    const { b, calls } = backend(() => (n++ === 0 ? redirect('/jackett/dl/sbmock/?path=BBB') : new Response('d1:ai1ee')));
    expect((await b.download(ref)).kind).toBe('torrent');
    expect(new URL(calls[1]!.url).searchParams.get('path')).toBe('BBB');
    const loop = backend(() => redirect('/jackett/dl/sbmock/?path=loop'));
    expect((await errOf(loop.b.download(ref))).message).toMatch(/Too many redirects/);
    expect(loop.calls.length).toBeLessThanOrEqual(3);
  });

  it('a redirect to an external public URL is validated but NOT fetched (it would bypass the VPN)', async () => {
    const { b, calls } = backend(() => redirect('https://torrents.example.net/x.torrent'));
    const e = await errOf(b.download(ref));
    expect(e.code).toBe('link_refused');
    expect(e.message).toMatch(/not fetched from outside the VPN/);
    expect(calls).toHaveLength(1);
  });

  it('a redirect to a private / internal address is refused by the SSRF guard', async () => {
    for (const [loc, lookup] of [
      ['http://169.254.169.254/latest/meta-data', publicLookup], ['http://127.0.0.1:3000/api/admin/users', publicLookup],
      ['https://api:3000/x', publicLookup], ['https://rebind.example.net/x', privateLookup], ['http://vpn:8000/status', publicLookup],
    ] as const) {
      const { b, calls } = backend(() => redirect(loc), lookup);
      const e = await errOf(b.download(ref));
      expect(e.code, loc).toBe('link_refused');
      expect(e.message, loc).toMatch(/private or internal/);
      expect(calls, loc).toHaveLength(1);
    }
  });

  it('other schemes, missing locations and failures are refused with fixed texts', async () => {
    expect((await errOf(backend(() => redirect('file:///etc/passwd')).b.download(ref))).message).toMatch(/unsupported scheme/);
    expect((await errOf(backend(() => new Response(null, { status: 302 })).b.download(ref))).code).toBe('bad_response');
    const e = await errOf(backend(() => new Response(`no ${KEY}`, { status: 404 })).b.download(ref));
    expect(e.code).toBe('unavailable');
    expect(e.message).not.toContain(KEY);
  });

  it('caps the .torrent size', async () => {
    const big = new Uint8Array(MAX_TORRENT_BYTES + 1);
    expect((await errOf(backend(() => new Response(big)).b.download(ref))).code).toBe('bad_response');
  });
});
