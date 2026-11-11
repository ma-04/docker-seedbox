import { expect, test } from '@playwright/test';
import { DEST, addJob, api, cookieHeader, destinationId, ensureDestination, expectJobState, jobRow, userPage } from '../lib/app';
import { env } from '../lib/env';
import { fixtureFile, getManifest, sha256 } from '../lib/infra';
import { raw } from '../lib/net';

test.describe.configure({ mode: 'serial' });

test.describe('3. .torrent upload -> local destination -> signed downloads', () => {
  let links: { url: string; path: string }[] = [];
  let jobId = 0;

  test.beforeAll(async ({ browser }, testInfo) => {
    const a = await userPage(browser, testInfo, 'admin');
    await ensureDestination(a.page, DEST.local, 'local', {});
    await a.close();
  });

  test('multi-file torrent progresses live to completed and the Files panel lists every file', async ({ browser }, testInfo) => {
    const m = await getManifest();
    const { page, close } = await userPage(browser, testInfo, 'alice');
    const sse = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/events');
    const added = await addJob(page, { torrent: { name: 'multi.torrent', buffer: await fixtureFile(m.multi.torrent) } }, DEST.local);
    expect(added.status).toBe(201);
    jobId = added.id;
    await sse;
    const row = jobRow(page, jobId);
    await expect(row).toBeVisible();
    await expect(row).toContainText('E2E Multi Pack');
    // no reload, no navigation: the row is updated by the live stream
    await expectJobState(row, 'completed', 120_000);

    await row.getByTestId('job-files').click();
    const panel = row.getByRole('region');
    for (const f of m.multi.files) await expect(panel.getByText(f.path, { exact: true })).toBeVisible();
    await expect(panel.getByTestId('file-link')).toHaveCount(m.multi.files.length);
    links = await panel.getByTestId('file-link').evaluateAll((as) => as.map((a) => ({ url: (a as HTMLAnchorElement).href, path: '' })));
    expect(links).toHaveLength(m.multi.files.length);
    await close();
  });

  test(`every link downloads through ${env.filesURL}/dl/ with the right sha256 (awkward names included)`, async () => {
    const m = await getManifest();
    for (const f of m.multi.files) {
      const l = links.find((x) => decodeURIComponent(new URL(x.url).pathname).endsWith(`/E2E Multi Pack/${f.path}`) || decodeURIComponent(new URL(x.url).pathname).endsWith(`/E2E Multi Pack [${m.multi.infohash.slice(0, 8)}]/${f.path}`));
      expect(l, `link for ${f.path}`).toBeTruthy();
      const u = new URL(l!.url);
      expect(u.origin).toBe(env.filesURL);
      const r = await raw(l!.url);
      expect(r.status, f.path).toBe(200);
      expect(r.body.length, f.path).toBe(f.size);
      expect(sha256(r.body), f.path).toBe(f.sha256);
      expect(r.headers['content-disposition'], f.path).toMatch(/^attachment; filename\*=UTF-8''/);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['content-type'], f.path).toBe('application/octet-stream');
      expect(r.headers['content-security-policy'], f.path).toBe("default-src 'none'; sandbox");
    }
  });

  test('downloads live in exactly one place: /dl/ on the other hosts is a 404', async () => {
    const l = links[0]!.url;
    // single: an unknown host (files.) hits the gateway's default server; otherwise the app host answers 404 for /dl/
    const elsewhere = env.layout === 'single' ? 'https://files.seedbox.test' : env.baseURL;
    const u = new URL(l);
    const moved = `${elsewhere}${u.pathname}${u.search}`;
    expect((await raw(moved)).status, moved).toBe(404);
  });

  test('an uploaded HTML file is delivered as an inert attachment: never rendered, never run as script or service worker', async ({ browser }, testInfo) => {
    const m = await getManifest();
    const html = m.multi.files.find((f) => f.path.endsWith('.html'));
    expect(html, 'the fixture pack contains an HTML file').toBeTruthy();
    const url = links.find((x) => decodeURIComponent(new URL(x.url).pathname).endsWith(`/${html!.path}`))!.url;
    const r = await raw(url);
    expect(r.status).toBe(200);
    expect(r.body.toString()).toContain('<script>');
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['content-disposition']).toMatch(/^attachment;/);
    expect(r.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(r.headers['x-content-type-options']).toBe('nosniff');

    const { page, context, close } = await userPage(browser, testInfo, 'alice');
    try {
      // the session cookie of the app is sent along when downloads share its host; nothing echoes it back
      const cookie = await cookieHeader(context);
      const withCookie = await raw(url, { headers: { cookie } });
      expect(withCookie.status).toBe(200);
      expect(withCookie.headers['set-cookie']).toBeUndefined();
      for (const c of cookie.split('; ')) expect(withCookie.body.includes(Buffer.from(c.split('=')[1]!)), 'cookie value not in the body').toBe(false);

      // a top-level navigation downloads the file; the page stays where it was and nothing ran
      const before = page.url();
      let dialog = false;
      page.on('dialog', (d) => { dialog = true; void d.dismiss(); });
      const download = page.waitForEvent('download');
      await page.goto(url).catch((e: Error) => expect(e.message).toMatch(/Download is starting|net::ERR_ABORTED/));
      expect((await download).suggestedFilename()).toBe(html!.path.split('/').pop());
      expect(page.url()).toBe(before);
      await expect(page.getByTestId('current-user')).toBeVisible();

      // from the app's own origin: not executable as a script, not registrable as a service worker, not framable
      const probe = await page.evaluate(async (u) => {
        const script = await new Promise<string>((res) => {
          const s = document.createElement('script');
          s.src = u; s.onload = () => res('loaded'); s.onerror = () => res('blocked');
          document.head.appendChild(s);
        });
        let sw = 'registered'; let swReason = '';
        try { const reg = await navigator.serviceWorker.register(u, { scope: new URL(u).pathname.replace(/[^/]*$/, '') }); await reg.unregister(); } catch (e) { sw = 'refused'; swReason = String((e as Error)?.message ?? e); }
        const frame = await new Promise<string>((res) => {
          const f = document.createElement('iframe');
          f.src = u; document.body.appendChild(f);
          setTimeout(() => { let t = 'opaque'; try { t = f.contentDocument?.body?.innerText ?? 'opaque'; } catch { t = 'opaque'; } f.remove(); res(t); }, 2000);
        });
        return { script, sw, swReason, frame, pwned: (window as unknown as { __pwned?: number }).__pwned ?? null };
      }, url);
      // the reason is recorded in the report: over the e2e's self-signed TLS Chromium may refuse for the certificate
      // before it gets to the MIME type check, so `refused` alone does not prove which rule stopped it
      testInfo.annotations.push({ type: 'service-worker refusal', description: probe.swReason });
      console.log(`service-worker registration refused: ${probe.swReason}`);
      expect(probe.script).toBe('blocked');
      expect(probe.sw).toBe('refused');
      expect(probe.frame).not.toContain('PWNED');
      expect(probe.pwned).toBeNull();
      expect(dialog).toBe(false);
    } finally {
      await close();
    }
  });

  test('Range request -> 206; tampered signature -> 403; no signature -> 403/404', async () => {
    const m = await getManifest();
    const f = m.multi.files.find((x) => x.path === 'plain.bin')!;
    const url = links.find((x) => decodeURIComponent(new URL(x.url).pathname).endsWith('/plain.bin') && !new URL(x.url).pathname.includes('deeper'))!.url;
    const full = await raw(url);
    expect(full.headers['accept-ranges']).toBe('bytes');
    const part = await raw(url, { headers: { range: 'bytes=100-199' } });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 100-199/${f.size}`);
    expect(part.body.equals(full.body.subarray(100, 200))).toBe(true);

    const u = new URL(url);
    const sig = u.searchParams.get('sig')!;
    u.searchParams.set('sig', (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1));
    expect((await raw(u.toString())).status).toBe(403);
    u.searchParams.delete('sig');
    expect((await raw(u.toString())).status).toBe(403);
    const other = new URL(url);
    other.pathname = other.pathname.replace('plain.bin', 'with%20space.bin');   // valid signature, different path
    expect((await raw(other.toString())).status).toBe(403);
    const traversal = new URL(url);
    traversal.pathname = '/dl/..%2f..%2fetc%2fpasswd';
    expect([400, 403, 404]).toContain((await raw(traversal.toString())).status);
    // the library is never served directly (/_protected/ is internal), and a separate files host serves nothing but /dl/
    expect((await raw(`${env.filesURL}/_protected/plain.bin`)).status).toBe(404);
    expect((await raw(`${env.filesURL}/_protected/${encodeURIComponent('E2E Multi Pack')}/plain.bin`)).status).toBe(404);
    if (env.layout !== 'single') expect((await raw(`${env.filesURL}/`)).status).toBe(404);
  });

  test('every /dl/ response, errors included, carries nosniff and the sandbox CSP (SECURITY.md)', async () => {
    const url = links.find((x) => decodeURIComponent(new URL(x.url).pathname).endsWith('/plain.bin') && !new URL(x.url).pathname.includes('deeper'))!.url;
    const bad = new URL(url); bad.searchParams.set('sig', '0'.repeat(64));
    const missing = new URL(url); missing.pathname = missing.pathname.replace('plain.bin', 'no-such-file.bin');
    const cases: [string, Promise<import('../lib/net').RawResponse>, number][] = [
      ['200 file', raw(url), 200],
      ['206 range', raw(url, { headers: { range: 'bytes=0-9' } }), 206],
      ['416 unsatisfiable range (nginx)', raw(url, { headers: { range: 'bytes=999999999-' } }), 416],
      ['403 bad signature (API)', raw(bad.toString()), 403],
      ['404/403 unknown file (API)', raw(missing.toString()), 0],
      ['404 POST (nginx)', raw(url, { method: 'POST', body: 'x' }), 404],
    ];
    for (const [what, p, status] of cases) {
      const r = await p;
      if (status) expect(r.status, what).toBe(status); else expect([403, 404], what).toContain(r.status);
      expect(r.headers['x-content-type-options'], what).toBe('nosniff');
      expect(r.headers['content-security-policy'], what).toBe("default-src 'none'; sandbox");
      expect(r.headers['referrer-policy'], what).toBe('no-referrer');
      if (r.status === 200 || r.status === 206) {
        expect(r.headers['content-type'], what).toBe('application/octet-stream');
        expect(r.headers['content-disposition'], what).toMatch(/^attachment;/);
      }
    }
  });

  test('an expired link -> 410', async ({ browser }, testInfo) => {
    const a = await userPage(browser, testInfo, 'admin');
    const alice = await userPage(browser, testInfo, 'alice');
    const id = await destinationId(a.page, DEST.local);
    try {
      expect((await api(a.page, 'PATCH', `/api/admin/destinations/${id}`, { config: { linkTtlSeconds: 1 } })).status).toBe(200);
      const files = await api(alice.page, 'GET', `/api/jobs/${jobId}/files`);
      const url = files.json.files[0].url as string;
      expect(new URL(url).searchParams.get('exp')).toBeTruthy();
      await expect.poll(async () => (await raw(url)).status, { timeout: 15_000 }).toBe(410);
    } finally {
      await api(a.page, 'PATCH', `/api/admin/destinations/${id}`, { config: { linkTtlSeconds: 86400 } });
      await a.close(); await alice.close();
    }
  });

  test('SSE streams through the gateway without buffering', async ({ browser }, testInfo) => {
    const { page, close } = await userPage(browser, testInfo, 'alice');
    const first = await page.evaluate(async () => {
      const ctl = new AbortController();
      const t0 = performance.now();
      const res = await fetch('/api/events', { signal: ctl.signal, headers: { Accept: 'text/event-stream' } });
      const reader = res.body!.getReader();
      const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 8000))]);
      ctl.abort();
      return { type: res.headers.get('content-type'), ms: Math.round(performance.now() - t0), text: chunk ? new TextDecoder().decode((chunk as ReadableStreamReadResult<Uint8Array>).value) : null };
    });
    expect(first.type).toContain('text/event-stream');
    expect(first.text, 'first SSE chunk must arrive immediately (not buffered)').toContain('retry:');
    expect(first.ms).toBeLessThan(5000);
    await close();
  });
});
