import { describe, expect, it } from 'vitest';
import { decodeStrict, dictGet, type DictNode } from '../lib/bencode-strict.js';
import { rebuildTorrent } from '../lib/torrent-file.js';
import { bd, bdRaw, bi, bl, bs, makeInfo, makeTorrent, sha1hex } from '../lib/torrent-fixtures.js';
import type { DownloadAddInput } from '../downloaders/types.js';
import { Worker } from './loop.js';
import { addDest, addJob, addTorrent, addUser, FakeDownloader, FakeVpn, job, makeEnv, silent, torrent } from './testkit.js';

function setup(dl: FakeDownloader = new FakeDownloader()) {
  const env = makeEnv();
  const worker = new Worker({ db: env.db, config: env.config, downloader: dl, vpn: new FakeVpn(), log: silent, vpnEveryMs: 1e9, strayEveryMs: 0 });
  const u = addUser(env.db, 'Alice');
  const d = addDest(env.db, { type: 'local' }, null);
  const tor = (infohash: string, source: Parameters<typeof addTorrent>[2]) => { const t = addTorrent(env.db, infohash, source); return { t, j: addJob(env.db, u, t, d) }; };
  return { ...env, dl, worker, tor };
}

const INFO = makeInfo({ seed: 5 });
const HASH = sha1hex(INFO);
const b64 = (b: Buffer) => b.toString('base64');

describe('worker: stored torrent sources are strictly rebuilt before they reach the engine', () => {
  it('a legacy stored file with web seeds and extra keys is rebuilt: only info + announce data are sent', async () => {
    const s = setup();
    const legacy = makeTorrent(INFO, { 'url-list': bl(bs('http://172.31.250.1/x')), httpseeds: bl(bs('http://evil/')), comment: bs('c') });
    const { t } = s.tor(HASH, { torrentB64: b64(legacy) });
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('downloading');
    const sent = (s.dl.added[0]!.source as { torrent: Buffer }).torrent;
    const root = decodeStrict(sent) as DictNode;
    expect(root.entries.map((e) => e.key.toString())).toEqual(['info']);
    const v = dictGet(root, 'info')!;
    expect(sha1hex(sent.subarray(v.start, v.end))).toBe(HASH);
  });

  it('a stored file with two info keys is never sent: torrent and job fail with a clear error', async () => {
    const s = setup();
    const decoy = makeInfo({ length: 10, seed: 1 });
    const { t, j } = s.tor(sha1hex(decoy), { torrentB64: b64(bdRaw(['info', decoy], ['info', INFO])) });
    await s.worker.tick();
    expect(s.dl.added).toHaveLength(0);
    expect(torrent(s.db, t).state).toBe('error');
    expect(torrent(s.db, t).error).toMatch(/Invalid torrent source/);
    expect(job(s.db, j).state).toBe('failed');
  });

  it('a stored file with unsorted info keys is never sent', async () => {
    const s = setup();
    const info = bdRaw(['name', bs('a')], ['length', bi(1)], ['piece length', bi(16384)], ['pieces', bs(Buffer.alloc(20, 1))]);
    const { t, j } = s.tor('c'.repeat(40), { torrentB64: b64(makeTorrent(info)) });
    await s.worker.tick();
    expect(s.dl.added).toHaveLength(0);
    expect(torrent(s.db, t).state).toBe('error');
    expect(job(s.db, j).state).toBe('failed');
  });

  it('a valid stored file whose hash differs from the row infohash is failed, not added', async () => {
    const s = setup();
    const { t, j } = s.tor('d'.repeat(40), { torrentB64: b64(makeTorrent(INFO)) });
    await s.worker.tick();
    expect(s.dl.added).toHaveLength(0);
    expect(torrent(s.db, t).error).toMatch(/does not match the recorded infohash/);
    expect(job(s.db, j).state).toBe('failed');
  });

  it('a stored magnet whose xt differs from the row infohash is failed, not added', async () => {
    const s = setup();
    const { t } = s.tor('e'.repeat(40), { magnet: `magnet:?xt=urn:btih:${'f'.repeat(40)}` });
    await s.worker.tick();
    expect(s.dl.added).toHaveLength(0);
    expect(torrent(s.db, t).state).toBe('error');
  });

  it('a missing torrent whose stored source has gone bad is failed immediately (no endless re-add)', async () => {
    const s = setup();
    const { t, j } = s.tor(HASH, { torrentB64: b64(makeTorrent(INFO)) });
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('downloading');
    s.dl.items.delete(HASH); // engine lost it
    s.db.prepare('UPDATE torrents SET source_enc = ? WHERE id = ?').run(
      (await import('../lib/crypto.js')).encryptJson('test-secret-test-secret-test-secret-123', { torrentB64: b64(Buffer.from('garbage')) }), t);
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('error');
    expect(job(s.db, j).state).toBe('failed');
  });
});

