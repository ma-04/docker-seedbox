import { describe, expect, it } from 'vitest';
import { mapQbtState, QbittorrentDownloader } from './qbittorrent.js';
import { DownloaderUnavailableError } from './types.js';

describe('mapQbtState', () => {
  it.each([
    ['downloading', 0.3, 'downloading'], ['stalledDL', 0.3, 'downloading'], ['queuedDL', 0, 'downloading'], ['checkingDL', 0.1, 'downloading'],
    ['metaDL', 0, 'metadata-pending'], ['forcedMetaDL', 0, 'metadata-pending'],
    ['error', 0.5, 'error'], ['missingFiles', 1, 'error'],
    ['uploading', 1, 'completed'], ['stalledUP', 1, 'completed'], ['stoppedUP', 1, 'completed'], ['pausedUP', 1, 'completed'],
    ['pausedDL', 0.2, 'downloading'], ['moving', 1, 'downloading'],
  ] as const)('%s @ %s -> %s', (s, p, want) => expect(mapQbtState(s, p)).toBe(want));
});

function fakeQbt(opts: { requireLogin?: boolean; addReply?: string } = {}) {
  const calls: { path: string; method: string; body: unknown; cookie: string | null }[] = [];
  let loggedIn = !opts.requireLogin;
  const torrents: Record<string, unknown>[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname.replace('/api/v2', '');
    const headers = init.headers as Record<string, string>;
    calls.push({ path, method: init.method ?? 'GET', body: init.body, cookie: headers.cookie ?? null });
    if (path === '/auth/login') {
      loggedIn = true;
      return new Response('Ok.', { headers: { 'set-cookie': 'SID=abc123; HttpOnly; path=/' } });
    }
    if (!loggedIn) return new Response('Forbidden', { status: 403 });
    if (path === '/torrents/createCategory') return new Response('', { status: 409 });
    if (path === '/torrents/add') return new Response(opts.addReply ?? 'Ok.');
    if (path === '/torrents/info') return Response.json(torrents);
    return new Response('');
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, torrents };
}

describe('QbittorrentDownloader', () => {
  it.each([
    ['LF', 'magnet:?xt=urn:btih:' + 'a'.repeat(40) + '&dn=x\nhttp://172.31.250.1/x'],
    ['CR', 'magnet:?xt=urn:btih:' + 'a'.repeat(40) + '&dn=x\rhttp://172.31.250.1/x'],
    ['CRLF', 'magnet:?xt=urn:btih:' + 'a'.repeat(40) + '\r\n'],
    ['space', 'magnet:?xt=urn:btih:' + 'a'.repeat(40) + ' http://x'],
    ['not a magnet', 'http://172.31.250.1/x'],
  ])('never sends a urls value with %s', async (_n, bad) => {
    const q = fakeQbt();
    const d = new QbittorrentDownloader({ baseUrl: 'http://qbt:8080/', fetchImpl: q.fetchImpl });
    await expect(d.add({ id: 'a'.repeat(40), source: { magnet: bad }, savePath: '/p' })).rejects.toThrow(/malformed magnet/);
    expect(q.calls.some((c) => c.path === '/torrents/add')).toBe(false);
  });
  it('sends exactly one urls field', async () => {
    const q = fakeQbt();
    const d = new QbittorrentDownloader({ baseUrl: 'http://qbt:8080/', fetchImpl: q.fetchImpl });
    await d.add({ id: 'a'.repeat(40), source: { magnet: 'magnet:?xt=urn:btih:' + 'a'.repeat(40) }, savePath: '/p' });
    const fd = q.calls.find((c) => c.path === '/torrents/add')!.body as FormData;
    expect(fd.getAll('urls')).toEqual(['magnet:?xt=urn:btih:' + 'a'.repeat(40)]);
  });

  it('adds a magnet with category, savepath and Original layout', async () => {
    const q = fakeQbt();
    const d = new QbittorrentDownloader({ baseUrl: 'http://qbt:8080/', fetchImpl: q.fetchImpl });
    await d.add({ id: 'a'.repeat(40), source: { magnet: 'magnet:?xt=urn:btih:x' }, savePath: '/downloads/incomplete/aaa' });
    const add = q.calls.find((c) => c.path === '/torrents/add')!;
    const fd = add.body as FormData;
    expect(fd.get('urls')).toBe('magnet:?xt=urn:btih:x');
    expect(fd.get('category')).toBe('seedbox');
    expect(fd.get('savepath')).toBe('/downloads/incomplete/aaa');
    expect(fd.get('contentLayout')).toBe('Original');
  });

  it('adds .torrent bytes as a file part', async () => {
    const q = fakeQbt();
    const d = new QbittorrentDownloader({ baseUrl: 'http://qbt:8080', fetchImpl: q.fetchImpl });
    await d.add({ id: 'a'.repeat(40), source: { torrent: Buffer.from('d4:infod') }, savePath: '/p' });
    const fd = q.calls.find((c) => c.path === '/torrents/add')!.body as FormData;
    expect(fd.get('torrents')).toBeInstanceOf(Blob);
    expect(fd.get('urls')).toBeNull();
  });

  it('"Fails." is fine when the torrent already exists, an error otherwise', async () => {
    const q = fakeQbt({ addReply: 'Fails.' });
    const d = new QbittorrentDownloader({ baseUrl: 'http://qbt', fetchImpl: q.fetchImpl });
    await expect(d.add({ id: 'a'.repeat(40), source: { magnet: 'magnet:?xt=urn:btih:' + 'a'.repeat(40) }, savePath: '/p' })).rejects.toThrow(/rejected/);
    q.torrents.push({ hash: 'a'.repeat(40), name: 'n', size: 1, progress: 0, dlspeed: 0, state: 'metaDL', ratio: 0, content_path: '', save_path: '' });
    await expect(d.add({ id: 'a'.repeat(40), source: { magnet: 'magnet:?xt=urn:btih:' + 'a'.repeat(40) }, savePath: '/p' })).resolves.toBeUndefined();
  });

  it('maps status fields; null when unknown', async () => {
    const q = fakeQbt();
    const d = new QbittorrentDownloader({ baseUrl: 'http://qbt', fetchImpl: q.fetchImpl });
    expect(await d.status('f'.repeat(40))).toBeNull();
    q.torrents.push({ hash: 'f'.repeat(40), name: 'N', size: 100, progress: 0.5, dlspeed: 9, state: 'downloading', ratio: 0.1, content_path: '/d/N', save_path: '/d' });
    expect(await d.status('F'.repeat(40))).toMatchObject({ state: 'downloading', name: 'N', totalSize: 100, progress: 0.5, dlSpeed: 9, ratio: 0.1, contentPath: '/d/N', savePath: '/d' });
    expect(q.calls.at(-1)!.path).toBe('/torrents/info');
  });

  it('remove passes deleteFiles', async () => {
    const q = fakeQbt();
    const d = new QbittorrentDownloader({ baseUrl: 'http://qbt', fetchImpl: q.fetchImpl });
    await d.remove('A'.repeat(40), true);
    const del = q.calls.find((c) => c.path === '/torrents/delete')!;
    expect(String(del.body)).toContain('deleteFiles=true');
    expect(String(del.body)).toContain(`hashes=${'a'.repeat(40)}`);
  });

  it('logs in once on 403 when credentials are provided, otherwise throws', async () => {
    const q = fakeQbt({ requireLogin: true });
    const d = new QbittorrentDownloader({ baseUrl: 'http://qbt', username: 'u', password: 'p', fetchImpl: q.fetchImpl });
    await d.status('a'.repeat(40));
    expect(q.calls.map((c) => c.path)).toEqual(['/torrents/info', '/auth/login', '/torrents/info']);
    expect(q.calls.at(-1)!.cookie).toBe('SID=abc123');
    const d2 = new QbittorrentDownloader({ baseUrl: 'http://qbt', fetchImpl: fakeQbt({ requireLogin: true }).fetchImpl });
    await expect(d2.status('a'.repeat(40))).rejects.toThrow(/403/);
  });
});

