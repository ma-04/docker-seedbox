import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { q } from '../src/drive';
import { contentDisposition, safeContentType } from '../src/disposition';
import { FOLDER, env, installFakes, signedReq, type DriveNode, type Mock } from './helpers';

const tree: DriveNode[] = [
  { id: 'u1', name: 'alice', mimeType: FOLDER, parent: 'ROOT' },
  { id: 't1', name: 'Big Buck Bunny', mimeType: FOLDER, parent: 'u1' },
  { id: 'f1', name: 'video.mp4', mimeType: 'video/mp4', parent: 't1', size: '11', md5Checksum: 'abc123', modifiedTime: '2025-01-02T03:04:05.000Z' },
  { id: 'd1', name: 'doc', mimeType: 'application/vnd.google-apps.document', parent: 't1' },
  { id: 'u2', name: 'bob', mimeType: FOLDER, parent: 'ROOT' },
  { id: 't2', name: 'ünï cødé #1 100%', mimeType: FOLDER, parent: 'u2' },
  { id: 'f2', name: "it's a file.txt", mimeType: 'text/plain', parent: 't2', size: '11' },
  { id: 'f3', name: 'back\\slash.txt', mimeType: 'text/plain', parent: 't2', size: '11' },
  { id: 'dup1', name: 'dup.txt', parent: 't1', modifiedTime: '2024-01-01T00:00:00Z' },
  { id: 'dup2', name: 'dup.txt', parent: 't1', modifiedTime: '2025-06-01T00:00:00Z' },
];
const P = '/alice/Big Buck Bunny/video.mp4';
let m: Mock;
const run = (r: Request, e = env) => worker.fetch(r, e);
const lists = () => m.calls.filter((c) => c.url.pathname === '/drive/v3/files' && !c.url.searchParams.has('alt'));

beforeEach(() => { m = installFakes([...tree]); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('verification', () => {
  it('serves a valid link', async () => {
    const res = await run(await signedReq(P, 0));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello world');
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-length')).toBe('11');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('etag')).toBe('"abc123"');
    expect(res.headers.get('last-modified')).toBe('Thu, 02 Jan 2025 03:04:05 GMT');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="video.mp4"/);
  });
  it('expired -> 410, future exp ok', async () => {
    expect((await run(await signedReq(P, 1))).status).toBe(410);
    expect((await run(await signedReq(P, 4_000_000_000))).status).toBe(200);
  });
  it('tampered path / exp / uppercase sig / missing params -> 403 with zero fetches', async () => {
    const good = await signedReq(P, 0);
    const u = new URL(good.url);
    const cases = [
      new Request(good.url.replace('video.mp4', 'other.mp4')),
      new Request(good.url.replace('exp=0', 'exp=5')),
      new Request(good.url.replace(/sig=(.*)$/, (_, s) => 'sig=' + s.toUpperCase())),
      new Request(`${u.origin}${u.pathname}`),
      new Request(`${u.origin}${u.pathname}?exp=0`),
      new Request(`${u.origin}${u.pathname}?sig=${'0'.repeat(64)}`),
      new Request(`${u.origin}${u.pathname}?exp=0&sig=${'0'.repeat(64)}`),
    ];
    for (const r of cases) expect((await run(r)).status).toBe(403);
    expect(m.calls).toHaveLength(0);
  });
  it('non-GET/HEAD -> 405, robots, root', async () => {
    expect((await run(new Request('https://x.example.com/a', { method: 'POST' }))).status).toBe(405);
    expect((await run(new Request('https://x.example.com/a', { method: 'OPTIONS' }))).status).toBe(405);
    const robots = await run(new Request('https://x.example.com/robots.txt'));
    expect(await robots.text()).toContain('Disallow: /');
    const root = await run(new Request('https://x.example.com/'));
    expect(root.status).toBe(404);
    expect(m.calls).toHaveLength(0);
  });
  it.each([
    'https://x.example.com/a//b?exp=0&sig=' + '0'.repeat(64),
    'https://x.example.com/alice/Big%20Buck%20Bunny/?exp=0&sig=' + '0'.repeat(64),
    'https://x.example.com/a%2Fb/c?exp=0&sig=' + '0'.repeat(64),
    'https://x.example.com/a/%zz?exp=0&sig=' + '0'.repeat(64),
  ])('rejects bad path %s without fetching', async (u) => {
    expect((await run(new Request(u))).status).toBe(404);
    expect(m.calls).toHaveLength(0);
  });
  it.each(['/a/../b', '/a/%2e%2e/b'])('traversal %s never reaches Drive', async (p) => {
    // the URL parser collapses these to /b; either way it cannot validate
    const r = await run(new Request(`https://x.example.com${p}?exp=0&sig=${'0'.repeat(64)}`));
    expect([403, 404]).toContain(r.status);
    expect(m.calls).toHaveLength(0);
  });
  it('signed path with encoded slash in a segment is rejected', async () => {
    const r = await run(await signedReq('/a/b', 0, { sigPath: '/a/b' }).then((q) => new Request(q.url.replace('/a/b', '/a%2Fb'))));
    expect(r.status).toBe(404);
    expect(m.calls).toHaveLength(0);
  });
});

describe('configuration', () => {
  it('missing secret -> 500 naming the binding, not leaking values', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await run(await signedReq(P), { ...env, GDRIVE_REFRESH_TOKEN: '' });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toMatch(/GDRIVE/);
    expect(err.mock.calls.flat().join(' ')).toContain('GDRIVE_REFRESH_TOKEN');
    expect(err.mock.calls.flat().join(' ')).not.toContain('csecret');
    expect(m.calls).toHaveLength(0);
  });
});

