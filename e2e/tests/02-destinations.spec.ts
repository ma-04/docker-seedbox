import { expect, test } from '@playwright/test';
import { DEST, api } from '../lib/app';
import { env } from '../lib/env';
import { userPage } from '../lib/app';

test.describe('2. admin destinations (UI)', () => {
  test('admin creates a shared Local and a shared S3 (MinIO) destination; Test shows OK', async ({ browser }, testInfo) => {
    const { page, close } = await userPage(browser, testInfo, 'admin');
    await page.getByRole('link', { name: 'Destinations' }).click();
    await expect(page.getByRole('heading', { name: 'Shared destinations' })).toBeVisible();

    // --- local
    await page.getByRole('button', { name: 'Add shared destination' }).click();
    let form = page.getByRole('form', { name: 'New destination' });
    await form.getByLabel('Name').fill(DEST.local);
    await form.getByLabel('Type').selectOption('local');
    await form.getByRole('button', { name: 'Create destination' }).click();
    const localRow = page.getByTestId('destination-row').filter({ hasText: DEST.local });
    await expect(localRow).toBeVisible();
    await localRow.getByRole('button', { name: 'Test' }).click();
    await expect(localRow.getByTestId('test-result')).toContainText('OK');

    // --- s3 (MinIO)
    await page.getByRole('button', { name: 'Add shared destination' }).click();
    form = page.getByRole('form', { name: 'New destination' });
    await form.getByLabel('Name').fill(DEST.s3);
    await form.getByLabel('Type').selectOption('s3');
    await form.getByLabel('Endpoint').fill('http://minio:9000');
    await form.getByLabel('Region').fill('us-east-1');
    await form.getByLabel('Bucket').fill('seedbox-e2e');
    await form.getByLabel('Prefix').fill('e2e');
    await form.getByLabel('Access key ID').fill(env.minioUser);
    await form.getByLabel('Secret access key').fill(env.minioPassword);
    await form.getByLabel('Force path style').check();
    await form.getByRole('button', { name: 'Create destination' }).click();
    const s3Row = page.getByTestId('destination-row').filter({ hasText: DEST.s3 });
    await expect(s3Row).toBeVisible();
    await s3Row.getByRole('button', { name: 'Test' }).click();
    await expect(s3Row.getByTestId('test-result')).toContainText('OK');

    // secrets are masked in the API
    const list = await api(page, 'GET', '/api/admin/destinations');
    const s3 = (list.json as any[]).find((d) => d.name === DEST.s3);
    expect(s3.config.secretAccessKey).toBe('********');
    expect(list.text).not.toContain(env.minioPassword);

    // users see both as shared destinations in the add form
    await close();
  });

  test('a normal user sees the shared destinations (read-only) and can pick them', async ({ browser }, testInfo) => {
    const { page, close } = await userPage(browser, testInfo, 'alice');
    const select = page.getByTestId('destination-select');
    await expect(select.locator('option', { hasText: `${DEST.local} (shared)` })).toHaveCount(1);
    await expect(select.locator('option', { hasText: `${DEST.s3} (shared)` })).toHaveCount(1);
    await page.getByRole('link', { name: 'Storage' }).click();
    await expect(page.getByTestId('destination-row').filter({ hasText: DEST.local })).toContainText('read-only');
    await close();
  });
});
