import { expect, type Browser, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import path from 'node:path';
import { env, type UserName } from './env';

export const AUTH_DIR = path.resolve('.out/auth');
export const statePath = (u: UserName): string => path.join(AUTH_DIR, `${u}.json`);

/** Real login through the Authelia portal. Leaves the page on the app. */
export async function loginUI(page: Page, user: UserName): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveURL(/auth\.seedbox\.test/);
  await page.locator('#username-textfield').fill(user);
  await page.locator('#password-textfield').fill(env.passwords[user]);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByTestId('current-user')).toBeVisible({ timeout: 30_000 });
}

export interface Api { status: number; json: any; text: string }
/** Same-origin fetch from the page (its session cookie, its browser network path). Mutations carry X-Requested-With. */
export async function api(page: Page, method: string, url: string, body?: unknown): Promise<Api> {
  if (!page.url().startsWith(env.baseURL)) await page.goto('/');
  return page.evaluate(async ({ method, url, body }) => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (method !== 'GET') headers['X-Requested-With'] = 'seedbox';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
    const text = await r.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text };
  }, { method, url, body });
}

/** A page logged in as `user` (storage state from global setup), (Playwright traces its context automatically; a screenshot is kept on failure). */
export async function userPage(browser: Browser, testInfo: TestInfo, user: UserName): Promise<{ page: Page; context: BrowserContext; close: () => Promise<void> }> {
  const context = await browser.newContext({ storageState: statePath(user), ignoreHTTPSErrors: true, baseURL: env.baseURL });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByTestId('current-user')).toBeVisible({ timeout: 30_000 });
  const close = async () => {
    if (testInfo.status !== testInfo.expectedStatus) await page.screenshot({ path: testInfo.outputPath(`${user}.png`), fullPage: true }).catch(() => {});
    await context.close();
  };
  return { page, context, close };
}

export const jobRow = (page: Page, id: number): Locator => page.locator(`[data-testid="job-row"][data-job-id="${id}"]`);
export const expectJobState = (row: Locator, state: string, timeout = 90_000) => expect(row).toHaveAttribute('data-state', state, { timeout });

/** Fill and submit the add form (UI). Resolves with the API's answer to POST /api/jobs. */
export async function addJob(page: Page, src: { magnet: string } | { torrent: { name: string; buffer: Buffer } }, destination: string): Promise<{ status: number; id: number; body: any }> {
  await page.goto('/');
  const form = page.getByTestId('add-form');
  await expect(form).toBeVisible();
  if ('magnet' in src) await page.getByTestId('magnet-input').fill(src.magnet);
  else await page.getByTestId('torrent-file').setInputFiles({ name: src.torrent.name, mimeType: 'application/x-bittorrent', buffer: src.torrent.buffer });
  const select = page.getByTestId('destination-select');
  await expect(select.locator('option', { hasText: destination })).toHaveCount(1);
  await select.selectOption({ label: await select.locator('option', { hasText: destination }).first().innerText() });
  const [resp] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/jobs' && r.request().method() === 'POST'),
    page.getByTestId('add-submit').click(),
  ]);
  const body = await resp.json().catch(() => null);
  return { status: resp.status(), id: body?.id, body };
}

// ---- idempotent admin setup (API; the destinations/VPN scenarios drive the UI separately) ---------------
export const DEST = { local: 'e2e-local', s3: 'e2e-s3', s3bad: 'e2e-s3-bad' } as const;
export const s3Config = (over: Record<string, unknown> = {}) => ({
  endpoint: 'http://minio:9000', region: 'us-east-1', bucket: 'seedbox-e2e', prefix: 'e2e',
  accessKeyId: env.minioUser, secretAccessKey: env.minioPassword, forcePathStyle: true, ...over,
});
export async function ensureDestination(admin: Page, name: string, type: 'local' | 's3', config: Record<string, unknown>): Promise<number> {
  const list = await api(admin, 'GET', '/api/admin/destinations');
  const found = (list.json as any[]).find((d) => d.name === name);
  if (found) return found.id;
  const r = await api(admin, 'POST', '/api/admin/destinations', { name, type, config, enabled: true });
  expect(r.status, r.text).toBe(201);
  return r.json.id;
}
export async function destinationId(admin: Page, name: string): Promise<number> {
  const list = await api(admin, 'GET', '/api/admin/destinations');
  const d = (list.json as any[]).find((x) => x.name === name);
  if (!d) throw new Error(`destination ${name} not found`);
  return d.id;
}

/** Poll `cond` for `ms`, failing as soon as it turns false (a bounded "stays true" observation, not a sleep). */
export async function staysTrue(cond: () => Promise<boolean>, ms: number, what: string, everyMs = 500): Promise<void> {
  const until = Date.now() + ms;
  do {
    if (!(await cond())) throw new Error(`expected to stay true for ${ms} ms, but it changed: ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  } while (Date.now() < until);
}

/** Deletes the user's earlier jobs for a torrent (adding a torrent the user already has just returns the old job). */
export async function purgeJobs(page: Page, infohash: string): Promise<void> {
  for (const j of (await api(page, 'GET', '/api/jobs')).json as { id: number; infohash: string }[]) {
    if (j.infohash === infohash) await api(page, 'DELETE', `/api/jobs/${j.id}`);
  }
}