/** An engine that "hashes" a different torrent than the one recorded (what the info differential used to cause). */
class DifferentHashDownloader extends FakeDownloader {
  constructor(private readonly actual: string) { super(); }
  override async add(i: DownloadAddInput): Promise<void> { this.added.push(i); this.set(this.actual, { state: 'metadata-pending', savePath: i.savePath }); }
}

describe('worker: nothing may run untracked', () => {
  it('after add, an engine that holds a different torrent: stray removed with data, torrent + job failed', async () => {
    const stray = '9'.repeat(40);
    const s = setup(new DifferentHashDownloader(stray));
    const { t, j } = s.tor(HASH, { torrentB64: b64(makeTorrent(INFO)) });
    await s.worker.tick();
    expect(s.dl.removed).toContainEqual({ ref: stray, deleteData: true });
    expect(s.dl.items.has(stray)).toBe(false);
    expect(torrent(s.db, t).state).toBe('error');
    expect(torrent(s.db, t).error).toMatch(/engine reported a different torrent/);
    expect(job(s.db, j).state).toBe('failed');
  });

  it('magnets: the same rule applies while metadata is still pending', async () => {
    const stray = '8'.repeat(40);
    const s = setup(new DifferentHashDownloader(stray));
    const { t } = s.tor('7'.repeat(40), { magnet: `magnet:?xt=urn:btih:${'7'.repeat(40)}` });
    await s.worker.tick();
    expect(s.dl.removed.map((r) => r.ref)).toContain(stray);
    expect(torrent(s.db, t).state).toBe('error');
  });

  it('an engine that lists the new torrent late and rejects duplicate adds: the stray is still caught, without a second add', async () => {
    class Late extends FakeDownloader {
      adds = 0; listCalls = 0;
      override async add(i: DownloadAddInput): Promise<void> {
        this.adds++;
        if (this.adds > 1) throw new Error('qBittorrent rejected the torrent'); // "Fails." for a duplicate
        this.added.push(i);
      }
      override async list(): Promise<string[]> {
        this.listCalls++;
        if (this.adds >= 1 && this.listCalls >= 3) this.set('6'.repeat(40), { state: 'metadata-pending' }); // appears a little later
        return [...this.items.keys()];
      }
    }
    const dl = new Late();
    const s = setup(dl);
    const { t, j } = s.tor(HASH, { torrentB64: b64(makeTorrent(INFO)) });
    for (let i = 0; i < 4; i++) await s.worker.tick();
    expect(dl.adds).toBe(1);
    expect(torrent(s.db, t).state).toBe('error');
    expect(torrent(s.db, t).error).toMatch(/different torrent/);
    expect(job(s.db, j).state).toBe('failed');
    expect(dl.items.has('6'.repeat(40))).toBe(false);
  });

  it('an unrelated pre-existing stray is removed by the sweep but does not fail an innocent torrent that is listed late', async () => {
    class Slow extends FakeDownloader {
      override async add(i: DownloadAddInput): Promise<void> { this.added.push(i); /* listed only on the next tick */ setTimeout(() => this.set(HASH, { state: 'metadata-pending' }), 0); }
    }
    const dl = new Slow();
    dl.set('5'.repeat(40), { state: 'downloading' });
    const s = setup(dl);
    const { t } = s.tor(HASH, { torrentB64: b64(makeTorrent(INFO)) });
    await s.worker.tick();
    await new Promise((r) => setTimeout(r, 5));
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('downloading');
    expect(dl.items.has('5'.repeat(40))).toBe(false);
    expect(dl.items.has(HASH)).toBe(true);
  });

  it('periodic sweep removes (with data) category torrents that match no non-removed row, keeps tracked ones', async () => {
    const s = setup();
    const { t } = s.tor(HASH, { torrentB64: b64(makeTorrent(INFO)) });
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('downloading');
    const goneRow = 'a1'.repeat(20);
    const orphan = 'b2'.repeat(20);
    addTorrent(s.db, goneRow);
    s.db.prepare("UPDATE torrents SET state = 'removed' WHERE infohash = ?").run(goneRow);
    s.dl.set(goneRow, { state: 'downloading' });
    s.dl.set(orphan, { state: 'downloading' });
    await s.worker.tick();
    expect(s.dl.removed).toContainEqual({ ref: orphan, deleteData: true });
    expect(s.dl.removed).toContainEqual({ ref: goneRow, deleteData: true });
    expect(s.dl.items.has(HASH)).toBe(true);
    expect(s.dl.removed.map((r) => r.ref)).not.toContain(HASH);
  });

  it('what rebuildTorrent sends is exactly what the row claims (sanity on the helper used by the worker)', () => {
    expect(rebuildTorrent(makeTorrent(INFO, { x: bd({}) })).infohash).toBe(HASH);
  });
});
