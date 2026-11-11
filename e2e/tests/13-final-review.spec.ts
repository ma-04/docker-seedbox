import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { DEST, addJob, api, ensureDestination, expectJobState, jobRow, purgeJobs, staysTrue, userPage } from '../lib/app';
import { env } from '../lib/env';
import { getManifest, qbtTorrents } from '../lib/infra';
import { raw } from '../lib/net';

test.describe.configure({ mode: 'serial' });

const randomHash = (tag: string): string => createHash('sha1').update(`${tag}-${randomBytes(8).toString('hex')}`).digest('hex');

/** Files of the local library as seen by the gateway container (control service, read-only). */
async function libraryFiles(): Promise<string[]> {
  const r = await raw(`${env.ctlURL}/library`, { headers: { authorization: `Bearer ${env.ctlToken}` } });
  expect(r.status, r.body.toString()).toBe(200);
  return (JSON.parse(r.body.toString('utf8')) as { files: string[] }).files;
}

test.describe('13. final review fixes', () => {
  test.beforeAll(async ({ browser }, testInfo) => {
    const a = await userPage(browser, testInfo, 'admin');
    await ensureDestination(a.page, DEST.local, 'local', {});
    await a.close();
  });

  test('a magnet with a newline-injected URL/extra magnet is rejected (400) and qBittorrent still holds exactly the expected torrents', async ({ browser }, testInfo) => {
    const { page, close } = await userPage(browser, testInfo, 'alice');
    const dest = ((await api(page, 'GET', '/api/destinations')).json as { id: number; name: string }[]).find((d) => d.name === DEST.local)!.id;
    const before = (await qbtTorrents()).map((t) => t.hash.toLowerCase()).sort();
    const a = randomHash('inject-a');
    const b = randomHash('inject-b');
    // The attack: qBittorrent splits `urls` on newlines, so the second line would be fetched from inside its namespace and
    // the third would add a torrent that no job tracks (bypassing every limit).
    const attack = `magnet:?xt=urn:btih:${a}&dn=x\nhttp://172.31.250.30:6969/healthz\nmagnet:?xt=urn:btih:${b}`;
    for (const magnet of [attack, attack.replace(/\n/g, '\r\n'), `magnet:?xt=urn:btih:${a}&dn=x\u2028y`, `magnet:?xt=urn:btih:${a}&dn=x y`]) {
      const r = await api(page, 'POST', '/api/jobs', { magnet, destinationId: dest });
      expect(r.status, r.text).toBe(400);
    }
    const jobs = (await api(page, 'GET', '/api/jobs')).json as { infohash: string }[];
    expect(jobs.some((j) => j.infohash === a || j.infohash === b)).toBe(false);
    await staysTrue(async () => JSON.stringify((await qbtTorrents()).map((t) => t.hash.toLowerCase()).sort()) === JSON.stringify(before), 8000, 'qBittorrent torrent list unchanged after the rejected magnets');

    // The same payload percent-encoded inside dn is just a (sanitised) name: exactly ONE torrent is added, never the second one.
    const enc = `magnet:?xt=urn:btih:${a}&dn=${encodeURIComponent('x\nhttp://172.31.250.30:6969/healthz\nmagnet:?xt=urn:btih:' + b)}&ws=${encodeURIComponent('http://172.31.250.30:6969/healthz')}`;
    const ok = await api(page, 'POST', '/api/jobs', { magnet: enc, destinationId: dest });
    expect(ok.status, ok.text).toBe(201);
    try {
      await expect.poll(async () => (await qbtTorrents()).some((t) => t.hash.toLowerCase() === a), { timeout: 60_000 }).toBe(true);
      const allowed = new Set([...before, a]);
      await staysTrue(async () => {
        const now = (await qbtTorrents()).map((t) => t.hash.toLowerCase());
        return !now.includes(b) && now.every((h) => allowed.has(h)); // nothing but the one submitted torrent was added
      }, 8000, 'only the one submitted torrent was added to qBittorrent');
    } finally {
      await api(page, 'DELETE', `/api/jobs/${ok.json.id}`);
      await api(page, 'DELETE', `/api/jobs/${ok.json.id}`); // second call: it was only cancelled the first time
      await close();
    }
  });

  test('removing a completed local job asks what happens to the files, deletes them from the library, and its download link then 404s', async ({ browser }, testInfo) => {
    const m = await getManifest();
    const tag = `[${m.single.infohash.slice(0, 8)}]`;
    const { page, close } = await userPage(browser, testInfo, 'alice');
    await purgeJobs(page, m.single.infohash);
    const added = await addJob(page, { magnet: m.single.magnet }, DEST.local);
    expect(added.status).toBe(201);
    const row = jobRow(page, added.id);
    await expectJobState(row, 'completed', 120_000);
    await row.getByTestId('job-files').click();
    const href = (await row.getByTestId('file-link').first().getAttribute('href'))!;
    expect((await raw(href)).status).toBe(200);
    expect((await libraryFiles()).some((f) => f.includes(tag)), 'files are in the library before removal').toBe(true);

    // The UI says what will happen (local: deleted) and only acts after the explicit confirmation.
    await row.getByRole('button', { name: 'Remove' }).click();
    await expect(row.getByTestId('confirm-description')).toContainText('deleted from the server');
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Yes, remove' }).click();
    await expect(row).toHaveCount(0);

    await expect.poll(async () => (await libraryFiles()).some((f) => f.includes(tag)), { timeout: 60_000, message: 'worker deletes the delivered files' }).toBe(false);
    const gone = await raw(href);
    expect(gone.status, gone.body.toString().slice(0, 200)).toBe(404);
    await close();
  });

  // Not covered here: "a user-owned S3 destination whose endpoint redirects to an internal address cannot reach it". That needs a
  // redirecting HTTPS endpoint with a publicly routable name inside the compose network, which the hermetic fixtures cannot provide
  // (user-owned endpoints must be https + public, and the guard refuses every fixture address). The behaviour is covered by
  // apps/api/src/worker/egress-proxy.test.ts, which drives the real rclone binary against a redirecting local "S3".
});
