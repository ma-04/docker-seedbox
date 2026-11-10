import { expect, test, type Browser, type Page } from '@playwright/test';
import { live } from './env';
import { api, fetchHash, jobRow, login, qbtJson, rclone, s3Prefix, save, state, type Fetched } from './lib';

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

test.describe('7. completion and verification', () => {
  test('all three jobs complete in the UI', async ({ browser }) => {
    test.setTimeout(150 * 60_000);
    const actx = await browser.newContext(); const a = await actx.newPage(); await login(a, 'admin');
    const uctx = await browser.newContext(); const u = await uctx.newPage(); await login(u, 'user');
    await a.goto('/'); await u.goto('/');
    const j = ST().jobs;
    // watch them in the UI (live progress through SSE); the slowest bounds the test
    await Promise.all([
      waitCompleted(a, j.debianDrive!.id, 'Debian -> Drive', 120),
      waitCompleted(u, j.debianB2!.id, 'Debian -> B2', 120),
      waitCompleted(a, j.ubuntu!.id, 'Ubuntu -> Local', 140),
    ]);
    await actx.close(); await uctx.close();
  });

  test('the shared torrent was downloaded once', async ({ page }) => {
    await login(page, 'admin');
    const jobs = (await api(page, 'GET', '/api/jobs')).json as { id: number; totalSize: number }[];
    const j = ST().jobs;
    const ub = jobs.find((x) => x.id === j.ubuntu!.id)!.totalSize;
    const deb = jobs.find((x) => x.id === j.debianDrive!.id)!.totalSize;
    const dl = ((await qbtJson('/api/v2/sync/maindata')).server_state.alltime_dl as number) - ST().baselineDl;
    save({ downloadedBytes: dl, expectedBytes: ub + deb });
    expect(dl, `engine downloaded ${dl} bytes for ${ub + deb} bytes of distinct content`).toBeLessThan((ub + deb) * 1.12);
    expect(dl, 'the content was downloaded at all').toBeGreaterThan(Math.min(ub, deb));
  });

  test('Ubuntu ISO via its signed files-host link: sha256 equals the published one, Range works, a tampered signature is refused', async ({ page }) => {
    test.setTimeout(30 * 60_000);
    await login(page, 'admin');
    const { files } = await fileLinks(page, ST().jobs.ubuntu!.id);
    const f = files.find((x) => x.path.endsWith('.iso'))!;
    expect(f.url, 'a signed link').toBeTruthy();
    expect(new URL(f.url!).host).toBe(new URL(live.filesURL).host);
    expect(f.size).toBeGreaterThan(1e9);
    const full = await fetchHash(f.url!);
    expect(full.status).toBe(200);
    expect(full.bytes).toBe(f.size);
    expect(full.sha256, 'sha256 published in SHA256SUMS').toBe(ST().ubuntu.sha256);
    const part = await fetchHash(f.url!, { Range: 'bytes=0-1023' });
    expect(part.status).toBe(206);
    expect(part.bytes).toBe(1024);
    expect(String(part.headers['content-range'])).toBe(`bytes 0-1023/${f.size}`);
    const tail = await fetchHash(f.url!, { Range: `bytes=${f.size - 100}-` });
    expect(tail.status).toBe(206);
    expect(tail.bytes).toBe(100);
    for (const bad of [tamper(f.url!), f.url!.replace(/\/dl\/([^/]+)/, '/dl/x$1')]) {
      const r = await fetchHash(bad);
      expect([403, 404], `tampered link answered ${r.status}`).toContain(r.status);
    }
    const noSig = await fetchHash(f.url!.split('?')[0]!);
    expect([403, 404]).toContain(noSig.status);
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
    const full = await fetchHash(iso.url!);
    expect(full.status).toBe(200);
    expect(full.bytes).toBe(iso.size);
    expect(full.sha256).toBe(ST().debian.sha256);
    const part = await fetchHash(iso.url!, { Range: 'bytes=0-1023' });
    expect(part.status).toBe(206);
    expect(part.bytes).toBe(1024);
    expect([403, 404]).toContain((await fetchHash(tamper(iso.url!))).status);
    save({ links: { ...(ST().links ?? {}), drive: iso.url!, local: '' } });
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
    const full = await fetchHash(iso.url!);
    expect(full.status).toBe(200);
    expect(full.sha256).toBe(ST().debian.sha256);
    // out of band: the object really is below seedbox-test/<run-id>/ (listing only that prefix)
    const ls = await rclone(['lsf', '-R', '--files-only', `${live.b2Remote()}:${live.s3.bucket()}/${s3Prefix()}/`]);
    expect(ls.code, ls.err).toBe(0);
    expect(ls.out).toContain(ST().debian.name);
    // a tampered presigned URL is refused
    const bad = new URL(iso.url!); const sig = bad.searchParams.get('X-Amz-Signature'); if (sig) bad.searchParams.set('X-Amz-Signature', sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0'));
    expect([400, 403]).toContain((await fetchHash(bad.toString(), {}, { method: 'HEAD' })).status);
    await ctx.close();
  });
});
