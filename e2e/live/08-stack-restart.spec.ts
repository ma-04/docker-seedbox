import { expect, test } from '@playwright/test';
import tls from 'node:tls';
import { live } from './env';
import { api, compose, fetchHash, jobRow, login, state } from './lib';

test.describe.configure({ mode: 'serial' });

const serial = (host: string): Promise<string> => new Promise((resolve, reject) => {
  const s = tls.connect({ host, port: 443, servername: host }, () => { const c = s.getPeerCertificate(); s.end(); resolve(c.serialNumber); });
  s.on('error', reject);
});

test.describe('8. reboot-style restart: compose down && up -d', () => {
  test('stack healthy again, jobs and links intact, the VPN reconnects by itself, certificates are kept', async ({ page, browser }) => {
    test.setTimeout(20 * 60_000);
    const before = await serial(live.domain);
    const d = await compose('down');
    expect(d.code, d.err).toBe(0);
    const up = await compose('up -d --wait --wait-timeout 300', 400_000);
    expect(up.code, up.err).toBe(0);

    await expect.poll(async () => (await fetch(`${live.baseURL}/healthz`).then((r) => r.status).catch(() => 0)), { timeout: 120_000, intervals: [3000] }).toBe(200);
    const ps = await compose('ps --format "{{.Service}}|{{.State}}|{{.Health}}"');
    for (const line of ps.out.trim().split('\n').filter(Boolean)) {
      const [svc, st, health] = line.split('|');
      if (st === 'exited') continue;   // one-shot init
      expect([st, health || 'healthy'], svc).toEqual(['running', 'healthy']);
    }
    expect(await serial(live.domain), 'the certificate is kept, not re-issued').toBe(before);

    await login(page, 'admin');
    // the VPN reconnects without any manual action and the mode is still required
    await expect.poll(async () => (await api(page, 'GET', '/api/admin/vpn/status')).json.connected, { timeout: 180_000, intervals: [3000] }).toBe(true);
    const s = (await api(page, 'GET', '/api/admin/vpn/status')).json;
    expect(s.mode).toBe('required');
    expect(s.publicIp).toBeTruthy();

    // jobs intact in the UI, links still work
    const j = state().jobs;
    await page.goto('/');
    if (j.ubuntu) await expect(jobRow(page, j.ubuntu.id)).toHaveAttribute('data-state', 'completed');
    await expect(jobRow(page, j.debianDrive!.id)).toHaveAttribute('data-state', 'completed');
    if (j.ubuntu) {
      const files = (await api(page, 'GET', `/api/jobs/${j.ubuntu.id}/files`)).json.files as { path: string; url: string }[];
      expect((await fetchHash(files[0]!.url, { Range: 'bytes=0-99' })).status).toBe(206);
    }
    const dfiles = (await api(page, 'GET', `/api/jobs/${j.debianDrive!.id}/files`)).json.files as { path: string; url: string }[];
    expect((await fetchHash(dfiles[0]!.url, { Range: 'bytes=0-99' })).status).toBe(206);
    const ctx = await browser.newContext(); const u = await ctx.newPage(); await login(u, 'user');
    await u.goto('/');
    await expect(jobRow(u, j.debianB2!.id)).toHaveAttribute('data-state', 'completed');
    await ctx.close();
  });
});
