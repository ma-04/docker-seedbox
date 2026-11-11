import { expect, test } from '@playwright/test';
import { DEST, addJob, api, ensureDestination, expectJobState, jobRow, purgeJobs, s3Config, userPage } from '../lib/app';
import { env } from '../lib/env';
import { getManifest, probe, startWorker, stopWorker, restartServices, webuiFromSibling, wgConfig } from '../lib/infra';
import { raw } from '../lib/net';

test.describe.configure({ mode: 'serial' });

test.describe('11. hardening', () => {
  test('a normal user cannot create an S3 destination that points at the compose network or a private address', async ({ browser }, testInfo) => {
    const { page, close } = await userPage(browser, testInfo, 'alice');
    const endpoints = ['http://vpn:8000', 'https://vpn:8000', 'http://minio:9000', 'https://10.0.0.5', 'https://172.31.250.2:8000', 'https://169.254.169.254', 'https://127.0.0.1:9000', 'https://[::1]:9000'];
    for (const endpoint of endpoints) {
      const r = await api(page, 'POST', '/api/destinations', { name: 'e2e-ssrf', type: 's3', config: s3Config({ endpoint }) });
      expect(r.status, `${endpoint}: ${r.text}`).toBe(400);
    }
    const list = (await api(page, 'GET', '/api/destinations')).json as { name: string }[];
    expect(list.some((d) => d.name === 'e2e-ssrf')).toBe(false);
    await close();
  });

  test('a non-GET API call without X-Requested-With is refused with 403', async ({ browser }, testInfo) => {
    const { context, close } = await userPage(browser, testInfo, 'alice');
    const cookie = (await context.cookies()).filter((c) => c.domain.endsWith('seedbox.test')).map((c) => `${c.name}=${c.value}`).join('; ');
    const post = (headers: Record<string, string>) => raw(`${env.baseURL}/api/jobs`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers }, body: '{}' });
    const noHeader = await post({});
    expect(noHeader.status, noHeader.body.toString()).toBe(403);
    expect(await post({ 'x-requested-with': 'XMLHttpRequest' })).toMatchObject({ status: 403 });
    // with the header the request gets past the CSRF check (an empty body is then a validation error, not a 403)
    expect((await post({ 'x-requested-with': 'seedbox' })).status).toBe(400);
    expect((await raw(`${env.baseURL}/api/jobs`, { headers: { cookie } })).status).toBe(200);   // reads need no header
    await close();
  });

  test('a local download link stops working (404) once its job is deleted', async ({ browser }, testInfo) => {
    const m = await getManifest();
    const a = await userPage(browser, testInfo, 'admin');
    await ensureDestination(a.page, DEST.local, 'local', {});
    await a.close();
    const { page, close } = await userPage(browser, testInfo, 'alice');
    await purgeJobs(page, m.single.infohash);
    const added = await addJob(page, { magnet: m.single.magnet }, DEST.local);
    expect(added.status).toBe(201);
    const row = jobRow(page, added.id);
    await expectJobState(row, 'completed', 120_000);
    await row.getByTestId('job-files').click();
    const link = row.getByTestId('file-link');
    await expect(link).toHaveCount(1);
    const href = (await link.getAttribute('href'))!;
    const ok = await raw(href);
    expect(ok.status).toBe(200);
    expect((await api(page, 'DELETE', `/api/jobs/${added.id}`)).status).toBe(204);
    const gone = await raw(href);
    expect(gone.status, gone.body.toString().slice(0, 200)).toBe(404);
    await close();
  });

  test('qBittorrent WebUI refuses an ordinary container on the compose network (not api/worker)', async () => {
    for (const path of ['/api/v2/app/version', '/api/v2/torrents/info', '/api/v2/app/preferences']) {
      const r = await webuiFromSibling(path);
      expect(r.reachable, JSON.stringify(r)).toBe(true);       // the port is reachable, the request is refused
      expect(r.status, `${path}: ${r.body}`).toBe(403);
    }
  });

  test('after the vpn sidecar restarts (before the worker reconciles) the qBittorrent namespace is still fail-closed in required mode', async ({ browser }, testInfo) => {
    test.setTimeout(240_000);
    const DIRECT = 'http://198.51.100.20/';
    const TRACKER = 'http://172.31.250.30:6969/healthz';
    const { page, close } = await userPage(browser, testInfo, 'admin');
    const status = () => api(page, 'GET', '/api/admin/vpn/status').then((r) => r.json);
    // precondition: required mode with an enabled config (from scenario 8, or created here)
    let cfgs = (await api(page, 'GET', '/api/admin/vpn/configs')).json as { id: number; enabled: boolean }[];
    if (!cfgs.some((c) => c.enabled)) {
      if (!cfgs.length) expect((await api(page, 'POST', '/api/admin/vpn/configs', { name: 'e2e-hardening', config: await wgConfig('wg1') })).status).toBe(201);
      cfgs = (await api(page, 'GET', '/api/admin/vpn/configs')).json;
      expect((await api(page, 'PATCH', `/api/admin/vpn/configs/${cfgs[0]!.id}`, { enabled: true })).status).toBe(200);
    }
    expect((await api(page, 'PUT', '/api/admin/settings', { 'vpn.mode': 'required' })).status).toBe(200);
    await expect.poll(async () => (await status()).connected, { timeout: 60_000 }).toBe(true);

    await stopWorker();            // nothing may reconcile the fresh sidecar during the observation
    try {
      await restartServices('vpn', 'qbittorrent');
      // the namespace is up again: the LAN works from inside it (so the probe below is not vacuous) ...
      await expect.poll(async () => (await probe(TRACKER)).status, { timeout: 90_000 }).toBe(200);
      // ... a fresh sidecar has no tunnel, yet nothing outside LAN_CIDRS is reachable
      const s = await status();
      expect(s.mode).toBe('required');
      expect(s.connected).toBe(false);
      const direct = await probe(DIRECT);
      expect(direct.reachable, JSON.stringify(direct)).toBe(false);
      expect((await probe('http://203.0.113.20/')).reachable).toBe(false);
    } finally {
      await startWorker();
    }
    // the worker reconnects the tunnel on its own
    await expect.poll(async () => (await status()).connected, { timeout: 120_000 }).toBe(true);
    expect((await probe(DIRECT)).reachable).toBe(false);
    await close();
  });
});
