import { describe, expect, it } from 'vitest';
import { openDb } from './db.js';
import { getSetting, setSetting } from './settings.js';
import type { GuardFn, RequestFn } from './trackerlist.js';
import { effectiveTrackers, mergeEffective, refreshDue, refreshTrackerLists, trackersDto } from './trackers.js';

const A = 'https://lists.example.org/a.txt';
const B = 'https://lists.example.org/b.txt';

/** Transport stub: url -> body | Error | status. */
function stub(answers: Record<string, string | number | Error>): { guard: GuardFn; request: RequestFn; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    guard: async (u) => new URL(u),
    request: async (u) => {
      calls.push(u.href);
      const a = answers[u.href];
      if (a instanceof Error) throw a;
      const status = typeof a === 'number' ? a : 200;
      const body = typeof a === 'string' ? a : '';
      return { status, headers: { 'content-length': String(body.length) }, body: (async function* () { yield Buffer.from(body); })(), destroy: () => {} };
    },
  };
}
const list = (...hosts: string[]) => hosts.map((h) => `udp://${h}.example.org:6969/announce`).join('\n');

describe('mergeEffective', () => {
  it('puts manual trackers first, then fetched ones, deduplicated case-insensitively on scheme+host', () => {
    expect(mergeEffective(['udp://LAN.example:1/a', 'http://m.example.org/a'], ['UDP://lan.example:1/a', 'udp://x.example.org:1/a', 'http://m.example.org/a'], 10))
      .toEqual(['udp://LAN.example:1/a', 'http://m.example.org/a', 'udp://x.example.org:1/a']);
  });
  it('caps the fetched part only, never the manual list', () => {
    const manual = ['http://m1.example.org/a', 'http://m2.example.org/a'];
    expect(mergeEffective(manual, ['udp://a.example.org:1/a', 'udp://b.example.org:1/a', 'udp://c.example.org:1/a'], 2))
      .toEqual([...manual, 'udp://a.example.org:1/a', 'udp://b.example.org:1/a']);
  });
});

describe('refreshTrackerLists', () => {
  it('stores trackers per URL and builds the effective list manual + A + B within maxTrackers', async () => {
    const db = openDb(':memory:');
    setSetting(db, 'trackers.manual', 'http://172.31.250.30:6969/announce');
    setSetting(db, 'trackers.listUrls', [A, B]);
    setSetting(db, 'trackers.maxTrackers', 3);
    const t = stub({ [A]: list('a1', 'a2'), [B]: `# b\n${list('a2', 'b1', 'b2')}` });
    const r = await refreshTrackerLists(db, t, 1000);
    expect(r).toMatchObject({ ok: 2, failed: 0, changed: true });
    expect(effectiveTrackers(db).trackers).toEqual([
      'http://172.31.250.30:6969/announce', 'udp://a1.example.org:6969/announce', 'udp://a2.example.org:6969/announce', 'udp://b1.example.org:6969/announce',
    ]);
    const dto = trackersDto(db);
    expect(dto.lists).toEqual([
      { url: A, lastFetchedAt: 1000, lastAttemptAt: 1000, ok: true, error: null, trackerCount: 2 },
      { url: B, lastFetchedAt: 1000, lastAttemptAt: 1000, ok: true, error: null, trackerCount: 3 },
    ]);
    expect(dto).toMatchObject({ manualCount: 1, effectiveCount: 4 });
    expect((await refreshTrackerLists(db, t, 1100)).changed).toBe(false);
  });

  it('keeps the last good list when a refresh fails (stale-while-error) and stores a short safe error', async () => {
    const db = openDb(':memory:');
    setSetting(db, 'trackers.listUrls', [A, B]);
    await refreshTrackerLists(db, stub({ [A]: list('a1'), [B]: list('b1') }), 1000);
    const r = await refreshTrackerLists(db, stub({
      [A]: '<html><body>Rate limited, secret-token-123</body></html>',
      [B]: Object.assign(new Error('connect ECONNREFUSED 10.1.1.1:443 internal-detail'), { code: 'ECONNREFUSED' }),
    }), 2000);
    expect(r).toMatchObject({ ok: 0, failed: 2, changed: false });
    expect(effectiveTrackers(db).trackers).toEqual(['udp://a1.example.org:6969/announce', 'udp://b1.example.org:6969/announce']);
    const [a, b] = trackersDto(db).lists;
    expect(a).toMatchObject({ ok: false, lastFetchedAt: 1000, lastAttemptAt: 2000, trackerCount: 1, error: 'The response looks like a web page, not a tracker list' });
    expect(b!.error).toBe('Could not connect to the list host');
    expect(JSON.stringify(trackersDto(db))).not.toMatch(/secret-token|10\.1\.1\.1|internal-detail/);
    expect((await refreshTrackerLists(db, stub({ [A]: 500, [B]: 404 }), 3000)).failed).toBe(2);
    expect(trackersDto(db).lists[0]!.error).toBe('The server answered HTTP 500');
  });

  it('drops rows of URLs that are no longer configured and ignores their trackers', async () => {
    const db = openDb(':memory:');
    setSetting(db, 'trackers.listUrls', [A, B]);
    await refreshTrackerLists(db, stub({ [A]: list('a1'), [B]: list('b1') }), 1000);
    setSetting(db, 'trackers.listUrls', [B]);
    expect(effectiveTrackers(db).trackers).toEqual(['udp://b1.example.org:6969/announce']);
    await refreshTrackerLists(db, stub({ [B]: list('b1') }), 1500);
    expect(db.prepare('SELECT url FROM tracker_lists').all()).toEqual([{ url: B }]);
  });

  it('a disabled mechanism yields nothing and is never due', async () => {
    const db = openDb(':memory:');
    setSetting(db, 'trackers.listUrls', [A]);
    setSetting(db, 'trackers.manual', 'http://m.example.org/a');
    expect(refreshDue(db, 10)).toBe(true);
    setSetting(db, 'trackers.enabled', false);
    expect(refreshDue(db, 10)).toBe(false);
    expect(effectiveTrackers(db)).toEqual({ enabled: false, trackers: [], manualCount: 1 });
  });
});

describe('refreshDue', () => {
  it('is due when a list was never fetched, past the interval, or an admin request is pending; failures retry within the hour', async () => {
    const db = openDb(':memory:');
    expect(refreshDue(db, 5)).toBe(false); // no URLs
    setSetting(db, 'trackers.listUrls', [A]);
    setSetting(db, 'trackers.refreshHours', 24);
    expect(refreshDue(db, 5)).toBe(true);
    await refreshTrackerLists(db, stub({ [A]: list('a1') }), 1000);
    expect(refreshDue(db, 1000 + 23 * 3600)).toBe(false);
    expect(refreshDue(db, 1000 + 24 * 3600)).toBe(true);
    setSetting(db, 'trackers.refreshRequestedAt', 1500);
    expect(refreshDue(db, 1600)).toBe(true);
    await refreshTrackerLists(db, stub({ [A]: 500 }), 2000);
    expect(getSetting(db, 'trackers.refreshDoneAt')).toBe(1500);
    expect(refreshDue(db, 2100)).toBe(false);
    expect(refreshDue(db, 2000 + 3600)).toBe(true); // failed: retried after an hour, not 24
  });
});
