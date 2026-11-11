import { expect, test } from '@playwright/test';
import { api, userPage } from '../lib/app';
import { qbtPreferences } from '../lib/infra';

test.describe.configure({ mode: 'serial' });

test.describe('9. admin', () => {
  test('engine settings open, show values, and a saved download limit is read back from qBittorrent', async ({ browser }, testInfo) => {
    const { page, close } = await userPage(browser, testInfo, 'admin');
    await page.getByRole('link', { name: 'Settings' }).click();
    const details = page.getByTestId('engine-settings');
    await details.locator('summary').click();
    const form = details.getByRole('form', { name: 'Torrent engine settings' });
    const dl = form.getByLabel('Download limit (KB/s, 0 = unlimited)');
    await expect(dl).toHaveValue('0');
    await expect(form.getByLabel('Listen port (1024-65535)')).not.toHaveValue('');
    await expect(form.getByLabel('DHT (distributed hash table)')).toBeVisible();

    await dl.fill('123');
    await details.getByTestId('engine-save').click();
    await expect(details.getByText('Engine settings saved')).toBeVisible();
    await expect.poll(async () => (await qbtPreferences()).dl_limit).toBe(123 * 1024);
    expect((await api(page, 'GET', '/api/admin/engine/settings')).json.downloadLimitKBps).toBe(123);

    // persists across a reload
    await page.reload();
    await page.getByTestId('engine-settings').locator('summary').click();
    await expect(page.getByTestId('engine-settings').getByLabel('Download limit (KB/s, 0 = unlimited)')).toHaveValue('123');

    // unknown / out-of-whitelist keys are refused by the API
    expect((await api(page, 'PUT', '/api/admin/engine/settings', { save_path: '/etc' })).status).toBe(400);

    // restore
    await page.getByTestId('engine-settings').getByLabel('Download limit (KB/s, 0 = unlimited)').fill('0');
    await page.getByTestId('engine-save').click();
    await expect.poll(async () => (await qbtPreferences()).dl_limit).toBe(0);
    await close();
  });

  test('random listen port round-trips through qBittorrent (listen_port 0) and can be switched off again', async ({ browser }, testInfo) => {
    const { page, close } = await userPage(browser, testInfo, 'admin');
    await page.getByRole('link', { name: 'Settings' }).click();
    const open = async () => {
      const details = page.getByTestId('engine-settings');
      if (!(await details.evaluate((d) => (d as HTMLDetailsElement).open))) await details.locator('summary').click();
      return details.getByRole('form', { name: 'Torrent engine settings' });
    };
    let form = await open();
    const random = form.getByLabel('Use a random listen port');
    const port = form.getByLabel('Listen port (1024-65535)');
    if (await random.isChecked()) { await random.uncheck(); await form.getByTestId('engine-save').click(); await expect(page.getByText('Engine settings saved')).toBeVisible(); }
    await expect(port).toBeEnabled();

    await random.check();
    await expect(port).toBeDisabled();
    await form.getByTestId('engine-save').click();
    await expect(page.getByText('Engine settings saved')).toBeVisible();
    await expect.poll(async () => (await qbtPreferences()).listen_port).toBe(0);
    expect((await api(page, 'GET', '/api/admin/engine/settings')).json).toMatchObject({ randomPort: true, listenPort: 0 });

    await page.reload();
    form = await open();
    await expect(form.getByLabel('Use a random listen port')).toBeChecked();
    await expect(form.getByLabel('Listen port (1024-65535)')).toBeDisabled();

    await form.getByLabel('Use a random listen port').uncheck();
    await expect(form.getByLabel('Listen port (1024-65535)')).toBeEnabled();
    await expect(form.getByLabel('Listen port (1024-65535)')).toHaveValue('6881');
    await form.getByTestId('engine-save').click();
    await expect(page.getByText('Engine settings saved')).toBeVisible();
    await expect.poll(async () => (await qbtPreferences()).listen_port).toBe(6881);
    expect((await api(page, 'GET', '/api/admin/engine/settings')).json).toMatchObject({ randomPort: false, listenPort: 6881 });
    await close();
  });

  test('a disabled user is blocked and can be re-enabled', async ({ browser }, testInfo) => {
    const admin = await userPage(browser, testInfo, 'admin');
    const carol = await userPage(browser, testInfo, 'carol');
    await admin.page.goto('/admin/users');
    const row = admin.page.getByTestId('user-row').filter({ hasText: 'carol' });
    await expect(row).toBeVisible();
    await row.getByLabel('Disabled: carol').click();
    await expect(row.getByLabel('Disabled: carol')).toBeChecked();
    await expect(admin.page.getByText('Updated carol')).toBeVisible();
    expect((await api(carol.page, 'GET', '/api/me')).status).toBe(403);
    expect((await api(carol.page, 'GET', '/api/jobs')).status).toBe(403);
    await carol.page.reload();
    await expect(carol.page.getByTestId('current-user')).toHaveCount(0);

    await row.getByLabel('Disabled: carol').click();
    await expect(row.getByLabel('Disabled: carol')).not.toBeChecked();
    await expect.poll(async () => (await api(carol.page, 'GET', '/api/me')).status).toBe(200);
    // an admin cannot disable themself
    const self = admin.page.getByTestId('user-row').filter({ hasText: /^admin/ });
    await self.getByLabel('Disabled: admin').click();
    await expect(admin.page.getByText(/cannot disable your own account/i)).toBeVisible();
    await carol.close(); await admin.close();
  });
});
