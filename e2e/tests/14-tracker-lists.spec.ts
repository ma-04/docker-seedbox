import { expect, test } from '@playwright/test';
import { DEST, addJob, api, ensureDestination, userPage } from '../lib/app';
import { getManifest, hashOfMagnet, qbtPreferences, qbtTrackers, stalledMagnet } from '../lib/infra';

// The stack runs with TRACKER_LIST_ALLOW_PRIVATE=1 + E2E_HERMETIC=1 (deploy/compose.e2e.yaml, test only): the worker may fetch
// plain-http lists from the private "front" fixture (lists.seedbox.test). Real deployments accept public https lists only.
const LIST = 'http://lists.seedbox.test/redirect.txt'; // 302 -> /trackers.txt: 8 valid trackers + 2 the tracker policy must drop
const PAGE = 'http://lists.seedbox.test/page.html';     // an HTML error page: must be rejected, the previous list kept
const FIXTURE_TRACKERS = Array.from({ length: 8 }, (_, i) => i + 1);

test.describe.configure({ mode: 'serial' });

const addedTrackers = async (): Promise<string[]> =>
  String((await qbtPreferences()).add_trackers).split('\n').map((l) => l.trim()).filter(Boolean);

test.describe('14. tracker lists', () => {
  test.afterAll(async ({ browser }, testInfo) => {
    const { page, close } = await userPage(browser, testInfo, 'admin');
    await api(page, 'PUT', '/api/admin/trackers', { urls: [] });
    await api(page, 'PUT', '/api/admin/engine/settings', { addTrackersEnabled: true, addTrackers: (await getManifest()).tracker });
    await close();
  });

  test('only admins can use the API; bad URLs are refused', async ({ browser }, testInfo) => {
    const alice = await userPage(browser, testInfo, 'alice');
    expect((await api(alice.page, 'GET', '/api/admin/trackers')).status).toBe(403);
    expect((await api(alice.page, 'PUT', '/api/admin/trackers', { urls: [LIST] })).status).toBe(403);
    expect((await api(alice.page, 'POST', '/api/admin/trackers/refresh')).status).toBe(403);
    await alice.close();
    const { page, close } = await userPage(browser, testInfo, 'admin');
    expect((await api(page, 'PUT', '/api/admin/trackers', { urls: ['https://user:pw@lists.example.org/a.txt'] })).status).toBe(400);
    expect((await api(page, 'PUT', '/api/admin/trackers', { urls: Array.from({ length: 6 }, (_, i) => `https://l${i}.example.org/a.txt`) })).status).toBe(400);
    expect((await api(page, 'PUT', '/api/admin/trackers', { refreshHours: 0 })).status).toBe(400);
    await close();
  });

  test('an admin saves a list URL: the worker fetches it, the status shows the count, qBittorrent gets manual + fetched trackers', async ({ browser }, testInfo) => {
    const m = await getManifest();
    const { page, close } = await userPage(browser, testInfo, 'admin');
    await page.getByRole('link', { name: 'Settings' }).click();
    const card = page.getByTestId('tracker-lists');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('tracker-lists-total')).toContainText('1'); // the manual LAN fixture tracker
    await expect(card.getByRole('button', { name: 'Use ngosang/trackerslist (all)' })).toBeVisible();

    await card.getByLabel(/List URLs/).fill(LIST);
    await card.getByTestId('tracker-lists-save').click();
    await expect(page.getByText('Tracker lists saved')).toBeVisible();

    const row = card.getByTestId('tracker-list-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(LIST);
    await expect(row.locator('td').nth(1)).toHaveText('8', { timeout: 60_000 }); // 2 dropped: private address, single-label host
    await expect(row).toContainText('OK');
    await expect(card.getByTestId('tracker-lists-total')).toContainText('9');

    // qBittorrent: the manual (LAN fixture) tracker first, then the fetched ones; its own "from URL" preference stays off
    await expect.poll(async () => (await addedTrackers()).length, { timeout: 30_000 }).toBe(9);
    const list = await addedTrackers();
    expect(list[0]).toBe(m.tracker);
    for (const n of FIXTURE_TRACKERS) expect(list.some((t) => t.includes(`fixture-${n}.example.org`))).toBe(true);
    expect(list.join('\n')).not.toMatch(/10\.9\.8\.7|\/\/tracker\//);
    const prefs = await qbtPreferences();
    expect(prefs.add_trackers_enabled).toBe(true);
    expect(prefs.add_trackers_from_url_enabled).toBe(false);

    // the engine settings API still reports the MANUAL list only
    expect((await api(page, 'GET', '/api/admin/engine/settings')).json).toMatchObject({ addTrackersEnabled: true, addTrackers: m.tracker });
    const dto = (await api(page, 'GET', '/api/admin/trackers')).json;
    expect(dto).toMatchObject({ manualCount: 1, effectiveCount: 9, urls: [LIST] });
    expect(dto.lists[0]).toMatchObject({ ok: true, trackerCount: 8, error: null });
    await close();
  });

  test('a torrent added afterwards carries the fetched trackers, the LAN fixture tracker among them', async ({ browser }, testInfo) => {
    const m = await getManifest();
    const admin = await userPage(browser, testInfo, 'admin');
    await ensureDestination(admin.page, DEST.local, 'local', {});
    await admin.close();
    const { page, close } = await userPage(browser, testInfo, 'alice');
    const magnet = stalledMagnet('tracker-lists');
    const added = await addJob(page, { magnet }, DEST.local);
    expect(added.status).toBe(201);
    const hash = hashOfMagnet(magnet);
    await expect.poll(async () => (await qbtTrackers(hash)).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(9);
    const trackers = await qbtTrackers(hash);
    expect(trackers).toContain(m.tracker);
    for (const n of FIXTURE_TRACKERS) expect(trackers.some((t) => t.includes(`fixture-${n}.example.org`))).toBe(true);
    for (let i = 0; i < 2; i++) await api(page, 'DELETE', `/api/jobs/${added.id}`); // first cancels, second removes
    await close();
  });

  test('a list that turns into an HTML page is rejected and the previous trackers are kept (stale-while-error)', async ({ browser }, testInfo) => {
    const { page, close } = await userPage(browser, testInfo, 'admin');
    expect((await api(page, 'PUT', '/api/admin/trackers', { urls: [LIST, PAGE] })).status).toBe(200);
    await page.goto('/admin/settings');
    const rows = page.getByTestId('tracker-lists').getByTestId('tracker-list-row');
    await expect(rows).toHaveCount(2);
    const bad = rows.filter({ hasText: PAGE });
    await expect(bad).toContainText(/web page/i, { timeout: 60_000 });
    await expect(bad.locator('td').nth(1)).toHaveText('0');
    await expect(rows.filter({ hasText: 'redirect.txt' })).toContainText('OK');
    expect((await api(page, 'GET', '/api/admin/trackers')).json).toMatchObject({ effectiveCount: 9 });
    expect((await addedTrackers()).length).toBe(9);

    // "Refresh now" is accepted (202) and the status settles again
    await page.getByTestId('tracker-lists').getByTestId('tracker-lists-refresh').click();
    await expect(page.getByText('Refresh requested')).toBeVisible();
    await expect(page.getByTestId('tracker-lists').getByTestId('tracker-lists-refresh')).toHaveText('Refresh now', { timeout: 60_000 });
    await close();
  });

  test('switching extra trackers off disables the whole mechanism; switching on restores it; clearing the URLs leaves only the manual list', async ({ browser }, testInfo) => {
    const m = await getManifest();
    const { page, close } = await userPage(browser, testInfo, 'admin');
    expect((await api(page, 'PUT', '/api/admin/engine/settings', { addTrackersEnabled: false })).status).toBe(200);
    await expect.poll(async () => (await qbtPreferences()).add_trackers_enabled, { timeout: 30_000 }).toBe(false);
    expect((await api(page, 'GET', '/api/admin/trackers')).json).toMatchObject({ enabled: false, effectiveCount: 0 });
    expect((await api(page, 'POST', '/api/admin/trackers/refresh')).status).toBe(409);

    expect((await api(page, 'PUT', '/api/admin/engine/settings', { addTrackersEnabled: true })).status).toBe(200);
    await expect.poll(async () => (await qbtPreferences()).add_trackers_enabled, { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await addedTrackers()).length, { timeout: 30_000 }).toBe(9);

    expect((await api(page, 'PUT', '/api/admin/trackers', { urls: [] })).status).toBe(200);
    await expect.poll(addedTrackers, { timeout: 30_000 }).toEqual([m.tracker]);
    await close();
  });
});
