import { expect, test } from '@playwright/test';
import { DEST, addJob, api, ensureDestination, expectJobState, jobRow, purgeJobs, staysTrue, userPage } from '../lib/app';
import { getManifest, probe, qbtTorrents, wgConfig } from '../lib/infra';

test.describe.configure({ mode: 'serial' });

const DIRECT = 'http://172.31.251.20/';    // "the internet": reachable only outside the tunnel
const BEHIND = 'http://172.31.252.20/';    // reachable only through a WireGuard server
const TRACKER = 'http://172.31.250.30:6969/healthz';   // on the LAN (LAN_CIDRS)

test.describe('8. VPN', () => {
  let keys: string[] = [];
  const status = (page: import('@playwright/test').Page) => api(page, 'GET', '/api/admin/vpn/status').then((r) => r.json);

  test('admin uploads two WireGuard configs and requires the VPN; status shows connected', async ({ browser }, testInfo) => {
    const { page, close } = await userPage(browser, testInfo, 'admin');
    const c1 = await wgConfig('wg1');
    const c2 = await wgConfig('wg2');
    keys = [...c1.matchAll(/PrivateKey\s*=\s*(\S+)/g), ...c2.matchAll(/PrivateKey\s*=\s*(\S+)/g)].map((m) => m[1]!);
    expect(keys).toHaveLength(2);

    await page.getByRole('link', { name: 'VPN' }).click();
    const form = page.getByRole('form', { name: 'Add VPN config' });
    // config 1: file upload
    await form.getByTestId('vpn-file').setInputFiles({ name: 'e2e-wg1.conf', mimeType: 'text/plain', buffer: Buffer.from(c1) });
    await expect(form.getByTestId('vpn-text')).toHaveValue(c1);
    await expect(form.getByLabel('Config name')).toHaveValue('e2e-wg1');
    await form.getByRole('button', { name: 'Add config' }).click();
    await expect(page.getByTestId('vpn-config-row')).toHaveCount(1);
    // config 2: pasted text
    await form.getByLabel('Config name').fill('e2e-wg2');
    await form.getByTestId('vpn-text').fill(c2);
    await form.getByRole('button', { name: 'Add config' }).click();
    await expect(page.getByTestId('vpn-config-row')).toHaveCount(2);
    // the private key is never shown again
    await expect(page.locator('body')).not.toContainText(keys[0]!);
    await expect(form.getByTestId('vpn-text')).toHaveValue('');

    // mode required
    await page.getByRole('form', { name: 'VPN settings' }).getByLabel('VPN mode').selectOption('required');
    await page.getByRole('button', { name: 'Save VPN settings' }).click();
    await expect(page.getByTestId('vpn-status').getByText('connected', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('vpn-status')).toContainText('required');
    const s = await status(page);
    expect(s.connected).toBe(true);
    expect(s.mode).toBe('required');
    await close();
  });

  test('a torrent still completes in required mode (tracker and seeder are on the LAN)', async ({ browser }, testInfo) => {
    const m = await getManifest();
    const a = await userPage(browser, testInfo, 'admin');
    await ensureDestination(a.page, DEST.local, 'local', {});
    await a.close();
    const { page, close } = await userPage(browser, testInfo, 'alice');
    const added = await addJob(page, { magnet: m.single.magnet }, DEST.local);
    expect(added.status).toBe(201);
    await expectJobState(jobRow(page, added.id), 'completed', 120_000);
    await close();
  });

  test('Rotate now switches the active config; the kill switch holds from inside the qbittorrent container', async ({ browser }, testInfo) => {
    const { page, close } = await userPage(browser, testInfo, 'admin');
    await page.goto('/admin/vpn');
    const before = await status(page);
    const exitIp = (s: any) => s.publicIp as string | null;
    await expect.poll(async () => exitIp(await status(page)), { timeout: 30_000 }).toMatch(/^172\.31\.252\.1[12]$/);
    const first = exitIp(await status(page))!;

    await page.getByRole('button', { name: 'Rotate now' }).click();
    await expect.poll(async () => { const s = await status(page); return s.connected && s.name !== before.name ? exitIp(s) : null; }, { timeout: 60_000 }).toMatch(/^172\.31\.252\.1[12]$/);
    const second = exitIp(await status(page))!;
    expect(second).not.toBe(first);
    await expect(page.getByTestId('vpn-config-row').filter({ hasText: 'active' })).toHaveCount(1);

    // outside LAN_CIDRS: direct host unreachable, through-tunnel echo reachable (and it sees the WireGuard server)
    const direct = await probe(DIRECT);
    expect(direct.reachable, JSON.stringify(direct)).toBe(false);
    const behind = await probe(BEHIND);
    expect(behind.reachable, JSON.stringify(behind)).toBe(true);
    expect(behind.body.trim()).toBe(`behind ${second}`);
    // LAN stays reachable (tracker/seeder, and the WebUI for api/worker)
    expect((await probe(TRACKER)).status).toBe(200);
    await close();
  });

  test('with every config disabled, new torrents stay pending instead of downloading', async ({ browser }, testInfo) => {
    const m = await getManifest();
    const admin = await userPage(browser, testInfo, 'admin');
    await admin.page.goto('/admin/vpn');
    for (const n of ['e2e-wg1', 'e2e-wg2']) {
      const cb = admin.page.getByLabel(`Enabled: ${n}`);
      await cb.click();                       // controlled checkbox: the state flips after the PATCH returns
      await expect(cb).not.toBeChecked();
    }
    await expect.poll(async () => (await status(admin.page)).connected, { timeout: 30_000 }).toBe(false);
    expect((await status(admin.page)).mode).toBe('required');
    expect((await probe(BEHIND)).reachable).toBe(false);
    expect((await probe(DIRECT)).reachable).toBe(false);

    const alice = await userPage(browser, testInfo, 'alice');
    await purgeJobs(alice.page, m.slow.infohash);   // test 5 left alice a finished job for this torrent
    const added = await addJob(alice.page, { magnet: m.slow.magnet }, DEST.local);
    expect(added.status).toBe(201);
    const row = jobRow(alice.page, added.id);
    await expect(row).toHaveAttribute('data-state', 'queued');
    await staysTrue(async () => {
      const state = await row.getAttribute('data-state');
      const inEngine = (await qbtTorrents()).some((t) => t.hash === m.slow.infohash);
      return state === 'queued' && !inEngine;
    }, 10_000, 'job queued and not in the engine while no VPN is available');

    // re-enable one config: the VPN comes up and the pending torrent proceeds
    await admin.page.getByLabel('Enabled: e2e-wg2').click();
    await expect(admin.page.getByLabel('Enabled: e2e-wg2')).toBeChecked();
    await expectJobState(row, 'completed', 180_000);
    expect((await status(admin.page)).connected).toBe(true);
    await alice.close(); await admin.close();
  });

  test('the uploaded config text is never returned by any API response', async ({ browser }, testInfo) => {
    const { page, close } = await userPage(browser, testInfo, 'admin');
    expect(keys).toHaveLength(2);
    const bodies: string[] = [];
    for (const p of ['/api/admin/vpn/configs', '/api/admin/vpn/status', '/api/admin/settings', '/api/admin/jobs', '/api/admin/users', '/api/admin/destinations', '/api/me']) {
      bodies.push((await api(page, 'GET', p)).text);
    }
    const cfgs = (await api(page, 'GET', '/api/admin/vpn/configs')).json as { id: number }[];
    const dup = await api(page, 'POST', '/api/admin/vpn/configs', { name: 'e2e-wg1', config: await wgConfig('wg1') });
    expect(dup.status).toBe(409);
    bodies.push(dup.text);
    const patch = await api(page, 'PATCH', `/api/admin/vpn/configs/${cfgs[0]!.id}`, { enabled: true });
    bodies.push(patch.text);
    for (const b of bodies) {
      for (const k of keys) expect(b).not.toContain(k);
      expect(b).not.toMatch(/PrivateKey|\[Interface\]|PublicKey/);
    }
    await close();
  });

  test('cleanup: mode off, configs deleted through the UI', async ({ browser }, testInfo) => {
    const { page, close } = await userPage(browser, testInfo, 'admin');
    await page.goto('/admin/vpn');
    await page.getByRole('form', { name: 'VPN settings' }).getByLabel('VPN mode').selectOption('off');
    await page.getByRole('button', { name: 'Save VPN settings' }).click();
    await expect.poll(async () => (await status(page)).mode).toBe('off');
    for (const n of ['e2e-wg1', 'e2e-wg2']) {
      const row = page.getByTestId('vpn-config-row').filter({ hasText: n });
      await row.getByRole('button', { name: 'Delete' }).click();
      await row.getByRole('button', { name: 'Yes, delete' }).click();
      await expect(row).toHaveCount(0);
    }
    await expect(page.getByTestId('vpn-config-row')).toHaveCount(0);
    // off mode: direct traffic is possible again
    await expect.poll(async () => (await probe(DIRECT)).reachable, { timeout: 30_000 }).toBe(true);
    await close();
  });
});
