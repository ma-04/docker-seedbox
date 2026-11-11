import { describe, expect, it } from 'vitest';
import { encryptJson } from '../lib/crypto.js';
import { getSetting, hasSetting, setSetting } from '../lib/settings.js';
import type { RequestFn } from '../lib/trackerlist.js';
import { TrackerSync, type TrackerEngine } from './trackers.js';
import { makeEnv, SECRET, silent } from './testkit.js';

const A = 'https://lists.example.org/a.txt';
const HASH = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';

class FakeEngine implements TrackerEngine {
  prefs: Record<string, unknown> = { add_trackers_enabled: true, add_trackers: 'http://172.31.250.30:6969/announce', add_trackers_from_url_enabled: false };
  sets: Record<string, unknown>[] = [];
  gets = 0;
  fail = false;
  priv: string[] = [];
  trackers = new Map<string, string[]>();
  removed: { hash: string; urls: string[] }[] = [];
  async getPreferences() { this.gets++; if (this.fail) throw new Error('down'); return { ...this.prefs }; }
  async setPreferences(p: Record<string, unknown>) { this.sets.push(p); this.prefs = { ...this.prefs, ...p }; }
  async privateTorrents() { return this.priv; }
  async torrentTrackers(h: string) { return this.trackers.get(h) ?? []; }
  async removeTrackers(hash: string, urls: string[]) { this.removed.push({ hash, urls }); this.trackers.set(hash, (this.trackers.get(hash) ?? []).filter((u) => !urls.includes(u))); }
}

function setup(body: string | Error = 'udp://a1.example.org:6969/announce\nudp://a2.example.org:6969/announce\n') {
  const env = makeEnv();
  const engine = new FakeEngine();
  let ms = 1_000_000;
  const requests: string[] = [];
  const request: RequestFn = async (u) => {
    requests.push(u.href);
    if (body instanceof Error) throw body;
    return { status: 200, headers: {}, body: (async function* () { yield Buffer.from(body); })(), destroy: () => {} };
  };
  const sync = new TrackerSync({ ...env, engine, log: silent, fetch: { guard: async (u) => new URL(u), request }, verifyEveryMs: 60_000, privateEveryMs: 1 }, () => ms);
  const tick = async () => { await sync.tick(); await sync.idle(); await sync.tick(); };
  return { ...env, engine, sync, tick, requests, advance: (d: number) => { ms += d; } };
}

