import { expect, test } from '@playwright/test';
import { DEST, addJob, api, destinationId, ensureDestination, expectJobState, jobRow, s3Config, userPage } from '../lib/app';
import { env } from '../lib/env';
import { getManifest, hashOfMagnet, qbtTorrents, stalledMagnet } from '../lib/infra';

test.describe('6. cancel and retry', () => {
  test('cancel while downloading stops the job and removes the torrent from the engine', async ({ browser }, testInfo) => {
    const a = await userPage(browser, testInfo, 'admin');
    await ensureDestination(a.page, DEST.local, 'local', {});
    await a.close();
    const { page, close } = await userPage(browser, testInfo, 'alice');
    const magnet = stalledMagnet('cancel');
    const added = await addJob(page, { magnet }, DEST.local);
    expect(added.status).toBe(201);
    const row = jobRow(page, added.id);
    await expectJobState(row, 'downloading', 30_000);
    await expect.poll(async () => (await qbtTorrents()).some((t) => t.hash === hashOfMagnet(magnet)), { timeout: 20_000 }).toBe(true);

    await row.getByRole('button', { name: 'Cancel' }).click();
    await expectJobState(row, 'cancelled', 20_000);
    await expect.poll(async () => (await qbtTorrents()).some((t) => t.hash === hashOfMagnet(magnet)), { timeout: 30_000 }).toBe(false);

    // a cancelled job can be removed
    await row.getByRole('button', { name: 'Remove' }).click();
    await expect(row).toHaveCount(0);
    await close();
  });

  test('a failed job (S3 with wrong credentials) can be fixed and retried to completion', async ({ browser }, testInfo) => {
    const m = await getManifest();
    const a = await userPage(browser, testInfo, 'admin');
    const bad = await ensureDestination(a.page, DEST.s3bad, 's3', s3Config({ secretAccessKey: 'definitely-wrong-secret' }));
    const { page, close } = await userPage(browser, testInfo, 'alice');

    const added = await addJob(page, { magnet: m.single.magnet }, DEST.s3bad);
    expect(added.status).toBe(201);
    const row = jobRow(page, added.id);
    await expectJobState(row, 'failed', 120_000);
    await expect(row.getByRole('alert')).not.toBeEmpty();
    expect(JSON.stringify((await api(page, 'GET', `/api/jobs/${added.id}`)).json)).not.toContain('definitely-wrong-secret');

    // admin fixes the destination (through the API; the edit form is covered by unit tests)
    const fix = await api(a.page, 'PATCH', `/api/admin/destinations/${bad}`, { config: { secretAccessKey: env.minioPassword } });
    expect(fix.status, fix.text).toBe(200);

    await row.getByRole('button', { name: 'Retry' }).click();
    await expectJobState(row, 'completed', 150_000);
    await row.getByTestId('job-files').click();
    await expect(row.getByTestId('file-link')).toHaveCount(1);
    expect(await destinationId(a.page, DEST.s3bad)).toBe(bad);
    await a.close(); await close();
  });
});