describe('path resolution', () => {
  it('resolves spaces, unicode, #, %, \' with escaped queries', async () => {
    const p = "/bob/ünï cødé #1 100%/it's a file.txt";
    expect((await run(await signedReq(p))).status).toBe(200);
    const qs = lists().map((c) => c.url.searchParams.get('q'));
    expect(qs).toContain("name = 'it\\'s a file.txt' and 't2' in parents and trashed = false");
    expect(qs).toContain("name = 'ünï cødé #1 100%' and 'u2' in parents and trashed = false");
    const l = lists()[0]!.url.searchParams;
    expect(l.get('supportsAllDrives')).toBe('true');
    expect(l.get('includeItemsFromAllDrives')).toBe('true');
    expect(l.get('fields')).toBe('files(id,name,mimeType,size,md5Checksum,modifiedTime)');
  });
  it('q() escapes backslash and quote', () => {
    expect(q("a\\b'c")).toBe("a\\\\b\\'c");
  });
  it('folder as file, google doc, missing file/folder, file as folder -> 404', async () => {
    for (const p of ['/alice/Big Buck Bunny', '/alice/Big Buck Bunny/doc', '/alice/Big Buck Bunny/nope.mp4', '/nobody/x/y', '/alice/Big Buck Bunny/video.mp4/extra']) {
      expect((await run(await signedReq(p))).status).toBe(404);
    }
  });
  it('picks the most recently modified duplicate', async () => {
    await run(await signedReq('/alice/Big Buck Bunny/dup.txt'));
    expect(m.calls.some((c) => c.url.pathname === '/drive/v3/files/dup2')).toBe(true);
  });
  it('lookup cache avoids a second files.list', async () => {
    await run(await signedReq(P));
    const n = lists().length;
    expect(n).toBe(3);
    await run(await signedReq(P));
    expect(lists().length).toBe(n);
  });
  it('negative results are cached briefly', async () => {
    await run(await signedReq('/alice/Big Buck Bunny/nope.mp4'));
    const n = lists().length;
    await run(await signedReq('/alice/Big Buck Bunny/nope.mp4'));
    expect(lists().length).toBe(n);
  });
});

describe('access token', () => {
  it('is cached across requests', async () => {
    await run(await signedReq(P));
    await run(await signedReq(P));
    expect(m.tokens).toBe(1);
  });
  it('concurrent requests share one refresh', async () => {
    const rs = await Promise.all([signedReq(P), signedReq(P), signedReq('/alice/Big Buck Bunny/dup.txt')]);
    await Promise.all(rs.map((r) => run(r)));
    expect(m.tokens).toBe(1);
  });
  it('401 from Drive -> refresh once and retry', async () => {
    m.rejectFirstToken = true;
    const res = await run(await signedReq(P));
    expect(res.status).toBe(200);
    expect(m.tokens).toBe(2);
  });
  it('sends the refresh-token grant', async () => {
    await run(await signedReq(P));
    const body = String(m.calls[0]!.init!.body);
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=rtoken');
  });
  it('refresh failure -> 502 without leaking', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', async () => new Response('{"error":"invalid_grant","secret":"leak"}', { status: 400 }));
    const res = await run(await signedReq(P));
    expect(res.status).toBe(502);
    expect(await res.text()).not.toMatch(/leak|invalid_grant/);
  });
});

