import { expect, test } from '@playwright/test';
import { DEST, addJob, api, ensureDestination, expectJobState, jobRow, purgeJobs, userPage } from '../lib/app';
import { getManifest, restartServices } from '../lib/infra';

test.describe.configure({ mode: 'serial' });

// Each test gets its own torrent: re-adding one whose data was just delivered completes at once without downloading.
async function startSlow(browser: import('@playwright/test').Browser, testInfo: import('@playwright/test').TestInfo, which: 'slow2' | 'slow3') {
  const t = (await getManifest())[which];
  const a = await userPage(browser, testInfo, 'admin');
  await ensureDestination(a.page, DEST.local, 'local', {});
  await a.close();
  const u = await userPage(browser, testInfo, 'bob');
  await purgeJobs(u.page, t.infohash);
  const added = await addJob(u.page, { magnet: t.magnet }, DEST.local);
  expect(added.status).toBe(201);
  const row = jobRow(u.page, added.id);
  await expectJobState(row, 'downloading', 60_000);
  await expect(row).toContainText(/Downloading [1-9]\d?%/, { timeout: 60_000 });
  return { ...u, row, id: added.id };
}

test.describe('10. restart resilience', () => {
  test('docker restart worker + api mid-download: the job still completes', async ({ browser }, testInfo) => {
    const j = await startSlow(browser, testInfo, 'slow2');
    await restartServices('worker', 'api');
    await expect.poll(async () => (await api(j.page, 'GET', `/api/jobs/${j.id}`)).status, { timeout: 60_000 }).toBe(200);
    await expectJobState(jobRow(j.page, j.id), 'completed', 180_000);
    await j.close();
  });

  test('restarting vpn + qbittorrent (namespace recreated) mid-download: the worker tolerates the gap and resumes', async ({ browser }, testInfo) => {
    const j = await startSlow(browser, testInfo, 'slow3');
    await restartServices('vpn', 'qbittorrent');   // what `compose restart vpn` does through depends_on.restart
    await expectJobState(jobRow(j.page, j.id), 'completed', 240_000);
    await j.close();
  });
});
