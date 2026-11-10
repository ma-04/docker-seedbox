import { expect, test } from '@playwright/test';
import { DEST, addJob, api, ensureDestination, expectJobState, jobRow, userPage } from '../lib/app';
import { stalledMagnet } from '../lib/infra';

test.describe.configure({ mode: 'serial' });

test.describe('7. limits', () => {
  test('the per-user active job limit gives a clear error in the UI', async ({ browser }, testInfo) => {
    const a = await userPage(browser, testInfo, 'admin');
    await ensureDestination(a.page, DEST.local, 'local', {});
    await a.page.goto('/admin/users');
    const carolRow = a.page.getByTestId('user-row').filter({ hasText: 'carol' });
    await carolRow.getByLabel('Max active jobs for carol').fill('1');
    await carolRow.getByRole('button', { name: 'Save' }).click();
    await expect(a.page.getByText('Updated carol')).toBeVisible();

    const { page, close } = await userPage(browser, testInfo, 'carol');
    const first = await addJob(page, { magnet: stalledMagnet('limit-1') }, DEST.local);
    expect(first.status).toBe(201);
    const second = await addJob(page, { magnet: stalledMagnet('limit-2') }, DEST.local);
    expect(second.status).toBe(429);
    await expect(page.getByTestId('add-form').getByRole('alert')).toContainText(/Active job limit reached \(1\)/);
    await expect(page.getByTestId('job-row')).toHaveCount(1);

    // cleanup: cancel, then lift the override
    await jobRow(page, first.id).getByRole('button', { name: 'Cancel' }).click();
    await expectJobState(jobRow(page, first.id), 'cancelled', 20_000);
    await jobRow(page, first.id).getByRole('button', { name: 'Remove' }).click();
    await a.page.reload();
    const row2 = a.page.getByTestId('user-row').filter({ hasText: 'carol' });
    await row2.getByLabel('Max active jobs for carol').fill('');
    await row2.getByRole('button', { name: 'Save' }).click();
    await expect(row2.getByLabel('Max active jobs for carol')).toHaveValue('');
    await close(); await a.close();
  });

  test('settings limits save and persist', async ({ browser }, testInfo) => {
    const { page, close } = await userPage(browser, testInfo, 'admin');
    await page.getByRole('link', { name: 'Settings' }).click();
    const form = page.getByRole('form', { name: 'Limits and seeding' });
    await expect(form.getByLabel('Max active jobs per user')).toHaveValue('5');
    await form.getByLabel('Max active jobs per user').fill('7');
    await form.getByLabel('Max torrent size (GB)').fill('3');
    await form.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Settings saved')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('form', { name: 'Limits and seeding' }).getByLabel('Max active jobs per user')).toHaveValue('7');
    const s = (await api(page, 'GET', '/api/admin/settings')).json;
    expect(s['limits.maxActiveJobsPerUser']).toBe(7);
    expect(s['limits.maxTorrentBytes']).toBe(3 * 1024 ** 3);
    // restore
    const f2 = page.getByRole('form', { name: 'Limits and seeding' });
    await f2.getByLabel('Max active jobs per user').fill('5');
    await f2.getByLabel('Max torrent size (GB)').fill('0');
    await f2.getByRole('button', { name: 'Save settings' }).click();
    await expect.poll(async () => (await api(page, 'GET', '/api/admin/settings')).json['limits.maxActiveJobsPerUser']).toBe(5);
    await close();
  });
});
