import { expect, test, type Browser, type Page } from '@playwright/test';
import { live } from './env';
import { SMALL, api, fetchHash, fullHash, jobRow, login, qbtJson, rclone, s3Prefix, save, state, type Fetched } from './lib';

test.describe.configure({ mode: 'serial' });

const ST = () => state() as unknown as State2;
interface State2 { ubuntu: { name: string; sha256: string }; debian: { name: string; sha256: string }; jobs: Record<string, { id: number }>; baselineDl: number; links?: Record<string, string>; [k: string]: unknown }

async function waitCompleted(page: Page, id: number, label: string, minutes: number) {
  const row = jobRow(page, id);
  await expect.poll(async () => {
    const s = await row.getAttribute('data-state');
    if (s === 'failed' || s === 'cancelled') throw new Error(`${label} ${s}: ${await row.locator('[role=alert]').textContent().catch(() => '')}`);
    return s;
  }, { timeout: minutes * 60_000, intervals: [5000], message: `${label} completes` }).toBe('completed');
}
async function fileLinks(page: Page, id: number): Promise<{ folder: string | null; files: { path: string; size: number; url: string | null }[] }> {
  await page.goto('/');
  await jobRow(page, id).getByTestId('job-files').click();
  const region = jobRow(page, id).getByRole('region');
  await expect(region).toBeVisible();
  const r = (await api(page, 'GET', `/api/jobs/${id}/files`)).json;
  return { folder: r.folderUrl, files: r.files };
}
const tamper = (u: string) => { const x = new URL(u); const s = x.searchParams.get('sig')!; x.searchParams.set('sig', s.slice(0, -1) + (s.endsWith('0') ? '1' : '0')); return x.toString(); };

async function verifyLocal(page: Page, jobId: number, isoName: string, sha256: string) {
  const { files } = await fileLinks(page, jobId);
  const f = files.find((x) => x.path.endsWith('.iso'))!;
  expect(f, `${isoName} among the files`).toBeTruthy();
  expect(f.url, 'a signed link').toBeTruthy();
  expect(new URL(f.url!).host).toBe(new URL(live.filesURL).host);
  expect(f.size).toBeGreaterThan(5e8);
  const full = await fullHash(f.url!);
  expect(full.status).toBe(200);
  expect(full.bytes).toBe(f.size);
  expect(full.sha256, 'sha256 published by the distribution').toBe(sha256);
  const part = await fetchHash(f.url!, { Range: 'bytes=0-1023' });
  expect(part.status).toBe(206);
  expect(part.bytes).toBe(1024);
  expect(String(part.headers['content-range'])).toBe(`bytes 0-1023/${f.size}`);
  const tail = await fetchHash(f.url!, { Range: `bytes=${f.size - 100}-` });
  expect(tail.status).toBe(206);
  expect(tail.bytes).toBe(100);
  for (const bad of [tamper(f.url!), f.url!.replace(/\/dl\/([^/]+)/, '/dl/x$1'), f.url!.split('?')[0]!]) {
    const r = await fetchHash(bad);
    expect([403, 404], `tampered link answered ${r.status}`).toContain(r.status);
  }
}

