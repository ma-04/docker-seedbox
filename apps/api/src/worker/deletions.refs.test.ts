import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { enqueueDeletion, s3Location, stillReferenced } from '../lib/deletions.js';
import { encryptConfig } from '../lib/destinations.js';
import { setSetting } from '../lib/settings.js';
import { now, type JobRow, type S3Config } from '../lib/types.js';
import { processDeletions } from './deletions.js';
import { Worker } from './loop.js';
import {
  addDest, addJob, addTorrent, addUser, FakeDownloader, FakeVpn, fakeSpawn, job, makeEnv, SECRET, silent, torrent, writeFiles,
} from './testkit.js';

const H = 'a'.repeat(40);
const s3 = (over: Partial<S3Config> = {}): S3Config => ({ type: 's3', endpoint: 'https://s3.example.test', region: 'r', accessKeyId: 'k', secretAccessKey: 's', bucket: 'b', prefix: 'x', forcePathStyle: true, ...over });

describe('S3 remote deletion: references are compared on the resolved (endpoint, bucket, full key)', () => {
  function env() {
    const e = makeEnv();
    setSetting(e.db, 'cleanup.deleteRemoteOnJobDelete', true);
    const u = addUser(e.db, 'alice');
    const t = addTorrent(e.db, H);
    const row = (destId: number, remote: string) => {
      const d = e.db.prepare('SELECT config_enc FROM destinations WHERE id = ?').get(destId) as { config_enc: string };
      return { destination_id: destId, remote_path: remote, kind: 's3' as const, full_path: '', config_enc: d.config_enc };
    };
    const other = (destId: number, remote: string) => {
      const j = addJob(e.db, u, t, destId);
      e.db.prepare("UPDATE jobs SET state = 'completed', remote_path = ? WHERE id = ?").run(remote, j);
    };
    return { ...e, row, other, ref: (destId: number, remote: string) => stillReferenced(e.db, e.config.appSecret, row(destId, remote)) };
  }

  it('two destinations pointing at the same bucket + prefix: the other one\'s copy is kept', () => {
    const e = env();
    const a = addDest(e.db, s3());
    const b = addDest(e.db, s3());
    e.other(b, 'Movie [aaaaaaaa]');
    expect(e.ref(a, 'Movie [aaaaaaaa]')).toBe(true);
    expect(e.ref(a, 'Other [bbbbbbbb]')).toBe(false);
  });

  it('same destination id is still honoured', () => {
    const e = env();
    const a = addDest(e.db, s3());
    e.other(a, 'Movie [aaaaaaaa]');
    expect(e.ref(a, 'Movie [aaaaaaaa]')).toBe(true);
  });

  it('overlapping prefixes resolve to the same key: prefix x + u/J  ==  prefix x/u + J', () => {
    const e = env();
    const a = addDest(e.db, s3({ prefix: 'x' }));
    const b = addDest(e.db, s3({ prefix: 'x/u/' }));
    e.other(b, 'J [aaaaaaaa]');
    expect(e.ref(a, 'u/J [aaaaaaaa]')).toBe(true);
    expect(e.ref(a, 'v/J [aaaaaaaa]')).toBe(false);
  });

  it('different bucket, different prefix or different endpoint: not referenced; endpoint spelling is normalised', () => {
    const e = env();
    const a = addDest(e.db, s3());
    e.other(addDest(e.db, s3({ bucket: 'other' })), 'M [aaaaaaaa]');
    e.other(addDest(e.db, s3({ prefix: 'y' })), 'M [aaaaaaaa]');
    e.other(addDest(e.db, s3({ endpoint: 'https://s3.other.test' })), 'M [aaaaaaaa]');
    expect(e.ref(a, 'M [aaaaaaaa]')).toBe(false);
    e.other(addDest(e.db, s3({ endpoint: 'S3.Example.Test:443/' })), 'M [aaaaaaaa]'); // scheme-less, case, default port, trailing slash
    expect(e.ref(a, 'M [aaaaaaaa]')).toBe(true);
  });

  it('a user-owned and a shared destination on the same bucket share the key as well', () => {
    const e = env();
    const bob = addUser(e.db, 'bob');
    const shared = addDest(e.db, s3(), null);
    const owned = addDest(e.db, s3(), bob);
    e.other(owned, 'M [aaaaaaaa]');
    expect(e.ref(shared, 'M [aaaaaaaa]')).toBe(true);
  });

  it('end to end: purge is skipped while the sibling destination still has the job, then runs', async () => {
    const e = env();
    const a = addDest(e.db, s3());
    const b = addDest(e.db, s3());
    const fs_ = fakeSpawn((_c, _a, _e, p) => p.finish(0));
    const run = () => processDeletions({ db: e.db, config: e.config, log: silent, spawn: fs_.spawn, rcloneBin: 'rclone', endpointGuard: async () => undefined });
    e.other(b, 'alice-1/M [aaaaaaaa]');
    enqueueDeletion(e.db, e.config.appSecret, { destination_id: a, remote_path: 'alice-1/M [aaaaaaaa]', state: 'completed' } as JobRow);
    await run();
    expect(fs_.calls).toHaveLength(0);
    e.db.prepare('DELETE FROM jobs').run();
    enqueueDeletion(e.db, e.config.appSecret, { destination_id: a, remote_path: 'alice-1/M [aaaaaaaa]', state: 'completed' } as JobRow);
    await run();
    expect(fs_.calls.filter((c) => c.args[0] === 'purge')).toHaveLength(1);
  });

  it('s3Location: unit', () => {
    expect(s3Location(s3(), 'u/J')).toBe(s3Location(s3({ prefix: 'x/u' }), 'J'));
    expect(s3Location(s3({ endpoint: 'HTTPS://S3.Example.Test/' }), 'J')).toBe(s3Location(s3({ endpoint: 's3.example.test' }), 'J'));
    expect(s3Location(s3({ endpoint: 'http://minio:9000' }), 'J')).not.toBe(s3Location(s3({ endpoint: 'https://minio:9000' }), 'J'));
    void encryptConfig; void SECRET;
  });
});

