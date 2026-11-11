import { expect, test } from '@playwright/test';
import crypto from 'node:crypto';
import { api, fetchHash, inQbt, jobRow, login, mask, note, serverEgressIp, sh, state } from './lib';

test.describe.configure({ mode: 'serial' });

/** A command inside the qbittorrent container as the engine's own uid (1000): root is no longer exempt from the LAN policy either (the two-uid test below probes both). */
const asEngine = (cmd: string) => sh(`sudo docker exec -u 1000 seedbox-qbittorrent-1 sh -c '${cmd.replace(/'/g, "'\\''")}'`);

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
      const r = via === 'host' ? await sh(cmd) : await asEngine(cmd);
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
    const t = await asEngine('curl -4 -sS -m 15 https://api.ipify.org');
    expect(t.code, t.err).toBe(0);
    expect(t.out.trim()).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(t.out.trim()).not.toBe(own);
    expect(t.out.trim()).toBe(status.publicIp);
    note(ti, 'lan-policy', `gateway ${mask(gw)} -> ${g}; sibling ${mask(sibling)} -> ${s}; tunnel egress ${mask(t.out.trim())} (server ${mask(own)})`);
  });

  test('qbittorrent namespace as uid 1000 AND root: bridge gateway, sibling, 172.17.0.1 and 169.254.169.254 unreachable; DNS and tunnel egress work', async ({}, ti) => {
    const net = await sh(`sudo docker inspect seedbox-vpn-1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{$v.Gateway}}{{"\\n"}}{{end}}'`);
    const api2 = await sh(`sudo docker inspect seedbox-api-1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{$v.IPAddress}}{{"\\n"}}{{end}}'`);
    const nets = new Map(net.out.trim().split('\n').map((l) => l.split(' ') as [string, string]));
    const [, sibling] = api2.out.trim().split('\n').map((l) => l.split(' ') as [string, string]).find(([n]) => nets.has(n))!;
    const gw = nets.get([...nets.keys()].find((n) => api2.out.includes(`${n} `))!)!;
    const targets = [`http://${gw}:80/`, `http://${sibling}:3000/api/health`, 'http://172.17.0.1/', 'http://169.254.169.254/'];
    const own = await serverEgressIp();
    const lines: string[] = []; const codes: string[] = [];
    // controls: every target answers from the host (172.17.0.1 / the metadata address may legitimately refuse or time out there: logged only)
    for (const u of targets.slice(0, 2)) expect((await sh(`curl -sS -m 5 -o /dev/null -w '%{http_code}' ${u}; echo " exit=$?"`)).out, `control ${u}`).toMatch(/exit=0/);
    for (const [who, uid] of [['uid1000', '1000'], ['root', '0']] as const) {
      const run = (cmd: string) => sh(`sudo docker exec -u ${uid} seedbox-qbittorrent-1 sh -c '${cmd.replace(/'/g, "'\\''")}'`);
      for (const u of targets) {
        const r = await run(`curl -sS -m 5 -o /dev/null -w '%{http_code}' ${u}; echo " exit=$?"`);
        expect(`${r.out.trim()}`, `${who} -> ${mask(u.replace(/^http:\/\/|[:/].*$/g, ''))} must be unreachable`).toMatch(/000 exit=[1-9]/);
        codes.push(`${who}:${u.replace(/^http:\/\/|[:/].*$/g, '').split('.').slice(0, 2).join('.')}=${/exit=(\d+)/.exec(r.out)?.[1]}`);
      }
      const rs = await run("awk '/^nameserver/{print $2}' /etc/resolv.conf");
      lines.push(`${who} resolver ${rs.out.trim().split(/\s+/).map(mask).join(',')}`);
      const d = await run('getent hosts releases.ubuntu.com || nslookup releases.ubuntu.com');
      expect(d.out, `${who}: DNS through the tunnel (${d.err})`).toMatch(/\d+\.\d+\.\d+\.\d+|[0-9a-f:]{6,}/);
      const t = await run('curl -4 -sS -m 15 https://api.ipify.org');
      expect(t.code, t.err).toBe(0);
      expect(t.out.trim()).not.toBe(own);
      lines.push(`${who}: 4 targets unreachable, DNS ok, egress ${mask(t.out.trim())}`);
    }
    note(ti, 'lan-policy-both-uids', `curl exit codes (28 = dropped, 7 = refused) ${codes.join(' ')}; ${lines.join(' | ')} (server ${mask(own)})`);
  });

  test('crafted .torrent files (two info keys; unsorted keys inside info) are rejected with 400 through the real API', async ({ page }, ti) => {
    await login(page, 'admin');
    const dests = (await api(page, 'GET', '/api/destinations')).json as { id: number; name: string }[];
    const dest = dests.find((d) => d.name === 'live-local')!.id;
    const b = (s: string) => Buffer.from(s, 'latin1');
    const str = (s: string | Buffer) => Buffer.concat([b(`${Buffer.byteLength(s)}:`), Buffer.isBuffer(s) ? s : b(s)]);
    const int = (n: number) => b(`i${n}e`);
    const dict = (...kv: Buffer[]) => Buffer.concat([b('d'), ...kv, b('e')]);
    const pieces = crypto.randomBytes(20);
    const sortedInfo = dict(str('length'), int(5), str('name'), str('crafted.bin'), str('piece length'), int(16384), str('pieces'), str(pieces));
    const unsortedInfo = dict(str('name'), str('crafted.bin'), str('length'), int(5), str('piece length'), int(16384), str('pieces'), str(pieces));
    const otherInfo = dict(str('length'), int(6), str('name'), str('other.bin'), str('piece length'), int(16384), str('pieces'), str(crypto.randomBytes(20)));
    const cases: Record<string, Buffer> = {
      'two-info-keys': dict(str('info'), sortedInfo, str('info'), otherInfo),
      'unsorted-info': dict(str('info'), unsortedInfo),
    };
    const before = ((await api(page, 'GET', '/api/jobs')).json as unknown[]).length;
    const res: string[] = [];
    for (const [name, buf] of Object.entries(cases)) {
      const r = await page.request.post('/api/jobs', {
        headers: { 'X-Requested-With': 'seedbox' },
        multipart: { torrent: { name: `${name}.torrent`, mimeType: 'application/x-bittorrent', buffer: buf }, destinationId: String(dest) },
      });
      expect(r.status(), `${name}: ${await r.text()}`).toBe(400);
      res.push(`${name}=${r.status()} (${(await r.text()).slice(0, 120).replace(/\s+/g, ' ')})`);
    }
    expect(((await api(page, 'GET', '/api/jobs')).json as unknown[]).length).toBe(before);
    // control: the same torrent with sorted keys and a single info is accepted (so the 400s above are about the structure), then removed again
    const ok = await page.request.post('/api/jobs', { headers: { 'X-Requested-With': 'seedbox' },
      multipart: { torrent: { name: 'control.torrent', mimeType: 'application/x-bittorrent', buffer: dict(str('info'), sortedInfo) }, destinationId: String(dest) } });
    const okText = await ok.text();
    expect(ok.status(), okText).toBe(201);
    expect((await api(page, 'DELETE', `/api/jobs/${JSON.parse(okText).id}`)).status).toBeLessThan(300);
    res.push(`control(sorted, one info)=${ok.status()}`);
    note(ti, 'crafted-torrents', res.join(', '));
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
