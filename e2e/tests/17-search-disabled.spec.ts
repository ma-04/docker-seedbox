import { expect, test } from '@playwright/test';
import { api, userPage } from '../lib/app';
import { env } from '../lib/env';

// The stack without torrent search (e2e/run.sh --search off, no SEARCH_BACKEND): the app works unchanged, the UI hides
// search, and every search route answers a clear 404.
test.skip(env.search, 'torrent search is on in this stack: see tests/16');

test.describe('17. torrent search switched off', () => {
  test('users see no Search page; the API answers 404 search_disabled', async ({ browser }, testInfo) => {
    const { page, close } = await userPage(browser, testInfo, 'alice');
    expect((await api(page, 'GET', '/api/me')).json.searchEnabled).toBe(false);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Search' })).toHaveCount(0);
    await page.goto('/search');
    await expect(page).toHaveURL(`${env.baseURL}/`);
    await expect(page.getByTestId('add-form')).toBeVisible();
    for (const [m, u, b] of [['GET', '/api/search?q=anything', undefined], ['GET', '/api/search/meta', undefined], ['POST', '/api/search/add', { token: 'x', destinationId: 1 }]] as const) {
      const r = await api(page, m, u, b);
      expect(r.status, u).toBe(404);
      expect(r.json.error.code, u).toBe('search_disabled');
    }
    await close();
  });

  test('admins: /jackett/ is a 404 and Admin -> Search says how to enable it', async ({ browser }, testInfo) => {
    const { page, close } = await userPage(browser, testInfo, 'admin');
    const r = await api(page, 'GET', '/jackett/UI/Dashboard');
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('search_disabled');
    expect((await api(page, 'GET', '/api/admin/search')).json).toMatchObject({ enabled: false, backend: null, uiPath: null });
    await page.goto('/admin/search');
    await expect(page.getByTestId('search-off')).toContainText('./setup.sh --search');
    await close();
  });
});
