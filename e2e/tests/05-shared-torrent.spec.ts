import { expect, test } from '@playwright/test';
import { DEST, addJob, api, ensureDestination, expectJobState, jobRow, userPage } from '../lib/app';
import { getManifest, qbtTorrents } from '../lib/infra';

test('5. two users add the same torrent: one download, both complete, strict per-user isolation', async ({ browser }, testInfo) => {
  const m = await getManifest();
  const a = await userPage(browser, testInfo, 'admin');
  await ensureDestination(a.page, DEST.local, 'local', {});
  const alice = await userPage(browser, testInfo, 'alice');
  const bob = await userPage(browser, testInfo, 'bob');

  const ja = await addJob(alice.page, { magnet: m.slow.magnet }, DEST.local);
  const jb = await addJob(bob.page, { magnet: m.slow.magnet }, DEST.local);
  expect(ja.status).toBe(201);
  expect(jb.status).toBe(201);
  expect(ja.id).not.toBe(jb.id);
  expect(ja.body.infohash).toBe(jb.body.infohash);

  // exactly one torrent in the engine for that infohash (one download shared by both jobs)
  await expect.poll(async () => (await qbtTorrents()).filter((t) => t.hash === m.slow.infohash).length, { timeout: 30_000 }).toBe(1);
  expect((await qbtTorrents()).filter((t) => t.hash === m.slow.infohash)).toHaveLength(1);

  // isolation: each user lists only their own job; the other's job and files are 404
  const aliceJobs = (await api(alice.page, 'GET', '/api/jobs')).json as { id: number }[];
  const bobJobs = (await api(bob.page, 'GET', '/api/jobs')).json as { id: number }[];
  expect(aliceJobs.map((j) => j.id)).toContain(ja.id);
  expect(aliceJobs.map((j) => j.id)).not.toContain(jb.id);
  expect(bobJobs.map((j) => j.id)).toContain(jb.id);
  expect(bobJobs.map((j) => j.id)).not.toContain(ja.id);
  expect((await api(bob.page, 'GET', `/api/jobs/${ja.id}`)).status).toBe(404);
  expect((await api(bob.page, 'GET', `/api/jobs/${ja.id}/files`)).status).toBe(404);
  expect((await api(bob.page, 'DELETE', `/api/jobs/${ja.id}`)).status).toBe(404);
  expect((await api(bob.page, 'POST', `/api/jobs/${ja.id}/retry`)).status).toBe(404);
  await expect(jobRow(alice.page, jb.id)).toHaveCount(0);
  await expect(jobRow(bob.page, ja.id)).toHaveCount(0);

  await expectJobState(jobRow(alice.page, ja.id), 'completed', 150_000);
  await expectJobState(jobRow(bob.page, jb.id), 'completed', 150_000);

  // after completion bob still cannot fetch alice's files, and each user's links point at their own folder
  const fa = (await api(alice.page, 'GET', `/api/jobs/${ja.id}/files`)).json.files as { url: string }[];
  const fb = (await api(bob.page, 'GET', `/api/jobs/${jb.id}/files`)).json.files as { url: string }[];
  expect(decodeURIComponent(new URL(fa[0]!.url).pathname)).toContain('alice');
  expect(decodeURIComponent(new URL(fb[0]!.url).pathname)).toContain('bob');
  expect((await api(bob.page, 'GET', `/api/jobs/${ja.id}/files`)).status).toBe(404);

  // the admin sees both
  const all = (await api(a.page, 'GET', '/api/admin/jobs')).json as { id: number; infohash: string }[];
  expect(all.filter((j) => j.infohash === m.slow.infohash).map((j) => j.id)).toEqual(expect.arrayContaining([ja.id, jb.id]));
  await a.page.goto('/admin/jobs');
  await expect(a.page.locator(`[data-testid="admin-job-row"][data-job-id="${ja.id}"]`)).toBeVisible();
  await a.close(); await alice.close(); await bob.close();
});
