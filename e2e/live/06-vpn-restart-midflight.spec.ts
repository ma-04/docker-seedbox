import { expect, test } from '@playwright/test';
import { api, compose, ensureFreshJob, inQbt, login, mask, serverEgressIp, state, note } from './lib';

test.describe.configure({ mode: 'serial' });

test.describe('6a. `compose restart vpn` mid-download', () => {
  test('the namespace is fail-closed until the VPN is back, then the download resumes', async ({ page }, testInfo) => {
    test.setTimeout(15 * 60_000);
    await login(page, 'admin');
    const jobId = await ensureFreshJob(page, 'restartIso', 'ubuntu-desktop');   // fresh, big, mid-download
    const progress = async () => ((await api(page, 'GET', '/api/jobs')).json as { id: number; downloadProgress: number; state: string }[]).find((j) => j.id === jobId)!;
    const own = await serverEgressIp();
    await expect.poll(async () => (await progress()).downloadProgress, { timeout: 120_000, intervals: [3000] }).toBeGreaterThan(0.01);
    const p0 = await progress();
    expect(p0.state).toBe('downloading');

    // Restart and sample from inside the namespace while it comes back. `compose restart vpn` also restarts qbittorrent
    // (depends_on restart: true); a sample only counts when `docker exec` itself worked, i.e. the namespace was up.
    let restartDone = false;
    const restart = compose('restart vpn').then((r) => { restartDone = true; return r; });
    const tunnelled: string[] = [];
    let blockedWhileUp = 0; let unavailable = 0;
    for (let i = 0; i < 90 && !(restartDone && tunnelled.length >= 2); i++) {
      const r = await inQbt('curl -4 -sS -m 3 https://api.ipify.org');
      if (r.err.includes('Error response from daemon') || /is not running|is restarting|No such container/.test(r.err + r.out)) unavailable++;
      else if (r.code === 0 && r.out.trim()) tunnelled.push(r.out.trim());
      else blockedWhileUp++;
    }
    expect((await restart).code).toBe(0);
    expect(tunnelled, 'a sample showed the server\'s own IP: the kill switch leaked').not.toContain(own);
    expect(blockedWhileUp, 'expected at least one sample with the namespace up and the tunnel not yet connected (fail-closed)').toBeGreaterThan(0);
    note(testInfo, 'killswitch', `${blockedWhileUp} blocked while up, ${unavailable} namespace unavailable, ${tunnelled.length} tunnelled; server IP ${mask(own)} never seen`);

    await expect.poll(async () => (await api(page, 'GET', '/api/admin/vpn/status')).json.connected, { timeout: 180_000, intervals: [3000] }).toBe(true);
    const after = (await api(page, 'GET', '/api/admin/vpn/status')).json;
    expect(after.mode).toBe('required');
    expect(after.publicIp).not.toBe(own);
    // the download picks up again
    await expect.poll(async () => { const p = await progress(); return (p.state === 'downloading' && p.downloadProgress > p0.downloadProgress) || (p.state !== 'downloading' && p.state !== 'failed' && p.downloadProgress > p0.downloadProgress); }, { timeout: 300_000, intervals: [5000] }).toBe(true);
  });
});
