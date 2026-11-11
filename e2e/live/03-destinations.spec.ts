import { expect, test, type Page } from '@playwright/test';
import { live } from './env';
import { api, login, rcloneSection, rcloneValue, s3Prefix, save, signingKey, state } from './lib';

test.describe.configure({ mode: 'serial' });

export const NAMES = { local: 'live-local', gdrive: 'live-gdrive', b2: 'live-b2' } as const;

async function addDestination(page: Page, name: string, fill: (form: ReturnType<Page['getByRole']>) => Promise<void>, type: string) {
  await page.goto('/admin/destinations');
  await expect(page.getByRole('heading', { name: 'Shared destinations' })).toBeVisible();
  const have = ((await api(page, 'GET', '/api/admin/destinations')).json as { name: string }[]).some((d) => d.name === name);
  if (have) return;   // idempotent re-run
  await page.getByRole('button', { name: 'Add shared destination' }).click();
  const form = page.getByRole('form', { name: 'New destination' });
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('Type').selectOption(type);
  await fill(form);
  await form.getByRole('button', { name: 'Create destination' }).click();
  const row = page.getByTestId('destination-row').filter({ hasText: name });
  await expect(row).toBeVisible();
  return row;
}
async function testOk(page: Page, name: string) {
  const row = page.getByTestId('destination-row').filter({ hasText: name });
  await row.getByRole('button', { name: 'Test' }).click();
  await expect(row.getByTestId('test-result')).toContainText('OK', { timeout: 45_000 });
}

test.describe('3. shared destinations (UI)', () => {
  test('(a) shared Local', async ({ page }) => {
    await login(page, 'admin');
    await addDestination(page, NAMES.local, async () => {}, 'local');
    await testOk(page, NAMES.local);
  });

  test('(b) shared Google Drive from a pasted rclone section, with the Worker proxy', async ({ page }) => {
    await login(page, 'admin');
    const section = rcloneSection(live.gdriveRemote());
    expect(rcloneValue(section, 'type')).toBe('drive');
    await addDestination(page, NAMES.gdrive, async (form) => {
      await form.getByLabel('Paste rclone config section').fill(section);
      await form.getByLabel('Root folder ID').fill(live.driveRootFolderId());
      await form.getByLabel('Sharing').selectOption('anyone');
      await form.getByLabel('Proxy base URL').fill(live.proxyUrl());
      await form.getByLabel('Proxy signing key').fill(signingKey());
      await form.getByLabel('Link TTL (seconds)').fill('3600');
    }, 'gdrive');
    await testOk(page, NAMES.gdrive);
  });

  test('(c) shared S3 for Backblaze B2 under the run prefix', async ({ page }) => {
    await login(page, 'admin');
    const b2 = rcloneSection(live.b2Remote());
    await addDestination(page, NAMES.b2, async (form) => {
      await form.getByLabel('Endpoint').fill(live.s3.endpoint());
      await form.getByLabel('Region').fill(live.s3.region());
      await form.getByLabel('Bucket').fill(live.s3.bucket());
      await form.getByLabel('Prefix').fill(s3Prefix());
      await form.getByLabel('Access key ID').fill(rcloneValue(b2, 'account'));
      await form.getByLabel('Secret access key').fill(rcloneValue(b2, 'key'));
      await form.getByLabel('Link TTL (seconds)').fill('3600');
    }, 's3');
    await testOk(page, NAMES.b2);
  });

  test('secrets are masked by the API; destinations are visible read-only to a normal user', async ({ page, browser }) => {
    await login(page, 'admin');
    const list = (await api(page, 'GET', '/api/admin/destinations')).json as any[];
    const ids: Record<string, number> = {};
    for (const [k, n] of Object.entries(NAMES)) { const d = list.find((x) => x.name === n); expect(d, n).toBeTruthy(); ids[k] = d.id; }
    save({ dest: ids });
    const txt = JSON.stringify(list);
    const b2 = rcloneSection(live.b2Remote());
    for (const secret of [rcloneValue(b2, 'key'), signingKey()]) expect(txt).not.toContain(secret);
    expect(txt).not.toMatch(/refresh_token|1\/\/0/);
    const ctx = await browser.newContext({ baseURL: live.baseURL });
    const p2 = await ctx.newPage();
    await login(p2, 'user');
    const select = p2.getByTestId('destination-select');
    for (const n of Object.values(NAMES)) await expect(select.locator('option', { hasText: n })).toHaveCount(1);
    await ctx.close();
    expect(state().dest.b2).toBeGreaterThan(0);
  });
});
