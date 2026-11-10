import { expect, test } from '@playwright/test';
import { DEST, addJob, api, ensureDestination, expectJobState, jobRow, userPage } from '../lib/app';
import { getManifest, restartServices } from '../lib/infra';

test.describe.configure({ mode: 'serial' });

async function startSlow(browser: import('@playwright/test').Browser, testInfo: import('@playwright/test').TestInfo) {
  const m = await getManifest();
  const a = await userPage(browser, testInfo, 'admin');
  await ensureDestination(a.page, DEST.local, 'local', {});
  await a.close();
  const u = await userPage(browser, testInfo, 'bob');
  // earlier scenarios left a finished job for this torrent; adding it again would just return that job
  for (const j of (await api(u.page, 'GET', '/api/jobs')).json as { id: number; infohash: string; state: string }[]) {
    if (j.infohash === m.slow.infohash) await api(u.page, 'DELETE', `/api/jobs/${j.id}`);
  }
  const added = await addJob(u.page, { magnet: m.slow.magnet }, DEST.local);
  expect(added.status).toBe(201);
  const row = jobRow(u.page, added.id);
  await expectJobState(row, 'downloading', 60_000);
  await expect(row).toContainText(/Downloading [1-9]\d?%/, { timeout: 60_000 });
  return { ...u, row, id: added.id };
}

test.describe('10. restart resilience', () => {
  test('docker restart worker + api mid-download: the job still completes', async ({ browser }, testInfo) => {
    const j = await startSlow(browser, testInfo);
    await restartServices('worker', 'api');
    await expect.poll(async () => (await api(j.page, 'GET', `/api/jobs/${j.id}`)).status, { timeout: 60_000 }).toBe(200);
    await expectJobState(jobRow(j.page, j.id), 'completed', 180_000);
    await j.close();
  });

  test('restarting vpn + qbittorrent (namespace recreated) mid-download: the worker tolerates the gap and resumes', async ({ browser }, testInfo) => {
    const j = await startSlow(browser, testInfo);
    await restartServices('vpn', 'qbittorrent');   // what `compose restart vpn` does through depends_on.restart
    await expectJobState(jobRow(j.page, j.id), 'completed', 240_000);
    await j.close();
  });
});