describe('streaming', () => {
  it('Range passthrough -> 206 with Content-Range', async () => {
    m.media = (_u, init) => new Response('hello', { status: 206, headers: { 'content-range': 'bytes 0-4/11', 'content-length': '5' } });
    const res = await run(await signedReq(P, 0, { headers: { range: 'bytes=0-4' } }));
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-4/11');
    expect(res.headers.get('content-length')).toBe('5');
    expect(await res.text()).toBe('hello');
    const media = m.calls.find((c) => c.url.searchParams.get('alt') === 'media')!;
    expect((media.init!.headers as any).range).toBe('bytes=0-4');
  });
  it('If-Range with our ETag keeps the range; foreign validator gets the whole file', async () => {
    await run(await signedReq(P, 0, { headers: { range: 'bytes=0-4', 'if-range': '"abc123"' } }));
    await run(await signedReq(P, 0, { headers: { range: 'bytes=0-4', 'if-range': '"other"' } }));
    const media = m.calls.filter((c) => c.url.searchParams.get('alt') === 'media');
    expect((media[0]!.init!.headers as any).range).toBe('bytes=0-4');
    expect((media[1]!.init!.headers as any).range).toBeUndefined();
  });
  it('416 passes through', async () => {
    m.media = () => new Response('', { status: 416, headers: { 'content-range': 'bytes */11' } });
    const res = await run(await signedReq(P, 0, { headers: { range: 'bytes=50-' } }));
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */11');
  });
  it('HEAD has headers but no body and no media fetch', async () => {
    const res = await run(await signedReq(P, 0, { method: 'HEAD' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('11');
    expect(await res.text()).toBe('');
    expect(m.mediaCalls).toBe(0);
  });
  it('?inline=1 is ignored: always attachment, sandboxed, nosniff', async () => {
    const res = await run(await signedReq(P, 0, { query: '&inline=1' }));
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
  it.each([
    ['downloadQuotaExceeded', 403], ['userRateLimitExceeded', 403], [undefined, 429],
  ])('quota (%s, %i) -> 429 with Retry-After', async (reason, status) => {
    m.media = () => Response.json({ error: { errors: [{ reason }], message: 'secret details' } }, { status });
    const res = await run(await signedReq(P));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await res.text()).not.toMatch(/secret details/);
  });
  it('other upstream failure -> 502 without echoing body', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    m.media = () => new Response('internal boom', { status: 500 });
    const res = await run(await signedReq(P));
    expect(res.status).toBe(502);
    expect(await res.text()).not.toMatch(/boom/);
  });
  it('retries with acknowledgeAbuse on cannotDownloadAbusiveFile', async () => {
    m.media = (u, _i, n) => n === 1
      ? Response.json({ error: { errors: [{ reason: 'cannotDownloadAbusiveFile' }] } }, { status: 403 })
      : new Response('ok', { status: 200 });
    const res = await run(await signedReq(P));
    expect(res.status).toBe(200);
    expect(m.mediaCalls).toBe(2);
    expect(m.calls.filter((c) => c.url.searchParams.get('alt') === 'media')[1]!.url.searchParams.get('acknowledgeAbuse')).toBe('true');
  });
});

describe('CORS', () => {
  it('none by default; allowed origin echoed', async () => {
    const h = { origin: 'https://seedbox.example.com' };
    expect((await run(await signedReq(P, 0, { headers: h }))).headers.get('access-control-allow-origin')).toBeNull();
    const res = await run(await signedReq(P, 0, { headers: h }), { ...env, ALLOWED_ORIGINS: 'https://seedbox.example.com' });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://seedbox.example.com');
    const other = await run(await signedReq(P, 0, { headers: { origin: 'https://evil.example.org' } }), { ...env, ALLOWED_ORIGINS: 'https://seedbox.example.com' });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('Content-Disposition', () => {
  it('ascii fallback and RFC 5987 encoding', () => {
    expect(contentDisposition('plain.txt')).toBe(`attachment; filename="plain.txt"; filename*=UTF-8''plain.txt`);
    expect(contentDisposition(`ünï "q" it's 100%.txt`)).toBe(
      `attachment; filename="_n_ _q_ it's 100_.txt"; filename*=UTF-8''%C3%BCn%C3%AF%20%22q%22%20it%27s%20100%25.txt`,
    );
  });
});

describe('active content types are neutralised', () => {
  it.each(['text/html', 'text/html; charset=utf-8', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/xml', 'application/atom+xml',
    'application/javascript', 'text/javascript', 'application/x-javascript', 'TEXT/HTML'])('%s -> octet-stream', (mime) => {
    expect(safeContentType(mime)).toBe('application/octet-stream');
  });
  it.each(['video/mp4', 'text/plain', 'application/pdf', undefined])('%s is kept/defaulted', (mime) => {
    expect(safeContentType(mime)).toBe(mime ?? 'application/octet-stream');
  });
  it('a stored html file is served as an octet-stream attachment with a sandbox CSP', async () => {
    const tree: DriveNode[] = [
      { id: 'ux', name: 'eve', mimeType: FOLDER, parent: 'ROOT' },
      { id: 'tx', name: 'T', mimeType: FOLDER, parent: 'ux' },
      { id: 'fx', name: 'x.html', mimeType: 'text/html', parent: 'tx', size: '11' },
    ];
    installFakes(tree);
    const res = await run(await signedReq('/eve/T/x.html'));
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  });
});
