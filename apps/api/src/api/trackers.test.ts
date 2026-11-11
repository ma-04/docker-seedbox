import { describe, expect, it } from 'vitest';
import { getSetting, setSetting } from '../lib/settings.js';
import { loadConfig } from '../lib/config.js';
import { RateLimiter } from './ratelimit.js';
import { alice, root, setup } from './testutil.js';

const URL = '/api/admin/trackers';
const A = 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt';

describe('admin tracker lists API', () => {
  it('is admin only (GET, PUT, refresh) and requires the CSRF header', async () => {
    const env = setup();
    for (const [m, u, b] of [['GET', URL], ['PUT', URL, { urls: [] }], ['POST', `${URL}/refresh`, {}]] as const) {
      expect((await env.call(alice, m, u, b)).statusCode, `${m} ${u}`).toBe(403);
    }
    const noCsrf = await env.call(root, 'PUT', URL, { urls: [] }, { headers: { 'x-requested-with': '' } });
    expect(noCsrf.statusCode).toBeGreaterThanOrEqual(400);
    expect(getSetting(env.db, 'trackers.listUrls')).toEqual([]);
  });

  it('GET returns defaults; PUT saves, normalises, dedupes and requests a refresh', async () => {
    const env = setup();
    expect((await env.call(root, 'GET', URL)).json()).toEqual({
      enabled: true, urls: [], refreshHours: 24, maxTrackers: 200, lists: [], manualCount: 0, effectiveCount: 0, refreshRequestedAt: null,
    });
    const r = await env.call(root, 'PUT', URL, { urls: [A, A, ' https://lists.example.org/b.txt '], refreshHours: 12, maxTrackers: 50 });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j).toMatchObject({ urls: [A, 'https://lists.example.org/b.txt'], refreshHours: 12, maxTrackers: 50 });
    expect(j.lists.map((l: { url: string }) => l.url)).toEqual(j.urls);
    expect(j.lists[0]).toMatchObject({ lastFetchedAt: null, ok: false, trackerCount: 0 });
    expect(j.refreshRequestedAt).toBeGreaterThan(0); // the worker fetches the new URLs right away
  });

  it('clearing the URLs (or changing them while switched off) requests no refresh nobody would acknowledge', async () => {
    const env = setup();
    await env.call(root, 'PUT', URL, { urls: [A] });
    setSetting(env.db, 'trackers.refreshDoneAt', getSetting(env.db, 'trackers.refreshRequestedAt'));
    expect((await env.call(root, 'PUT', URL, { urls: [] })).json().refreshRequestedAt).toBeNull();
    setSetting(env.db, 'trackers.enabled', false);
    expect((await env.call(root, 'PUT', URL, { urls: [A] })).json().refreshRequestedAt).toBeNull();
  });

  it('a settings-only change does not request a refresh; the generic settings endpoint hides and ignores tracker keys', async () => {
    const env = setup();
    await env.call(root, 'PUT', URL, { refreshHours: 6 });
    expect(getSetting(env.db, 'trackers.refreshRequestedAt')).toBe(0);
    const s = (await env.call(root, 'GET', '/api/admin/settings')).json();
    expect(Object.keys(s).filter((k) => k.startsWith('trackers.'))).toEqual([]);
    await env.call(root, 'PUT', '/api/admin/settings', { 'trackers.listUrls': ['https://x.example.org/'], 'trackers.enabled': false });
    expect(getSetting(env.db, 'trackers.listUrls')).toEqual([]);
    expect(getSetting(env.db, 'trackers.enabled')).toBe(true);
  });

  it.each([
    ['http scheme', { urls: ['http://lists.example.org/a.txt'] }],
    ['credentials', { urls: ['https://user:pw@lists.example.org/a.txt'] }],
    ['private IP', { urls: ['https://10.0.0.5/a.txt'] }],
    ['loopback', { urls: ['https://127.0.0.1/a.txt'] }],
    ['link-local metadata', { urls: ['https://169.254.169.254/latest'] }],
    ['single label host', { urls: ['https://intranet/a.txt'] }],
    ['internal suffix', { urls: ['https://nas.local/a.txt'] }],
    ['other scheme', { urls: ['ftp://lists.example.org/a.txt'] }],
    ['not a url', { urls: ['nope'] }],
    ['six urls', { urls: Array.from({ length: 6 }, (_, i) => `https://l${i}.example.org/a.txt`) }],
    ['too long', { urls: [`https://lists.example.org/${'x'.repeat(2100)}`] }],
    ['refresh too low', { refreshHours: 0 }],
    ['refresh too high', { refreshHours: 721 }],
    ['max too low', { maxTrackers: 0 }],
    ['max too high', { maxTrackers: 1001 }],
    ['unknown key', { enabled: false }],
  ])('rejects %s', async (_n, body) => {
    const env = setup();
    const r = await env.call(root, 'PUT', URL, body);
    expect(r.statusCode).toBe(400);
    expect(getSetting(env.db, 'trackers.listUrls')).toEqual([]);
  });

  it('rejects a name that resolves to a private address (checked at save time)', async () => {
    const env = setup(undefined, undefined, { lookup: async () => [{ address: '192.168.1.10', family: 4 }] });
    expect((await env.call(root, 'PUT', URL, { urls: ['https://lists.example.org/a.txt'] })).statusCode).toBe(400);
  });

  it('accepts five URLs', async () => {
    const env = setup();
    const urls = Array.from({ length: 5 }, (_, i) => `https://l${i}.example.org/a.txt`);
    expect((await env.call(root, 'PUT', URL, { urls })).statusCode).toBe(200);
  });

  it('refresh answers 202, marks a pending request, and is rate limited to 6 per minute', async () => {
    const env = setup(undefined, undefined, { limiter: new RateLimiter(() => 1_000_000) });
    await env.call(root, 'PUT', URL, { urls: [A] });
    setSetting(env.db, 'trackers.refreshDoneAt', getSetting(env.db, 'trackers.refreshRequestedAt'));
    expect((await env.call(root, 'GET', URL)).json().refreshRequestedAt).toBeNull();
    const r = await env.call(root, 'POST', `${URL}/refresh`);
    expect(r.statusCode).toBe(202);
    expect(r.json().refreshRequestedAt).toBeGreaterThan(getSetting(env.db, 'trackers.refreshDoneAt'));
    for (let i = 0; i < 5; i++) expect((await env.call(root, 'POST', `${URL}/refresh`)).statusCode).toBe(202);
    const limited = await env.call(root, 'POST', `${URL}/refresh`);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('refresh is refused (409) with no URLs or when the mechanism is switched off', async () => {
    const env = setup();
    expect((await env.call(root, 'POST', `${URL}/refresh`)).statusCode).toBe(409);
    await env.call(root, 'PUT', URL, { urls: [A] });
    setSetting(env.db, 'trackers.enabled', false);
    expect((await env.call(root, 'POST', `${URL}/refresh`)).statusCode).toBe(409);
  });

  it('shows per-URL status and the effective count from the worker-written table', async () => {
    const env = setup();
    await env.call(root, 'PUT', URL, { urls: [A] });
    setSetting(env.db, 'trackers.manual', 'http://172.31.250.30:6969/announce');
    env.db.prepare('INSERT INTO tracker_lists (url, fetched_at, attempted_at, ok, error, tracker_count, trackers_json) VALUES (?, 100, 200, 0, ?, 2, ?)')
      .run(A, 'The server answered HTTP 503', JSON.stringify(['udp://a.example.org:1/a', 'udp://b.example.org:1/a']));
    const j = (await env.call(root, 'GET', URL)).json();
    expect(j.lists[0]).toEqual({ url: A, lastFetchedAt: 100, lastAttemptAt: 200, ok: false, error: 'The server answered HTTP 503', trackerCount: 2 });
    expect(j).toMatchObject({ manualCount: 1, effectiveCount: 3 });
  });
});

describe('TRACKER_LIST_ALLOW_PRIVATE (hermetic test stack only)', () => {
  const base = { APP_SECRET: 's'.repeat(40), GATEWAY_SECRET: 'g', VPN_CONTROL_TOKEN: 'v' };
  it('is refused unless E2E_HERMETIC=1 is set too, and off by default', () => {
    expect(loadConfig({ ...base }).trackerListAllowPrivate).toBe(false);
    expect(() => loadConfig({ ...base, TRACKER_LIST_ALLOW_PRIVATE: '1' })).toThrow(/hermetic/);
    expect(loadConfig({ ...base, TRACKER_LIST_ALLOW_PRIVATE: '1', E2E_HERMETIC: '1' }).trackerListAllowPrivate).toBe(true);
  });
  it('lets the API accept an http, private list URL only then', async () => {
    const env = setup();
    env.config.trackerListAllowPrivate = true;
    const r = await env.call(root, 'PUT', URL, { urls: ['http://lists.seedbox.test/trackers.txt', 'http://10.0.0.5/x.txt'] });
    expect(r.statusCode).toBe(200);
    expect(r.json().urls).toHaveLength(2);
  });
});
