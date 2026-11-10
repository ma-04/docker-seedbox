import { expect, test } from '@playwright/test';
import { DEST, addJob, ensureDestination, expectJobState, jobRow, s3Config, userPage } from '../lib/app';
import { env } from '../lib/env';
import { getManifest, sha256 } from '../lib/infra';
import { raw } from '../lib/net';

test('4. single file by magnet -> S3 (MinIO) -> presigned link returns the right bytes', async ({ browser }, testInfo) => {
  const m = await getManifest();
  const a = await userPage(browser, testInfo, 'admin');
  await ensureDestination(a.page, DEST.s3, 's3', s3Config());
  await a.close();

  const { page, close } = await userPage(browser, testInfo, 'bob');
  const added = await addJob(page, { magnet: m.single.magnet }, DEST.s3);
  expect(added.status).toBe(201);
  const row = jobRow(page, added.id);
  await expectJobState(row, 'completed', 120_000);
  await row.getByTestId('job-files').click();
  const link = row.getByTestId('file-link');
  await expect(link).toHaveCount(1);
  const href = (await link.getAttribute('href'))!;

  // The API presigns for the in-network endpoint (http://minio:9000); the TLS front exposes the same MinIO as
  // s3.seedbox.test and forwards with Host: minio:9000, so the signature stays valid.
  const u = new URL(href);
  expect(u.searchParams.get('X-Amz-Signature')).toBeTruthy();
  const key = decodeURIComponent(u.pathname);                       // /<bucket>/<prefix>/<user dir>/<torrent dir>/<file>
  expect(key.startsWith('/seedbox-e2e/e2e/')).toBe(true);
  expect(key).toContain('bob');
  expect(key).toContain('Single File.bin');
  expect(key.endsWith('/Single File.bin')).toBe(true);
  const r = await raw(`${env.s3URL}${u.pathname}${u.search}`);
  expect(r.status).toBe(200);
  expect(sha256(r.body)).toBe(m.single.files[0]!.sha256);

  // tampering with the presigned URL is refused by MinIO
  const bad = new URL(`${env.s3URL}${u.pathname}${u.search}`);
  bad.searchParams.set('X-Amz-Signature', '0'.repeat(64));
  expect((await raw(bad.toString())).status).toBe(403);
  // the object is not world-readable without the signature
  expect((await raw(`${env.s3URL}${u.pathname}`)).status).toBe(403);
  await close();
});
