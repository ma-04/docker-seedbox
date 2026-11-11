import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { assertPublicEndpoint } from './netguard.js';
import { fetchTrackerListBody, makeRequest, parseTrackerList, TrackerListError } from './trackerlist.js';

const lines = (...l: string[]) => l.join('\n');

describe('parseTrackerList', () => {
  it('ignores blank lines and # comments, handles CRLF and surrounding whitespace', () => {
    const p = parseTrackerList('# my list\r\n\r\n  udp://tracker.example.org:1337/announce  \r\n# more\r\nhttps://t2.example.org/announce\r\n', 100);
    expect(p.trackers).toEqual(['udp://tracker.example.org:1337/announce', 'https://t2.example.org/announce']);
    expect(p.invalid).toBe(0);
  });

  it('accepts comma and whitespace separated lists', () => {
    const p = parseTrackerList('udp://a.example.org:1/announce, udp://b.example.org:2/announce\thttp://c.example.org/announce', 100);
    expect(p.trackers).toHaveLength(3);
  });

  it('handles IDN hosts (punycoded, also for udp:) and IPv6 literals', () => {
    const p = parseTrackerList(lines('udp://tracker.bücher.example:1337/announce', 'https://bücher.example/announce', 'udp://[2606:4700:4700::1111]:6969/announce'), 100);
    expect(p.trackers).toEqual([
      'udp://tracker.xn--bcher-kva.example:1337/announce', 'https://xn--bcher-kva.example/announce', 'udp://[2606:4700:4700::1111]:6969/announce',
    ]);
  });

  it('drops private, loopback, link-local, single-label, credentialed and wrong-scheme entries with the user-tracker policy', () => {
    const filler = Array.from({ length: 50 }, (_, i) => `udp://f${i}.example.org:1/a`);
    const p = parseTrackerList(lines(
      'udp://ok.example.org:1/announce', ...filler,
      'udp://10.0.0.5:6969/announce', 'http://127.0.0.1:80/announce', 'udp://[::1]:1/a', 'udp://169.254.169.254/announce',
      'http://tracker/announce', 'http://nas.local/announce', 'http://u:p@t.example.org/a', 'ftp://t.example.org/a', 'udp://2130706433:1/a',
      'udp://[fd00::1]:1/a', 'udp://192.168.1.1:1/a',
    ), 100);
    expect(p.trackers).toHaveLength(51);
    expect(p.trackers[0]).toBe('udp://ok.example.org:1/announce');
    expect(p.invalid).toBe(11);
  });

  it('applies the policy to the normalised form: percent-encoded or full-width private hosts are dropped', () => {
    const filler = Array.from({ length: 50 }, (_, i) => `udp://f${i}.example.org:1/a`);
    const p = parseTrackerList(lines(
      ...filler,
      'udp://127.0.0.%31:6969/announce', 'udp://10.0.0.%31:1/a', 'udp://169.254.169.%32%35%34:80/a',
      'udp://%6c%6fcalhost.%6c%6fcal:1/a', 'udp://１２７.０.０.１:1/a',
    ), 100);
    expect(p.trackers).toEqual(filler);
    expect(p.invalid).toBe(5);
  });

  it('is only rejected as a whole above 20% invalid tokens', () => {
    const good = Array.from({ length: 8 }, (_, i) => `udp://t${i}.example.org:1/a`);
    expect(parseTrackerList(lines(...good, 'junk1', 'junk2'), 100).invalid).toBe(2); // exactly 20%
    expect(() => parseTrackerList(lines(...good, 'junk1', 'junk2', 'junk3'), 100)).toThrow(/Too many entries/);
  });

  it('dedupes on scheme+host case-insensitively and exactly on the rest, keeping order', () => {
    const p = parseTrackerList(lines('UDP://Tracker.Example.org:1337/announce', 'udp://tracker.example.org:1337/announce', 'udp://tracker.example.org:1337/Announce', 'http://tracker.example.org:1337/announce'), 100);
    expect(p.trackers).toEqual(['udp://tracker.example.org:1337/announce', 'udp://tracker.example.org:1337/Announce', 'http://tracker.example.org:1337/announce']);
    expect(p.duplicates).toBe(1);
  });

  it('caps at max in list order', () => {
    const p = parseTrackerList(Array.from({ length: 10 }, (_, i) => `udp://t${i}.example.org:1/a`).join('\n'), 3);
    expect(p.trackers.map((t) => /t(\d)/.exec(t)![1])).toEqual(['0', '1', '2']);
    expect(p.overCap).toBe(7);
  });

  it('drops entries longer than 512 characters', () => {
    const ok = Array.from({ length: 5 }, (_, i) => `udp://ok${i}.example.org:1/a`);
    const p = parseTrackerList(lines(...ok, `https://long.example.org/${'x'.repeat(520)}`), 100);
    expect(p.trackers).toHaveLength(5);
    expect(p.invalid).toBe(1);
  });

  it('rejects HTML, binary, invalid UTF-8, empty and all-invalid bodies', () => {
    expect(() => parseTrackerList('<!DOCTYPE html><html><body>nope</body></html>', 10)).toThrow(TrackerListError);
    expect(() => parseTrackerList('<HTML>\nudp://a.example.org:1/a', 10)).toThrow(/web page/);
    expect(() => parseTrackerList(Buffer.from([0x75, 0x64, 0x70, 0, 1, 2]), 10)).toThrow(/binary/);
    expect(() => parseTrackerList(Buffer.from([0xff, 0xfe, 0xfd]), 10)).toThrow(/UTF-8/);
    expect(() => parseTrackerList('# only comments\n\n', 10)).toThrow(/empty/);
    expect(() => parseTrackerList('udp://10.0.0.1:1/a', 10)).toThrow();
  });
});