test.describe('7. completion and verification', () => {
  test('the Debian jobs (Drive, B2, Local) complete in the UI', async ({ browser }) => {
    test.setTimeout(240 * 60_000);
    {   // the engine was throttled by spec 04 (LIVE_SMALL) to keep the download running for specs 05/06: lift it
      const c = await browser.newContext(); const p = await c.newPage(); await login(p, 'admin');
      expect((await api(p, 'PUT', '/api/admin/engine/settings', { downloadLimitKBps: 0 })).status).toBe(200);
      await c.close();
    }
    const ctxs = await Promise.all((['admin', 'user', 'user2'] as const).map(async (w) => { const c = await browser.newContext(); const p = await c.newPage(); await login(p, w); await p.goto('/'); return { c, p }; }));
    const j = ST().jobs;
    // watch them in the UI (live progress through SSE)
    await Promise.all([
      waitCompleted(ctxs[0]!.p, j.debianDrive!.id, 'Debian -> Drive', 230),
      waitCompleted(ctxs[1]!.p, j.debianB2!.id, 'Debian -> B2', 230),
      waitCompleted(ctxs[2]!.p, j.debianLocal!.id, 'Debian -> Local', 230),
    ]);
    for (const x of ctxs) await x.c.close();
  });

  test('the shared torrent was downloaded once', async ({ page }) => {
    await login(page, 'admin');
    const jobs = (await api(page, 'GET', '/api/jobs')).json as { id: number; totalSize: number; downloadProgress: number }[];
    const j = ST().jobs;
    const deb = jobs.find((x) => x.id === j.debianDrive!.id)!.totalSize;
    const ub = j.ubuntu ? jobs.find((x) => x.id === j.ubuntu!.id) : undefined;
    const ubPartial = ub ? ub.totalSize * ub.downloadProgress : 0;   // what the (separate) Ubuntu torrent has fetched so far
    const dl = ((await qbtJson('/api/v2/sync/maindata')).server_state.alltime_dl as number) - ST().baselineDl;
    save({ downloadedBytes: dl, debianBytes: deb, ubuntuPartialBytes: ubPartial });
    // the extra jobs added by specs 05/06 (a DVD and a desktop ISO) also move the engine's lifetime counter: subtract what they hold
    const extra = ['limitIso', 'restartIso'].reduce((n, k) => { const e = j[k] && jobs.find((x) => x.id === j[k]!.id); return n + (e ? e.totalSize * e.downloadProgress : 0); }, 0);
    // three jobs for one torrent: ~1x its size on a clean run (the add-time check in spec 04 asserts a single engine torrent).
    // The lifetime counter also contains pieces fetched twice when a restart lost resume data and webseed overhead, so the
    // bound only separates "once" from "once per job" (3x); a clean run lands near 1x.
    expect(dl - ubPartial - extra, `engine downloaded ${dl - ubPartial - extra} bytes for one ${deb}-byte torrent shared by three jobs`).toBeLessThan(deb * 2);
  });

  test('Debian ISO via the Local destination (signed files-host link): sha256 equals the published one, Range works, tampering is refused', async ({ browser }) => {
    test.setTimeout(30 * 60_000);
    const ctx = await browser.newContext(); const page = await ctx.newPage(); await login(page, 'user2');
    await verifyLocal(page, ST().jobs.debianLocal!.id, ST().debian.name, ST().debian.sha256);
    await ctx.close();
  });

  test('Drive: the shared folder opens without logging in; the Worker link returns the file with the published sha256', async ({ page, browser }) => {
    test.setTimeout(30 * 60_000);
    await login(page, 'admin');
    const { folder, files } = await fileLinks(page, ST().jobs.debianDrive!.id);
    expect(folder, 'a shared folder link').toMatch(/^https:\/\/drive\.google\.com\//);
    const iso = files.find((x) => x.path.endsWith('.iso'))!;
    // 1. the folder, anonymously (a brand new context: no cookies, no Google session)
    const anon = await (await browser.newContext()).newPage();
    await anon.goto(folder!);
    await expect(anon.getByText(ST().debian.name).first()).toBeVisible({ timeout: 60_000 });
    await anon.context().close();
    // 2. the Worker link
    expect(iso.url, 'a proxy link').toBeTruthy();
    expect(new URL(iso.url!).origin).toBe(new URL(live.proxyUrl()).origin);
    const full = await fullHash(iso.url!);
    expect(full.status).toBe(200);
    expect(full.bytes).toBe(iso.size);
    expect(full.sha256).toBe(ST().debian.sha256);
    const part = await fetchHash(iso.url!, { Range: 'bytes=0-1023' });
    expect(part.status).toBe(206);
    expect(part.bytes).toBe(1024);
    expect([403, 404]).toContain((await fetchHash(tamper(iso.url!))).status);
  });

  test('B2: the presigned link returns the same sha256 and the object sits under the run prefix', async ({ browser }) => {
    test.setTimeout(30 * 60_000);
    const ctx = await browser.newContext(); const page = await ctx.newPage(); await login(page, 'user');
    const { files } = await fileLinks(page, ST().jobs.debianB2!.id);
    const iso = files.find((x) => x.path.endsWith('.iso'))!;
    expect(iso.url).toBeTruthy();
    const u = new URL(iso.url!);
    expect(u.host).toContain(new URL(live.s3.endpoint()).host.replace(/^s3\./, ''));
    expect(decodeURIComponent(u.pathname)).toContain(s3Prefix());
    expect(u.search).toMatch(/X-Amz-Signature|Signature/i);
    const full = await fullHash(iso.url!);
    expect(full.status).toBe(200);
    expect(full.sha256).toBe(ST().debian.sha256);
    // out of band: the object really is below <base>/<run-id>/ (listing only that prefix)
    const ls = await rclone(['lsf', '-R', '--files-only', `${live.b2Remote()}:${live.s3.bucket()}/${s3Prefix()}/`]);
    expect(ls.code, ls.err).toBe(0);
    expect(ls.out).toContain(ST().debian.name);
    // a tampered presigned URL is refused
    const bad = new URL(iso.url!); const sig = bad.searchParams.get('X-Amz-Signature'); if (sig) bad.searchParams.set('X-Amz-Signature', sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0'));
    expect([400, 403]).toContain((await fetchHash(bad.toString(), {}, { method: 'HEAD' })).status);
    await ctx.close();
  });

  // Optional: the 3 GB Ubuntu ISO (sha256 from Ubuntu's SHA256SUMS). Skipped with LIVE_SKIP_UBUNTU=1 (e.g. a VPN that cannot move it).
  test('Ubuntu Server LTS ISO -> Local: completes, sha256 equals the published one', async ({ browser }) => {
    test.skip(process.env.LIVE_SKIP_UBUNTU === '1' || SMALL, 'LIVE_SKIP_UBUNTU=1 / LIVE_SMALL=1');
    test.setTimeout(240 * 60_000);
    const ctx = await browser.newContext(); const page = await ctx.newPage(); await login(page, 'admin');
    await page.goto('/');
    await waitCompleted(page, ST().jobs.ubuntu!.id, 'Ubuntu -> Local', 230);
    await verifyLocal(page, ST().jobs.ubuntu!.id, ST().ubuntu.name, ST().ubuntu.sha256);
    await ctx.close();
  });
});
