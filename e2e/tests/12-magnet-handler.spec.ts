import { expect, test, type Page } from '@playwright/test';
import { DEST, PORTAL_URL, api, ensureDestination, expectJobState, jobRow, purgeJobs, submitLogin, userPage } from '../lib/app';
import { env } from '../lib/env';
import { getManifest, hashOfMagnet } from '../lib/infra';

test.describe.configure({ mode: 'serial' });

const HASH = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';

const jobsFor = async (page: Page, infohash: string) =>
  ((await api(page, 'GET', '/api/jobs')).json as { id: number; infohash: string }[]).filter((j) => j.infohash === infohash);

test.describe('12. magnet: protocol handler target (/add)', () => {
  test.beforeAll(async ({ browser }, testInfo) => {
    const a = await userPage(browser, testInfo, 'admin');
    await ensureDestination(a.page, DEST.local, 'local', {});
    await a.close();
  });

  test('logged out: /add?magnet= survives the Authelia round trip, pre-fills (no auto-submit), then Add completes the job', async ({ browser }, testInfo) => {
    const m = await getManifest();
    const magnet = m.single.magnet;
    const hash = hashOfMagnet(magnet);
    const prep = await userPage(browser, testInfo, 'alice');
    await purgeJobs(prep.page, hash);
    await prep.close();

    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: env.baseURL });
    const page = await ctx.newPage();
    try {
      await page.goto(`/add?magnet=${encodeURIComponent(magnet)}`);
      await expect(page).toHaveURL(PORTAL_URL);
      // the original URL travels in `rd`, URL-encoded exactly once: one decode gives back /add?magnet=<single-encoded magnet>
      const rd = new URL(page.url()).searchParams.get('rd');
      expect(rd, 'rd parameter').toBeTruthy();
      const back = new URL(rd!);
      expect(back.origin).toBe(env.baseURL);
      expect(back.pathname).toBe('/add');
      expect(back.searchParams.get('magnet')).toBe(magnet);

      await submitLogin(page, 'alice');

      await expect(page.getByTestId('current-user')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('magnet-input')).toHaveValue(magnet);
      await expect(page.getByTestId('magnet-prefill')).toBeVisible();
      await expect(page.getByTestId('destination-select')).toBeFocused();
      // the magnet left the address bar
      await expect(page).toHaveURL(`${env.baseURL}/`);
      // nothing was submitted
      expect(await jobsFor(page, hash)).toHaveLength(0);

      const select = page.getByTestId('destination-select');
      await expect(select.locator('option', { hasText: DEST.local })).toHaveCount(1);
      await select.selectOption({ label: await select.locator('option', { hasText: DEST.local }).first().innerText() });
      const [resp] = await Promise.all([
        page.waitForResponse((r) => new URL(r.url()).pathname === '/api/jobs' && r.request().method() === 'POST'),
        page.getByTestId('add-submit').click(),
      ]);
      expect(resp.status()).toBe(201);
      const id = (await resp.json()).id as number;
      await expectJobState(jobRow(page, id), 'completed', 120_000);
    } finally {
      await ctx.close();
    }
  });

  test('a reload after pre-filling does not pre-fill again', async ({ browser }, testInfo) => {
    const m = await getManifest();
    const { page, close } = await userPage(browser, testInfo, 'alice');
    await purgeJobs(page, hashOfMagnet(m.multi.magnet));
    await page.goto(`/add?magnet=${encodeURIComponent(m.multi.magnet)}`);
    await expect(page.getByTestId('magnet-input')).toHaveValue(m.multi.magnet);
    await expect(page).toHaveURL(`${env.baseURL}/`);
    await page.reload();
    await expect(page.getByTestId('add-form')).toBeVisible();
    await expect(page.getByTestId('magnet-input')).toHaveValue('');
    expect(await jobsFor(page, hashOfMagnet(m.multi.magnet))).toHaveLength(0);
    await close();
  });

  for (const [label, value] of [
    ['malformed (no info hash)', 'magnet:?dn=nothing'],
    ['short info hash', `magnet:?xt=urn:btih:${HASH.slice(5)}`],
    ['javascript: URL', 'javascript:alert(document.domain)'],
    ['https: URL', `https://example.com/?xt=urn:btih:${HASH}`],
    ['data: URL', 'data:text/html,<script>alert(1)</script>'],
  ] as const) {
    test(`rejected: ${label} -> inline error, form empty, nothing submitted`, async ({ browser }, testInfo) => {
      const { page, close } = await userPage(browser, testInfo, 'alice');
      const before = ((await api(page, 'GET', '/api/jobs')).json as unknown[]).length;
      let dialog = false;
      page.on('dialog', (d) => { dialog = true; void d.dismiss(); });
      await page.goto(`/add?magnet=${encodeURIComponent(value)}`);
      await expect(page.getByTestId('magnet-error')).toBeVisible();
      await expect(page.getByTestId('magnet-input')).toHaveValue('');
      await expect(page.getByTestId('magnet-prefill')).toHaveCount(0);
      await expect(page).toHaveURL(`${env.baseURL}/`);
      // the raw value is never rendered as a link
      await expect(page.locator('a[href^="javascript:"], a[href^="data:"]')).toHaveCount(0);
      expect(dialog).toBe(false);
      expect(((await api(page, 'GET', '/api/jobs')).json as unknown[]).length).toBe(before);
      await close();
    });
  }

  test('a missing magnet parameter shows the error and does not break the page', async ({ browser }, testInfo) => {
    const { page, close } = await userPage(browser, testInfo, 'alice');
    await page.goto('/add');
    await expect(page.getByTestId('magnet-error')).toBeVisible();
    await expect(page.getByTestId('magnet-input')).toHaveValue('');
    await close();
  });

  test('the dn= display name is shown as text, never as markup', async ({ browser }, testInfo) => {
    const { page, close } = await userPage(browser, testInfo, 'alice');
    const evil = `magnet:?xt=urn:btih:${HASH}&dn=${encodeURIComponent('<img src=x onerror=alert(1)> Name')}`;
    await page.goto(`/add?magnet=${encodeURIComponent(evil)}`);
    await expect(page.getByTestId('magnet-prefill-name')).toHaveText('<img src=x onerror=alert(1)> Name');
    await expect(page.getByTestId('magnet-prefill').locator('img')).toHaveCount(0);
    await expect(page.getByTestId('magnet-input')).toHaveValue(evil);
    await close();
  });

  test('the web manifest is served behind login with the right type and a magnet protocol handler', async ({ browser }, testInfo) => {
    const { page, close } = await userPage(browser, testInfo, 'alice');
    const r = await page.evaluate(async () => {
      const res = await fetch('/manifest.webmanifest', { credentials: 'same-origin' });
      return { status: res.status, type: res.headers.get('content-type'), json: await res.json() };
    });
    expect(r.status).toBe(200);
    expect(r.type).toContain('application/manifest+json');
    expect(r.json.protocol_handlers).toEqual([{ protocol: 'magnet', url: '/add?magnet=%s' }]);
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('crossorigin', 'use-credentials');
    await close();
  });
});
