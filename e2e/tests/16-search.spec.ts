import { expect, test, type Page } from '@playwright/test';
import { DEST, api, ensureDestination, expectJobState, jobRow, purgeJobs, userPage } from '../lib/app';
import { env } from '../lib/env';
import { getManifest, probe, qbtTorrents, wgConfig } from '../lib/infra';
import { raw } from '../lib/net';

// Torrent search end to end: the real API, gateway, Jackett (in the VPN namespace) and UI against a mock indexer that is
// reachable ONLY through a WireGuard server (203.0.113.40), through to the torrent running in qBittorrent.
test.describe.configure({ mode: 'serial' });
test.skip(!env.search, 'torrent search is off in this stack (e2e/run.sh --search off): see tests/17');

const QUERY = 'e2e search';
const seen = async (): Promise<string[]> => JSON.parse((await raw(`${env.indexerURL}/seen`)).body.toString('utf8'));
const search = async (page: Page, q: string, cat = 'all') => {
  await page.goto('/search');
  await page.getByTestId('search-input').fill(q);
  await page.getByTestId('search-category').selectOption(cat);
  const [resp] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/search' && r.request().method() === 'GET', { timeout: 90_000 }),
    page.getByTestId('search-submit').click(),
  ]);
  return resp;
};
const row = (page: Page, title: string) => page.getByTestId('search-row').filter({ has: page.getByTestId('search-title').getByText(title, { exact: true }) });

