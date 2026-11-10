import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { live } from './env';
import { api, inQbt, login, mask, save, serverEgressIp, state, note } from './lib';

test.describe.configure({ mode: 'serial' });

// The VPN must be configured, required and connected before any torrent is added (spec 04) and stays on for the whole run.
test.describe('2. VPN', () => {
  const status = (page: import('@playwright/test').Page) => api(page, 'GET', '/api/admin/vpn/status').then((r) => r.json);

  test('admin uploads both WireGuard configs through the UI and requires the VPN', async ({ page }) => {
    await login(page, 'admin');
    await page.getByRole('link', { name: 'VPN' }).click();
    const form = page.getByRole('form', { name: 'Add VPN config' });
    const existing = ((await api(page, 'GET', '/api/admin/vpn/configs')).json as unknown[]).length;   // via the API: the table may not have rendered yet
    if (existing > 0) await expect(page.getByTestId('vpn-config-row')).toHaveCount(existing);
    const files = live.wgConfigs();
    expect(files.length).toBeGreaterThanOrEqual(2);
    if (existing === 0) {
      let n = 0;
      for (const f of files) {
        const buf = fs.readFileSync(f);
        await form.getByTestId('vpn-file').setInputFiles({ name: path.basename(f), mimeType: 'text/plain', buffer: buf });
        await expect(form.getByTestId('vpn-text')).toHaveValue(buf.toString());
        await form.getByRole('button', { name: 'Add config' }).click();
        await expect(page.getByTestId('vpn-config-row')).toHaveCount(++n);
        await expect(form.getByTestId('vpn-text')).toHaveValue('');
      }
    }
    // private keys are never shown again
    for (const f of files) for (const m of fs.readFileSync(f, 'utf8').matchAll(/PrivateKey\s*=\s*(\S+)/g)) await expect(page.locator('body')).not.toContainText(m[1]!);
    await page.getByRole('form', { name: 'VPN settings' }).getByLabel('VPN mode').selectOption('required');
    await page.getByRole('button', { name: 'Save VPN settings' }).click();
    await expect(page.getByTestId('vpn-status').getByText('connected', { exact: true }).first()).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId('vpn-status')).toContainText('required');
  });

  test('connected, with a public IP that is not the server\'s own', async ({ page }, testInfo) => {
    await login(page, 'admin');
    await expect.poll(async () => (await status(page)).publicIp, { timeout: 90_000 }).toBeTruthy();
    const s = await status(page);
    const own = await serverEgressIp();
    expect(s.connected).toBe(true);
    expect(s.mode).toBe('required');
    expect(s.publicIp).not.toBe(own);
    expect(s.publicIp).not.toBe(live.domain);
    save({ ips: { ...state().ips, server: mask(own), vpn1: mask(s.publicIp) }, activeName: s.name });
    note(testInfo, 'ips', `server ${mask(own)} vpn ${mask(s.publicIp)}`);
  });

  test('Rotate now changes the active config and the public IP', async ({ page }, testInfo) => {
    await login(page, 'admin');
    await page.goto('/admin/vpn');
    const before = await status(page);
    await page.getByRole('button', { name: 'Rotate now' }).click();
    await expect.poll(async () => { const s = await status(page); return s.connected && s.name !== before.name && s.publicIp !== before.publicIp ? s.publicIp : null; }, { timeout: 120_000, intervals: [3000] }).toBeTruthy();
    const after = await status(page);
    expect(after.name).not.toBe(before.name);
    expect(after.publicIp).not.toBe(before.publicIp);
    await expect(page.getByTestId('vpn-config-row').filter({ hasText: 'active' })).toHaveCount(1);
    save({ ips: { ...state().ips, vpn2: mask(after.publicIp) } });
    note(testInfo, 'ips', `${mask(before.publicIp)} -> ${mask(after.publicIp)}`);
  });

  test('from inside the qbittorrent container: egress is the VPN, IPv6 and non-tunnel egress are blocked', async ({ page }) => {
    await login(page, 'admin');
    const s = await status(page);
    const own = await serverEgressIp();
    const seen = await inQbt('curl -4 -fsS -m 20 https://api.ipify.org');
    expect(seen.code, seen.err).toBe(0);
    expect(seen.out.trim()).not.toBe(own);
    expect(seen.out.trim()).toBe(s.publicIp);
    // IPv6 is off in the namespace: no address, no egress
    const v6 = await inQbt('curl -6 -sS -m 8 https://api64.ipify.org');
    expect(v6.code, `IPv6 must not work, got: ${v6.out}`).not.toBe(0);
    // bypass the tunnel through the container's LAN interface (the only non-wg, non-lo one): must be dropped
    const ifs = (await inQbt("ip -o -4 addr show | awk '{print $2}' | grep -v -E '^(lo|wg.*)$' | sort -u")).out.trim().split('\n').filter(Boolean);
    expect(ifs.length).toBeGreaterThan(0);
    // positive control: binding to the tunnel interface works, so the failures below are the kill switch, not curl
    const wg = (await inQbt("ip -o link show | awk -F': ' '{print $2}' | grep -E '^wg' | head -n1")).out.trim();
    expect(wg).toBeTruthy();
    expect((await inQbt(`curl -4 -fsS -m 20 --interface ${wg} https://api.ipify.org`)).out.trim()).toBe(s.publicIp);
    for (const i of ifs) {
      const r = await inQbt(`curl -4 -sS -m 8 --interface ${i} https://api.ipify.org`);
      expect(r.code, `egress through ${i} must be blocked, got: ${r.out}`).not.toBe(0);
      const raw = await inQbt(`curl -4 -sS -m 8 --interface ${i} http://1.1.1.1/`);
      expect(raw.code, `raw egress through ${i} must be blocked`).not.toBe(0);
    }
  });
});