describe('fetchTrackerListBody', () => {
  let server: Server | null = null;
  const stop = () => new Promise<void>((r) => { if (server) { server.closeAllConnections(); server.close(() => r()); server = null; } else r(); });
  afterEach(stop);

  async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
    await stop();
    server = createServer(handler);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }
  const pub = async () => [{ address: '93.184.216.34', family: 4 }];
  /** The local server is allowed; everything else is judged by the real guard. */
  const guard = (seen: string[] = []) => async (u: string) => {
    seen.push(u);
    const x = new URL(u);
    return x.hostname === '127.0.0.1' ? x : assertPublicEndpoint(u, { allowPrivate: false, lookup: pub });
  };
  const opts = (g = guard()) => ({ guard: g, request: makeRequest({ allowPrivate: true }) });

  it('downloads a list, sending only a plain User-Agent and no cookies or auth', async () => {
    let headers: Record<string, unknown> = {};
    const base = await serve((req, res) => { headers = req.headers; res.setHeader('content-type', 'text/plain'); res.end('udp://a.example.org:1/a\n'); });
    expect((await fetchTrackerListBody(`${base}/list.txt`, opts())).toString()).toBe('udp://a.example.org:1/a\n');
    expect(headers['user-agent']).toBe('docker-seedbox');
    expect(headers.cookie).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
  });

  it('follows redirects, re-vetting every hop, and stops after 3', async () => {
    const seen: string[] = [];
    const base = await serve((req, res) => {
      const n = Number(/\/r(\d+)/.exec(req.url!)?.[1] ?? 0);
      res.statusCode = 302; res.setHeader('location', `/r${n + 1}`); res.end();
    });
    await expect(fetchTrackerListBody(`${base}/start`, opts(guard(seen)))).rejects.toThrow(/Too many redirects/);
    expect(seen).toHaveLength(4); // first request + 3 hops, each vetted
    const ok = await serve((req, res) => { if (req.url === '/a') { res.statusCode = 301; res.setHeader('location', '/final'); res.end(); return; } res.end('done'); });
    expect((await fetchTrackerListBody(`${ok}/a`, opts())).toString()).toBe('done');
  });

  it('refuses a redirect to a private address, to http or to a single-label host, and never requests it', async () => {
    for (const target of ['https://10.0.0.5/list.txt', 'https://169.254.169.254/latest', 'http://example.org/list.txt', 'https://intranet/list.txt']) {
      let hits = 0;
      const base = await serve((_req, res) => { hits++; res.statusCode = 302; res.setHeader('location', target); res.end(); });
      await expect(fetchTrackerListBody(`${base}/x`, opts())).rejects.toThrow(/not publicly routable|must use https/);
      expect(hits).toBe(1);
    }
  });

  it('a hostname that resolves to a private address is refused by the default guard before any connection', async () => {
    await expect(fetchTrackerListBody('https://evil.example.org/list.txt', { lookup: async () => [{ address: '10.1.2.3', family: 4 }] })).rejects.toThrow(/not publicly routable/);
    await expect(fetchTrackerListBody('http://example.org/list.txt', { lookup: pub })).rejects.toThrow(/https/);
  });

  it('the default transport pins the connection to vetted addresses (a rebinding answer is refused at connect time)', async () => {
    const req = makeRequest({ resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
    await expect(fetchTrackerListBody('https://rebind.example.org/list.txt', { guard: async (u) => new URL(u), request: req })).rejects.toThrow(/not publicly routable/);
  });

  it('times out', async () => {
    const base = await serve(() => { /* never answers */ });
    await expect(fetchTrackerListBody(`${base}/x`, { ...opts(), timeoutMs: 100 })).rejects.toThrow(/timed out/);
  });

  it('the deadline also covers a DNS check that never answers', async () => {
    const t0 = Date.now();
    await expect(fetchTrackerListBody('https://slow-dns.example.org/list.txt', { guard: () => new Promise<URL>(() => {}), timeoutMs: 100 })).rejects.toThrow(/timed out/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('a body that stalls past the deadline is reported as a timeout', async () => {
    const base = await serve((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('udp://a.example.org:1/a\n'); /* never ends */ });
    await expect(fetchTrackerListBody(`${base}/x`, { ...opts(), timeoutMs: 200 })).rejects.toThrow(/timed out/);
  });

  it('aborts beyond the size cap (declared and streamed)', async () => {
    const big = await serve((_req, res) => { res.setHeader('content-length', '5000'); res.end('x'.repeat(5000)); });
    await expect(fetchTrackerListBody(`${big}/x`, { ...opts(), maxBytes: 1000 })).rejects.toThrow(/too large/);
    let sent = 0;
    const chunked = await serve((_req, res) => {
      const t = setInterval(() => { sent += 400; res.write('y'.repeat(400)); }, 5);
      res.on('close', () => clearInterval(t));
    });
    await expect(fetchTrackerListBody(`${chunked}/x`, { ...opts(), maxBytes: 1000 })).rejects.toThrow(/too large/);
    expect(sent).toBeLessThan(5000);
  });

  it('non-200 answers give a short message without the body', async () => {
    const nf = await serve((_req, res) => { res.statusCode = 404; res.end('secret body text'); });
    const e = await fetchTrackerListBody(`${nf}/x`, opts()).catch((x: Error) => x);
    expect((e as Error).message).toBe('The server answered HTTP 404');
  });
});