describe('QbittorrentDownloader preferences', () => {
  it('reads preferences and posts json=<object> to setPreferences', async () => {
    const seen: { path: string; body?: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname.replace('/api/v2', '');
      seen.push({ path, body: init.body as string | undefined });
      return path === '/app/preferences' ? Response.json({ dht: true }) : new Response('');
    }) as unknown as typeof fetch;
    const d = new QbittorrentDownloader({ baseUrl: 'http://qbt:8080', fetchImpl });
    expect(await d.getPreferences()).toEqual({ dht: true });
    await d.setPreferences({ dl_limit: 1024, dht: false });
    expect(seen[1]!.path).toBe('/app/setPreferences');
    expect(new URLSearchParams(seen[1]!.body).get('json')).toBe('{"dl_limit":1024,"dht":false}');
  });
  it('throws on upstream failure', async () => {
    const d = new QbittorrentDownloader({ baseUrl: 'http://qbt', fetchImpl: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch });
    await expect(d.getPreferences()).rejects.toThrow();
  });
});

describe('unreachable downloader is distinguishable from a rejected torrent', () => {
  it('network errors and 5xx/403 are DownloaderUnavailableError; a rejection is a plain Error', async () => {
    const down = new QbittorrentDownloader({ baseUrl: 'http://qbt:8080', fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch });
    await expect(down.status('a'.repeat(40))).rejects.toBeInstanceOf(DownloaderUnavailableError);
    const err503 = new QbittorrentDownloader({ baseUrl: 'http://qbt:8080', fetchImpl: (async () => new Response('', { status: 503 })) as unknown as typeof fetch });
    await expect(err503.status('a'.repeat(40))).rejects.toBeInstanceOf(DownloaderUnavailableError);
    const q = fakeQbt({ addReply: 'Fails.' });
    const rejected = new QbittorrentDownloader({ baseUrl: 'http://qbt:8080', fetchImpl: q.fetchImpl });
    const e = await rejected.add({ id: 'a'.repeat(40), source: { magnet: 'magnet:?xt=urn:btih:x' }, savePath: '/x' }).catch((x) => x as Error);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(DownloaderUnavailableError);
  });
});