describe('local library deletion vs a job for the same torrent (both orders)', () => {
  function setup() {
    const env = makeEnv();
    const lib = join(env.config.downloadsDir, 'library');
    mkdirSync(lib, { recursive: true });
    const dl = new FakeDownloader();
    const worker = new Worker({ db: env.db, config: env.config, downloader: dl, vpn: new FakeVpn(), log: silent, vpnEveryMs: 1e9 });
    const run = () => processDeletions({ db: env.db, config: env.config, log: silent, spawn: fakeSpawn().spawn, rcloneBin: 'rclone' });
    const u = addUser(env.db, 'alice');
    const d = addDest(env.db, { type: 'local' }, null);
    return { ...env, lib, dl, worker, run, u, d };
  }
  const gap = (s: ReturnType<typeof setup>) => {
    // data moved into the library by a finished job; the torrent row still `downloaded` (cleanup has not run yet)
    const t = addTorrent(s.db, H);
    const done = addJob(s.db, s.u, t, s.d);
    s.db.prepare("UPDATE jobs SET state = 'completed', remote_path = 'alice-1/Pack [aaaaaaaa]', completed_at = ? WHERE id = ?").run(now(), done);
    writeFiles(s.lib, { 'alice-1/Pack [aaaaaaaa]/a.txt': 'A' });
    s.db.prepare("UPDATE torrents SET state = 'downloaded', name = 'Pack', progress = 1, library_path = ? WHERE id = ?").run(join(s.lib, 'alice-1/Pack [aaaaaaaa]'), t);
    s.db.prepare('DELETE FROM jobs WHERE id = ?').run(done); // the user deleted the finished job ...
    enqueueDeletion(s.db, s.config.appSecret, { destination_id: s.d, remote_path: 'alice-1/Pack [aaaaaaaa]', state: 'completed' } as JobRow);
    return t;
  };

  it('delete first: the torrent becomes removed + library_path NULL in the same step; a job added afterwards downloads again instead of failing', async () => {
    const s = setup();
    const t = gap(s);
    await s.run();
    expect(existsSync(join(s.lib, 'alice-1'))).toBe(false);
    expect(torrent(s.db, t)).toMatchObject({ state: 'removed', library_path: null });
    // the API (a new job for a removed torrent) resets it to pending
    const j = addJob(s.db, s.u, t, s.d);
    s.db.prepare("UPDATE torrents SET state = 'pending', progress = 0, completed_at = NULL WHERE id = ? AND state IN ('error','removed')").run(t);
    await s.worker.tick();
    expect(torrent(s.db, t).state).toBe('downloading');
    expect(s.dl.added).toHaveLength(1);
    expect(job(s.db, j).state).toBe('downloading');
  });

  it('job first: an active job for the torrent defers the deletion; nothing is removed and the torrent keeps its copy', async () => {
    const s = setup();
    const t = gap(s);
    const j = addJob(s.db, s.u, t, s.d); // added before the worker looks
    await s.run();
    expect(existsSync(join(s.lib, 'alice-1/Pack [aaaaaaaa]/a.txt'))).toBe(true);
    expect(torrent(s.db, t)).toMatchObject({ state: 'downloaded', library_path: join(s.lib, 'alice-1/Pack [aaaaaaaa]') });
    expect(s.db.prepare('SELECT COUNT(*) n FROM pending_deletions').get()).toEqual({ n: 1 }); // deferred, not dropped
    // the job is served from the library copy and completes
    s.db.prepare("UPDATE jobs SET state = 'downloading' WHERE id = ?").run(j);
    await s.worker.tick(); await s.worker.idle();
    expect(job(s.db, j).state).toBe('completed');
  });

  it('upload fallback: a downloaded torrent whose recorded library copy vanished is downloaded again (job not failed)', async () => {
    const s = setup();
    const t = addTorrent(s.db, H);
    const j = addJob(s.db, s.u, t, s.d);
    s.db.prepare("UPDATE torrents SET state = 'downloaded', name = 'Pack', progress = 1, library_path = ? WHERE id = ?").run(join(s.lib, 'alice-1/Pack [aaaaaaaa]'), t);
    s.db.prepare("UPDATE jobs SET state = 'downloading' WHERE id = ?").run(j);
    await s.worker.tick(); await s.worker.idle(); // promote -> upload -> source gone -> back to pending
    expect(job(s.db, j).state).not.toBe('failed');
    expect(job(s.db, j).error).toBeNull();
    expect(torrent(s.db, t).state).toMatch(/pending|downloading/);
    expect(torrent(s.db, t).library_path).toBeNull();
    await s.worker.tick();
    expect(s.dl.added.length).toBeGreaterThanOrEqual(1);
    expect(torrent(s.db, t).state).toBe('downloading');
  });
});
