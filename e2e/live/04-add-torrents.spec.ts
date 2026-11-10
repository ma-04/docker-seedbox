import { expect, test, type Page } from '@playwright/test';
import { api, debianNetinst, jobRow, login, qbtJson, save, state, ubuntuLts, type Official } from './lib';

test.describe.configure({ mode: 'serial' });

// Only official, legal Linux distribution torrents: the current Ubuntu Server LTS ISO and the Debian netinst ISO.
async function addTorrent(page: Page, o: Official, destination: string): Promise<{ id: number; infohash: string; status: number }> {
  await page.goto('/');
  const form = page.getByTestId('add-form');
  await expect(form).toBeVisible();
  await page.getByTestId('torrent-file').setInputFiles({ name: `${o.name}.torrent`, mimeType: 'application/x-bittorrent', buffer: o.torrent });
  const select = page.getByTestId('destination-select');
  const opt = select.locator('option', { hasText: destination });
  await expect(opt).toHaveCount(1);
  await select.selectOption({ label: await opt.first().innerText() });
  const [resp] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/jobs' && r.request().method() === 'POST'),
    page.getByTestId('add-submit').click(),
  ]);
  const body = await resp.json();
  return { id: body.id, infohash: body.infohash, status: resp.status() };
}

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
    const ubuntu = await ubuntuLts();
    const debian = await debianNetinst();
    save({ ubuntu: { name: ubuntu.name, sha256: ubuntu.sha256 }, debian: { name: debian.name, sha256: debian.sha256 } });

    const actx = await browser.newContext();
    const a = await actx.newPage();
    await login(a, 'admin');
    const uctx = await browser.newContext();
    const p = await uctx.newPage();
    await login(p, 'user');
    // idempotent: a job recorded in the state file that still exists is kept (a re-run does not add a second one)
    const add = async (page: Page, key: string, who: string, o: Official, dest: string) => {
      const known = state().jobs[key];
      const jobs = (await api(page, 'GET', '/api/jobs')).json as { id: number; infohash: string }[];
      const live = known && jobs.find((j) => j.id === known.id);
      if (live) return { id: live.id, infohash: live.infohash };
      const r = await addTorrent(page, o, dest);
      expect(r.status).toBe(201);
      save({ jobs: { ...state().jobs, [key]: { id: r.id, user: who } }, hashes: { ...((state().hashes as object) ?? {}), [key.startsWith('ubuntu') ? 'ubuntu' : 'debian']: r.infohash } });
      return r;
    };
    await add(a, 'ubuntu', 'admin', ubuntu, 'live-local');
    const d1 = await add(a, 'debianDrive', 'admin', debian, 'live-gdrive');
    const d2 = await add(p, 'debianB2', 'user', debian, 'live-b2');
    expect(d2.infohash).toBe(d1.infohash);
    expect(d2.id).not.toBe(d1.id);
    const u = { id: state().jobs.ubuntu!.id };

    // same torrent, two destinations => one download in the engine
    await expect.poll(async () => (await qbtJson<{ hash: string }[]>('/api/v2/torrents/info')).filter((t) => t.hash === d1.infohash).length, { timeout: 60_000 }).toBe(1);
    await expect(jobRow(a, u.id)).toBeVisible();
    await expect(jobRow(p, d2.id)).toBeVisible();
    await actx.close(); await uctx.close();
  });
});
