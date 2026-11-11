import { expect, test } from '@playwright/test';
import crypto from 'node:crypto';
import { api, fetchHash, inQbt, jobRow, login, mask, note, serverEgressIp, sh, state } from './lib';

test.describe.configure({ mode: 'serial' });

// Checks added with the final review fixes: footer, magnet hardening, /add prefill, MTU, kill-switch LAN policy and
// file removal on job delete. Runs after the completion specs (07/08) and before the cleanup (99).
test.describe('9. final review fixes on the live deployment', () => {
  test('footer: source link and running version', async ({ page }) => {
    await login(page, 'admin');
    const footer = page.getByTestId('app-footer');
    await expect(footer.getByRole('link', { name: /source code/i })).toHaveAttribute('href', /^https:\/\/github\.com\/[^/]+\/docker-seedbox$/);
    const v = (await page.getByTestId('app-version').textContent())?.trim();
    expect(v, 'a version or commit').toBeTruthy();
    expect(v).not.toBe('dev');
  });

  test('a magnet with an injected newline (second URL / second magnet) is rejected and nothing is added', async ({ page }) => {
    await login(page, 'admin');
    const dests = (await api(page, 'GET', '/api/destinations')).json as { id: number; name: string }[];
    const dest = dests.find((d) => d.name === 'live-local')!.id;
    const h = () => crypto.randomBytes(20).toString('hex');
    const a = h(); const b = h();
    const before = ((await api(page, 'GET', '/api/jobs')).json as unknown[]).length;
    const attack = `magnet:?xt=urn:btih:${a}&dn=x\nhttp://172.17.0.1/\nmagnet:?xt=urn:btih:${b}`;
    for (const magnet of [attack, attack.replace(/\n/g, '\r\n'), `magnet:?xt=urn:btih:${a}&dn=x y`]) {
      const r = await api(page, 'POST', '/api/jobs', { magnet, destinationId: dest });
      expect(r.status, JSON.stringify(r.json)).toBe(400);
    }
    expect(((await api(page, 'GET', '/api/jobs')).json as unknown[]).length).toBe(before);
    const t = await inQbt('curl -fsS -m 10 http://127.0.0.1:8080/api/v2/torrents/info');
    expect(t.out).not.toContain(a); expect(t.out).not.toContain(b);
  });

  test('/add?magnet= pre-fills the form and submits nothing', async ({ page }) => {
    await login(page, 'admin');
    const hash = crypto.randomBytes(20).toString('hex');
    const before = ((await api(page, 'GET', '/api/jobs')).json as unknown[]).length;
    await page.goto(`/add?magnet=${encodeURIComponent(`magnet:?xt=urn:btih:${hash}&dn=prefill-check`)}`);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('magnet-prefill')).toBeVisible();
    await expect(page.getByTestId('magnet-input')).toHaveValue(new RegExp(hash));
    await page.waitForTimeout(2000);
    expect(((await api(page, 'GET', '/api/jobs')).json as unknown[]).length).toBe(before);
  });

  test('VPN page shows the tunnel MTU', async ({ page }, ti) => {
    await login(page, 'admin');
    const s = (await api(page, 'GET', '/api/admin/vpn/status')).json;
    expect(s.mtu, 'mtu in /status').toBeGreaterThanOrEqual(576);
    await page.goto('/admin/vpn');
    await expect(page.getByTestId('vpn-status')).toContainText(new RegExp(`MTU\\s*${s.mtu}`));
    note(ti, 'mtu', `tunnel MTU ${s.mtu}`);
  });

  test('qbittorrent namespace: the Docker bridge gateway and a sibling container are NOT reachable; the tunnel works', async ({ page }, ti) => {
    await login(page, 'admin');
    const status = (await api(page, 'GET', '/api/admin/vpn/status')).json;
    expect(status.connected).toBe(true);
    const own = await serverEgressIp();
    // the compose network, its gateway (the host) and the api container on it
    const net = await sh(`sudo docker inspect seedbox-vpn-1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{$v.Gateway}}{{"\\n"}}{{end}}'`);
    const api2 = await sh(`sudo docker inspect seedbox-api-1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{$v.IPAddress}}{{"\\n"}}{{end}}'`);
    const nets = new Map(net.out.trim().split('\n').map((l) => l.split(' ') as [string, string]));
    const shared = api2.out.trim().split('\n').map((l) => l.split(' ') as [string, string]).find(([n]) => nets.has(n));
    expect(shared, 'a network shared by vpn and api').toBeTruthy();
    const gw = nets.get(shared![0])!; const sibling = shared![1];
    expect(gw).toMatch(/^\d+\.\d+\.\d+\.\d+$/); expect(sibling).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    const probe = async (url: string, via: 'host' | 'qbt') => {
      const cmd = `curl -sS -m 5 -o /dev/null -w '%{http_code}' ${url}; echo " exit=$?"`;
      const r = via === 'host' ? await sh(cmd) : await inQbt(cmd);
      return `${r.out.trim()} ${r.err.trim()}`;
    };
    // controls: both answer from the host, so "unreachable" below really is the policy
    expect(await probe(`http://${gw}:80/`, 'host')).toMatch(/exit=0/);
    expect(await probe(`http://${sibling}:3000/api/health`, 'host')).toMatch(/exit=0/);
    const g = await probe(`http://${gw}:80/`, 'qbt');
    const s = await probe(`http://${sibling}:3000/api/health`, 'qbt');
    expect(g, `gateway ${mask(gw)} must be unreachable from qbittorrent`).toMatch(/000 exit=[1-9]/);
    expect(s, `sibling ${mask(sibling)} must be unreachable from qbittorrent`).toMatch(/000 exit=[1-9]/);
    // and the tunnel itself works
    const t = await inQbt('curl -4 -sS -m 15 https://api.ipify.org');
    expect(t.code, t.err).toBe(0);
    expect(t.out.trim()).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(t.out.trim()).not.toBe(own);
    expect(t.out.trim()).toBe(status.publicIp);
    note(ti, 'lan-policy', `gateway ${mask(gw)} -> ${g}; sibling ${mask(sibling)} -> ${s}; tunnel egress ${mask(t.out.trim())} (server ${mask(own)})`);
  });

  test('deleting the Local job removes its files from the library and its signed link answers 404', async ({ browser }, ti) => {
    test.setTimeout(5 * 60_000);
    const ctx = await browser.newContext(); const page = await ctx.newPage(); await login(page, 'user2');
    const id = state().jobs.debianLocal!.id;
    await page.goto('/');
    await expect(jobRow(page, id)).toHaveAttribute('data-state', 'completed');
    const files = (await api(page, 'GET', `/api/jobs/${id}/files`)).json.files as { path: string; url: string }[];
    const iso = files.find((f) => f.path.endsWith('.iso'))!;
    expect((await fetchHash(iso.url, { Range: 'bytes=0-99' })).status).toBe(206);
    const name = (state().debian as { name: string }).name;
    const onDisk = () => sh(`sudo docker exec seedbox-api-1 find /downloads/library -mindepth 2 -maxdepth 2 -type d -name '${name} \\[*\\]'`);
    const mine = (await onDisk()).out.trim().split('\n').filter(Boolean);
    expect(mine.length, 'the local library holds this ISO').toBeGreaterThan(0);
    const del = await api(page, 'DELETE', `/api/jobs/${id}`);
    expect([200, 204]).toContain(del.status);
    await expect.poll(async () => (await onDisk()).out.trim(), { timeout: 120_000, intervals: [3000], message: 'library files removed' }).toBe('');
    const after = await fetchHash(iso.url, { Range: 'bytes=0-99' });
    expect(after.status).toBe(404);
    note(ti, 'delete', `library folders before: ${mine.length}, after: 0; link now ${after.status}`);
    await ctx.close();
  });
});
