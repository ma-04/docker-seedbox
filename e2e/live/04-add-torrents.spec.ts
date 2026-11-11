import { expect, test, type Page } from '@playwright/test';
import { SMALL, SMALL_LIMIT_KBPS, addTorrent, api, debianNetinst, jobRow, login, qbtJson, recordRunFolder, save, state, ubuntuLts, type Official } from './lib';

test.describe.configure({ mode: 'serial' });

test.describe('4a. add the torrents (the VPN is required and connected)', () => {
  test('precondition: VPN required and connected before anything is added', async ({ page }) => {
    await login(page, 'admin');
    const s = (await api(page, 'GET', '/api/admin/vpn/status')).json;
    expect(s.mode).toBe('required');
    expect(s.connected).toBe(true);
    const dl = (await qbtJson('/api/v2/sync/maindata')).server_state.alltime_dl as number;
    if (state().baselineDl === undefined) save({ baselineDl: dl });   // first run only: the engine's lifetime counter before any torrent
  });

  test('Ubuntu Server LTS ISO -> Local (admin); Debian netinst -> Google Drive (admin) and -> B2 (normal user)', async ({ browser }) => {
    const ubuntu = SMALL ? undefined : await ubuntuLts();
    const debian = await debianNetinst();
    save({ ...(ubuntu ? { ubuntu: { name: ubuntu.name, sha256: ubuntu.sha256 } } : {}), debian: { name: debian.name, sha256: debian.sha256 } });

    const actx = await browser.newContext();
    const a = await actx.newPage();
    await login(a, 'admin');
    const uctx = await browser.newContext();
    const p = await uctx.newPage();
    await login(p, 'user');
    // idempotent: a job recorded in the state file that still exists is kept (a re-run does not add a second one)
    // `shared`: the destination is a shared one (its job folder is `<userDir>/<name> [<hash8>]`), recorded so that cleanup removes exactly it
    const add = async (page: Page, key: string, who: string, o: Official, dest: string, shared = true) => {
      const known = state().jobs[key];
      const jobs = (await api(page, 'GET', '/api/jobs')).json as { id: number; infohash: string }[];
      const live = known && jobs.find((j) => j.id === known.id);
      if (live) { if (shared) await recordRunFolder(page, live.id); return { id: live.id, infohash: live.infohash }; }
      const r = await addTorrent(page, o, dest);
      expect(r.status).toBe(201);
      save({ jobs: { ...state().jobs, [key]: { id: r.id, user: who } }, hashes: { ...((state().hashes as object) ?? {}), [key.startsWith('ubuntu') ? 'ubuntu' : 'debian']: r.infohash } });
      if (shared) await recordRunFolder(page, r.id);
      return r;
    };
    if (SMALL) {   // keep the small ISO mid-download for the limit and restart specs (spec 07 lifts this)
      expect((await api(a, 'PUT', '/api/admin/engine/settings', { downloadLimitKBps: SMALL_LIMIT_KBPS })).status).toBe(200);
    } else {
      await add(a, 'ubuntu', 'admin', ubuntu!, 'live-local');
    }
    const d1 = await add(a, 'debianDrive', 'admin', debian, 'live-gdrive');
    const d2 = await add(p, 'debianB2', 'user', debian, 'live-b2', false);
    // a third destination for the same torrent, from a second normal user (one job per user and torrent)
    const u2ctx = await browser.newContext();
    const p2 = await u2ctx.newPage();
    await login(p2, 'user2');
    const d3 = await add(p2, 'debianLocal', 'user2', debian, 'live-local');
    expect(d3.infohash).toBe(d1.infohash);
    await u2ctx.close();
    expect(d2.infohash).toBe(d1.infohash);
    expect(d2.id).not.toBe(d1.id);
    const u = { id: (SMALL ? state().jobs.debianDrive! : state().jobs.ubuntu!).id };

    // same torrent, two destinations => one download in the engine
    // (on a re-run the download may already be done and gone from the engine: then at most one is acceptable)
    const jobState = async () => ((await api(a, 'GET', '/api/jobs')).json as { id: number; state: string }[]).find((j) => j.id === d1.id)?.state;
    await expect.poll(async () => {
      const n = (await qbtJson<{ hash: string }[]>('/api/v2/torrents/info')).filter((t) => t.hash === d1.infohash).length;
      return n === 1 || (n === 0 && (await jobState()) !== 'downloading');
    }, { timeout: 60_000 }).toBe(true);
    await expect(jobRow(a, u.id)).toBeVisible();
    await expect(jobRow(p, d2.id)).toBeVisible();
    await actx.close(); await uctx.close();
  });
});
