import { expect, test } from '@playwright/test';
import { SMALL, SMALL_LIMIT_KBPS, api, ensureFreshJob, login, qbtJson, note } from './lib';

const BASE = SMALL ? SMALL_LIMIT_KBPS : 0;   // the limit the engine carries before and after this spec

test.describe.configure({ mode: 'serial' });

test.describe('5. engine settings: download limit', () => {
  test('Advanced -> a download limit is applied (speed drops), then reset', async ({ page }, testInfo) => {
    test.setTimeout(10 * 60_000);
    await login(page, 'admin');
    await ensureFreshJob(page, 'limitIso', 'debian-dvd');   // something big and still downloading
    // the engine's own global download rate (all torrents), read from inside the VPN namespace
    const speed = async (): Promise<number> => (await qbtJson('/api/v2/transfer/info')).dl_info_speed as number;
    const sample = async (n: number) => { const xs: number[] = []; for (let i = 0; i < n; i++) { xs.push(await speed()); await page.waitForTimeout(2000); } return xs; };
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    await expect.poll(speed, { timeout: 600_000, intervals: [3000], message: 'a torrent is downloading' }).toBeGreaterThan(0);
    const before = await sample(10);

    const LIMIT_KB = 16;   // far below what an unthrottled swarm gives, so the effect is visible even with a slow VPN
    await page.getByRole('link', { name: 'Settings' }).click();
    const details = page.getByTestId('engine-settings');
    await details.locator('summary').click();
    const form = details.getByRole('form', { name: 'Torrent engine settings' });
    const dl = form.getByLabel('Download limit (KB/s, 0 = unlimited)');
    await expect(dl).toHaveValue(String(BASE));
    try {
    await dl.fill(String(LIMIT_KB));
    await details.getByTestId('engine-save').click();
    await expect(details.getByText('Engine settings saved')).toBeVisible();
    await expect.poll(async () => (await qbtJson('/api/v2/app/preferences')).dl_limit).toBe(LIMIT_KB * 1024);
    await page.waitForTimeout(20_000);   // let the rate settle
    const limited = await sample(15);
    const kb = (b: number) => `${(b / 1024).toFixed(0)} KB/s`;
    note(testInfo, 'speed', `before: mean ${kb(mean(before))} max ${kb(Math.max(...before))}; limited to ${LIMIT_KB} KB/s: mean ${kb(mean(limited))} max ${kb(Math.max(...limited))}`);
    // the engine reports the limit it enforces
    expect((await qbtJson('/api/v2/transfer/info')).dl_rate_limit).toBe(LIMIT_KB * 1024);
    // libtorrent's token bucket (payload only, bursts allowed; a slow swarm overshoots a tiny limit) lets single bursts through; the sustained rate is what the limit controls
    const sorted = [...limited].sort((a, b) => a - b);
    expect(mean(limited), 'mean speed under the limit').toBeLessThan(LIMIT_KB * 1024 * 3);
    expect(sorted[Math.floor(sorted.length * 0.8)]!, '80th percentile under the limit').toBeLessThan(LIMIT_KB * 1024 * 4);
    if (mean(before) > LIMIT_KB * 1024 * 3) expect(mean(limited)).toBeLessThan(mean(before) / 2);

    } finally {   // never leave the engine throttled, whatever happened above
      await api(page, 'PUT', '/api/admin/engine/settings', { downloadLimitKBps: BASE });
    }
    // reset: back to unlimited in the engine and in the UI
    await page.reload();
    await page.getByTestId('engine-settings').locator('summary').click();
    await dl.fill(String(BASE));
    await details.getByTestId('engine-save').click();
    await expect(details.getByText('Engine settings saved')).toBeVisible();
    await expect.poll(async () => (await qbtJson('/api/v2/app/preferences')).dl_limit).toBe(BASE * 1024);
    await page.reload();
    await page.getByTestId('engine-settings').locator('summary').click();
    await expect(page.getByTestId('engine-settings').getByLabel('Download limit (KB/s, 0 = unlimited)')).toHaveValue(String(BASE));
    const after = await sample(10);
    note(testInfo, "speed", `after reset: max ${Math.round(Math.max(...after) / 1024)} KB/s`);
  });
});