describe('tracker sync (worker)', () => {
  it('migrates the engine\'s current manual list and switch on first run, so existing deployments keep them', async () => {
    const s = setup();
    expect(hasSetting(s.db, 'trackers.manual')).toBe(false);
    await s.sync.tick();
    expect(getSetting(s.db, 'trackers.manual')).toBe('http://172.31.250.30:6969/announce');
    expect(getSetting(s.db, 'trackers.enabled')).toBe(true);
    expect(s.engine.sets).toEqual([]); // nothing to change: the engine already has exactly this list
  });

  it('does not overwrite settings the admin already saved', async () => {
    const s = setup();
    setSetting(s.db, 'trackers.manual', 'http://mine.example.org/a');
    await s.sync.tick();
    expect(getSetting(s.db, 'trackers.manual')).toBe('http://mine.example.org/a');
    expect(s.engine.sets).toEqual([{ add_trackers_enabled: true, add_trackers_from_url_enabled: false, add_trackers: 'http://mine.example.org/a' }]);
  });

  it('fetches the lists and writes manual + fetched (manual first, one tier each) to the engine, keeping the native URL preference off', async () => {
    const s = setup();
    setSetting(s.db, 'trackers.listUrls', [A]);
    await s.tick();
    expect(s.requests).toEqual([A]);
    expect(s.engine.sets).toEqual([{
      add_trackers_enabled: true, add_trackers_from_url_enabled: false,
      add_trackers: 'http://172.31.250.30:6969/announce\n\nudp://a1.example.org:6969/announce\n\nudp://a2.example.org:6969/announce',
    }]);
  });

  it('a case-only change of a manual tracker is written to the engine', async () => {
    const s = setup();
    setSetting(s.db, 'trackers.manual', 'http://t.example.org/ABC/announce');
    await s.tick();
    setSetting(s.db, 'trackers.manual', 'http://t.example.org/abc/announce');
    await s.tick();
    expect(s.engine.sets.map((w) => w.add_trackers)).toEqual(['http://t.example.org/ABC/announce', 'http://t.example.org/abc/announce']);
  });

  it('writes only when the effective list changed, and re-applies after the engine lost it (restart) on the slow check', async () => {
    const s = setup();
    setSetting(s.db, 'trackers.listUrls', [A]);
    await s.tick();
    const n = s.engine.sets.length;
    const gets = s.engine.gets;
    for (let i = 0; i < 5; i++) { s.advance(2000); await s.sync.tick(); }
    expect(s.engine.sets).toHaveLength(n);
    expect(s.engine.gets).toBe(gets); // quiet ticks do not even query the engine
    s.engine.prefs = { add_trackers_enabled: false, add_trackers: '', add_trackers_from_url_enabled: false }; // qBittorrent restarted with defaults
    s.advance(2000); await s.sync.tick();
    expect(s.engine.sets).toHaveLength(n);
    s.advance(60_000); await s.sync.tick();
    expect(s.engine.sets).toHaveLength(n + 1);
    expect(s.engine.prefs.add_trackers_enabled).toBe(true);
    // an admin edit of the manual list is picked up on the next tick
    setSetting(s.db, 'trackers.manual', 'http://other.example.org/a');
    s.advance(2000); await s.sync.tick();
    expect(s.engine.sets).toHaveLength(n + 2);
    expect(String(s.engine.prefs.add_trackers).split('\n')[0]).toBe('http://other.example.org/a');
  });

  it('switches the native "add trackers from URL" preference off if someone turned it on', async () => {
    const s = setup();
    await s.sync.tick();
    s.engine.prefs.add_trackers_from_url_enabled = true;
    s.advance(60_000); await s.sync.tick();
    expect(s.engine.prefs.add_trackers_from_url_enabled).toBe(false);
  });

  it('disabled: nothing is fetched, the engine is told to add nothing', async () => {
    const s = setup();
    setSetting(s.db, 'trackers.listUrls', [A]);
    setSetting(s.db, 'trackers.manual', 'http://m.example.org/a');
    setSetting(s.db, 'trackers.enabled', false);
    await s.tick();
    expect(s.requests).toEqual([]);
    expect(s.engine.sets).toEqual([{ add_trackers_enabled: false, add_trackers_from_url_enabled: false }]);
  });

  it('a failing list keeps the previous trackers applied (stale-while-error) and does not change the engine', async () => {
    const s = setup();
    setSetting(s.db, 'trackers.listUrls', [A]);
    await s.tick();
    const n = s.engine.sets.length;
    // a second sync over the same DB whose transport fails
    const failing = new TrackerSync({ db: s.db, config: s.config, engine: s.engine, log: silent, fetch: { guard: async (u) => new URL(u), request: async () => { throw new Error('boom'); } } }, () => 5_000_000);
    setSetting(s.db, 'trackers.refreshRequestedAt', 9_999_999_999);
    await failing.tick(); await failing.idle(); await failing.tick();
    expect(s.engine.sets).toHaveLength(n);
    expect(String(s.engine.prefs.add_trackers)).toContain('a1.example.org');
  });

  it('waits for the engine without throwing; migration happens once it answers', async () => {
    const s = setup();
    s.engine.fail = true;
    await s.sync.tick();
    expect(hasSetting(s.db, 'trackers.manual')).toBe(false);
    s.engine.fail = false;
    s.advance(11_000);
    await s.sync.tick();
    expect(hasSetting(s.db, 'trackers.manual')).toBe(true);
  });

  describe('private torrents', () => {
    const magnet = (tr: string[]) => `magnet:?xt=urn:btih:${HASH}${tr.map((t) => `&tr=${encodeURIComponent(t)}`).join('')}`;
    function withTorrent(src: object) {
      const s = setup();
      s.db.prepare('INSERT INTO torrents (infohash, source_enc, added_at) VALUES (?, ?, 1)').run(HASH, encryptJson(SECRET, src));
      setSetting(s.db, 'trackers.listUrls', [A]);
      s.engine.priv = [HASH];
      return s;
    }
    it('removes the extra trackers from a private magnet torrent but keeps the ones from the magnet itself', async () => {
      const s = withTorrent({ magnet: magnet(['https://private.example.net/announce?passkey=1']) });
      s.engine.trackers.set(HASH, ['** [DHT] **', 'https://private.example.net/announce?passkey=1', 'http://172.31.250.30:6969/announce', 'udp://a1.example.org:6969/announce', 'udp://unrelated.example.org:1/a']);
      await s.tick();
      s.advance(5); await s.sync.tick(); // the lists are in by now
      expect(s.engine.removed.flatMap((r) => r.urls).sort()).toEqual(['http://172.31.250.30:6969/announce', 'udp://a1.example.org:6969/announce']);
      s.advance(5); await s.sync.tick();
      expect(s.engine.removed.flatMap((r) => r.urls)).toHaveLength(2); // nothing left to remove
    });
    it('leaves .torrent-file sources (the engine already skips private ones) and public torrents alone', async () => {
      const s = withTorrent({ torrentB64: 'AAAA' });
      s.engine.trackers.set(HASH, ['udp://a1.example.org:6969/announce']);
      await s.tick();
      s.engine.priv = [];
      await s.tick();
      expect(s.engine.removed).toEqual([]);
    });
  });
});