test.describe('16. torrent search (Jackett in the VPN namespace)', () => {
  test('admin: the tunnel is up (the indexer is only reachable through it)', async ({ browser }, testInfo) => {
    const { page, close } = await userPage(browser, testInfo, 'admin');
    const configs = (await api(page, 'GET', '/api/admin/vpn/configs')).json as { name: string }[];
    for (const n of ['e2e-search-wg1', 'e2e-search-wg2'] as const) {
      if (!configs.some((c) => c.name === n)) {
        const r = await api(page, 'POST', '/api/admin/vpn/configs', { name: n, config: await wgConfig(n.endsWith('1') ? 'wg1' : 'wg2') });
        expect(r.status, r.text).toBe(201);
      }
    }
    expect((await api(page, 'PUT', '/api/admin/settings', { 'vpn.mode': 'required' })).status).toBe(200);
    await expect.poll(async () => (await api(page, 'GET', '/api/admin/vpn/status')).json.connected, { timeout: 90_000 }).toBe(true);
    // Jackett shares qBittorrent's namespace, but not its loopback rights: qBittorrent's uid cannot open Jackett's port
    // (nor FlareSolverr's), and Jackett is reachable for the api (status card below).
    expect((await probe('http://127.0.0.1:9117/jackett/UI/Login')).reachable).toBe(false);
    await close();
  });

  test('admin: Jackett UI through /jackett/ (admins only), the mock indexer configured there; status card', async ({ browser }, testInfo) => {
    const { page, close } = await userPage(browser, testInfo, 'admin');
    // Jackett's own login dance (TestCookie, Jackett cookie) runs through the API passthrough and ends on its dashboard.
    await page.goto('/jackett/');
    await expect(page).toHaveURL(/\/jackett\/UI\/Dashboard/, { timeout: 30_000 });
    await expect(page.locator('body')).toContainText(/Jackett/i);
    const cookies = await page.context().cookies();
    expect(cookies.some((c) => c.name === 'Jackett' && c.path === '/jackett')).toBe(true);
    // Configure the mock indexer (custom Cardigann definition) with Jackett's own UI API, same-origin.
    const configured = await page.evaluate(async () => {
      const cfg = await (await fetch('/jackett/api/v2.0/indexers/sbmock/config')).json();
      const r = await fetch('/jackett/api/v2.0/indexers/sbmock/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg) });
      return r.status;
    });
    expect(configured).toBeLessThan(300);
    // Jackett's API key never reaches the browser (its UI would show it and put it into every link).
    const keyCheck = await page.evaluate(async () => (await (await fetch('/jackett/api/v2.0/server/config')).json()).api_key);
    expect(keyCheck).toBe('');
    const dash = await page.goto('/jackett/UI/Dashboard');
    expect(dash!.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
    // A write without a same-origin Origin is refused by the passthrough.
    const ctx = page.context();
    const cross = await ctx.request.post(`${env.baseURL}/jackett/api/v2.0/indexers/sbmock/config`, { headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, data: '[]' });
    expect(cross.status()).toBe(403);

    await page.goto('/admin/search');
    const card = page.getByTestId('search-status');
    await expect(card.getByTestId('search-reachable')).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId('search-status-configured-indexers')).toHaveText('1');
    await expect(card.getByTestId('search-status-flaresolverr')).toHaveText('not enabled');
    await expect(card.getByTestId('jackett-link')).toHaveAttribute('href', '/jackett/');
    await close();
  });

  test('a regular user cannot reach Jackett or the admin search settings', async ({ browser }, testInfo) => {
    const { page, close } = await userPage(browser, testInfo, 'bob');
    expect((await api(page, 'GET', '/jackett/UI/Dashboard')).status).toBe(403);
    expect((await api(page, 'GET', '/api/admin/search')).status).toBe(403);
    expect((await api(page, 'PUT', '/api/admin/search', { disabledCategories: [] })).status).toBe(403);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Search' })).toBeVisible();
    await close();
  });

  test('user: search -> results (XXX hidden by default), sortable; the query went through the tunnel', async ({ browser }, testInfo) => {
    const { page, close } = await userPage(browser, testInfo, 'alice');
    const before = (await seen()).length;
    const resp = await search(page, QUERY);
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    const text = JSON.stringify(body);
    expect(text).not.toContain('jackett_apikey');
    expect(text).not.toContain('/jackett/dl');
    expect(text).not.toContain('magnet:');
    const titles = (body.results as { title: string }[]).map((r) => r.title).sort();
    expect(titles).toEqual(['E2E Search Audiobook Sample', 'E2E Search External Link', 'E2E Search Multi Pack', 'E2E Search Single File', 'E2E Search Slow File']);
    await expect(page.getByTestId('search-row')).toHaveCount(5);
    await expect(page.getByTestId('search-category').locator('option', { hasText: 'XXX' })).toHaveCount(0);
    await expect(row(page, 'E2E Search Audiobook Sample')).toHaveAttribute('data-category', 'audiobooks');
    // default order: seeders, most first; then by size, biggest first
    await expect(page.getByTestId('search-title').first()).toHaveText('E2E Search Slow File');
    await page.getByTestId('sort-size').click();
    await expect(page.getByTestId('search-title').first()).toHaveText('E2E Search Slow File');
    await page.getByTestId('sort-size').click();
    await expect(page.getByTestId('search-title').first()).toHaveText('E2E Search External Link');
    // the indexer saw the query arrive from a WireGuard server (203.0.113.0/24), never from the real address
    const after = await seen();
    expect(after.length).toBeGreaterThan(before);
    for (const ip of after) expect(ip, 'every request to the indexer came through the tunnel').toMatch(/^(::ffff:)?203\.0\.113\.1[12]$/);
    // empty state
    await search(page, 'nothing matches this zz');
    await expect(page.getByTestId('search-empty')).toBeVisible();
    await close();
  });

  test('user: Add on a .torrent result -> destination dialog -> job -> the torrent runs in qBittorrent and completes', async ({ browser }, testInfo) => {
    const m = await getManifest();
    const a = await userPage(browser, testInfo, 'admin');
    await ensureDestination(a.page, DEST.local, 'local', {});
    await a.close();
    const { page, close } = await userPage(browser, testInfo, 'alice');
    await purgeJobs(page, m.single.infohash);
    await search(page, QUERY);
    await row(page, 'E2E Search Single File').getByTestId('search-add').click();
    const dialog = page.getByTestId('search-add-dialog');
    await expect(dialog).toBeVisible();
    const dest = dialog.getByTestId('search-destination');
    await dest.selectOption({ label: await dest.locator('option', { hasText: DEST.local }).first().innerText() });
    const [resp] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === '/api/search/add'),
      dialog.getByTestId('search-add-confirm').click(),
    ]);
    expect([200, 201]).toContain(resp.status());
    const job = await resp.json();
    expect(job.infohash).toBe(m.single.infohash);   // fetched through Jackett's /dl/, strictly validated
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await qbtTorrents()).some((t) => t.hash === m.single.infohash) || (await api(page, 'GET', `/api/jobs/${job.id}`)).json.state === 'completed', { timeout: 90_000 }).toBe(true);
    await page.goto('/');
    await expectJobState(jobRow(page, job.id), 'completed', 120_000);
    await close();
  });

  test('user: a result whose link redirects to a magnet is added as that magnet; an external link is refused', async ({ browser }, testInfo) => {
    const m = await getManifest();
    const { page, close } = await userPage(browser, testInfo, 'alice');
    await purgeJobs(page, m.multi.infohash);
    await search(page, QUERY);
    await row(page, 'E2E Search Multi Pack').getByTestId('search-add').click();
    let dialog = page.getByTestId('search-add-dialog');
    const dest = dialog.getByTestId('search-destination');
    await dest.selectOption({ label: await dest.locator('option', { hasText: DEST.local }).first().innerText() });
    const [resp] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === '/api/search/add'),
      dialog.getByTestId('search-add-confirm').click(),
    ]);
    expect([200, 201]).toContain(resp.status());
    expect((await resp.json()).infohash).toBe(m.multi.infohash);

    await row(page, 'E2E Search External Link').getByTestId('search-add').click();
    dialog = page.getByTestId('search-add-dialog');
    const [bad] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === '/api/search/add'),
      dialog.getByTestId('search-add-confirm').click(),
    ]);
    expect(bad.status()).toBeGreaterThanOrEqual(400);
    await expect(dialog.getByRole('alert')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await close();
  });

  test('a result token is bound to its user', async ({ browser }, testInfo) => {
    const alice = await userPage(browser, testInfo, 'alice');
    const res = await api(alice.page, 'GET', `/api/search?q=${encodeURIComponent(QUERY)}`);
    const token = (res.json.results as { token: string }[])[0]!.token;
    await alice.close();
    const bob = await userPage(browser, testInfo, 'bob');
    const destId = ((await api(bob.page, 'GET', '/api/destinations')).json as { id: number }[])[0]?.id ?? 1;
    const r = await api(bob.page, 'POST', '/api/search/add', { token, destinationId: destId });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('search_token');
    await bob.close();
  });

  test('admin enables XXX: it becomes a category and its results appear; then off again', async ({ browser }, testInfo) => {
    const a = await userPage(browser, testInfo, 'admin');
    await a.page.goto('/admin/search');
    const cats = a.page.getByTestId('search-categories');
    await cats.getByLabel('XXX').check();
    await cats.getByTestId('search-categories-save').click();
    await expect.poll(async () => (await api(a.page, 'GET', '/api/admin/search')).json.categories.find((c: { id: string }) => c.id === 'xxx').enabled).toBe(true);
    const u = await userPage(browser, testInfo, 'alice');
    const r = await search(u.page, 'adult sample', 'xxx');
    expect((await r.json()).results.map((x: { title: string }) => x.title)).toEqual(['E2E Search Adult Sample']);
    expect((await api(a.page, 'PUT', '/api/admin/search', { disabledCategories: ['xxx'] })).status).toBe(200);
    expect((await api(u.page, 'GET', '/api/search?q=adult%20sample&cat=xxx')).status).toBe(400);
    await u.close();
    await a.close();
  });

  test('cleanup: VPN mode off, the search VPN configs deleted', async ({ browser }, testInfo) => {
    const { page, close } = await userPage(browser, testInfo, 'admin');
    expect((await api(page, 'PUT', '/api/admin/settings', { 'vpn.mode': 'off' })).status).toBe(200);
    // VPN off: search is paused (tracker sites would see the server's own address) until an admin opts in
    const paused = await api(page, 'GET', `/api/search?q=${encodeURIComponent(QUERY)}`);
    expect(paused.status).toBe(503);
    expect(paused.json.error.code).toBe('search_vpn_off');
    await page.goto('/admin/search');
    await expect(page.getByTestId('search-vpn-off')).toBeVisible();
    for (const c of (await api(page, 'GET', '/api/admin/vpn/configs')).json as { id: number; name: string }[]) {
      if (c.name.startsWith('e2e-search-')) expect((await api(page, 'DELETE', `/api/admin/vpn/configs/${c.id}`)).status).toBe(204);
    }
    await close();
  });
});
