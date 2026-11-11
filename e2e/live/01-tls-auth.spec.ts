import { expect, test } from '@playwright/test';
import http from 'node:http';
import tls from 'node:tls';
import { live } from './env';
import { api, login } from './lib';

test.describe.configure({ mode: 'serial' });

function peerCert(host: string): Promise<tls.PeerCertificate & { authorized: boolean }> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: true }, () => {
      const c = s.getPeerCertificate();
      s.end();
      resolve({ ...c, authorized: s.authorized });
    });
    s.on('error', reject);
  });
}
function httpGet(host: string): Promise<{ status: number; location: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host, path: '/healthz' }, (r) => { r.resume(); resolve({ status: r.statusCode ?? 0, location: String(r.headers.location ?? '') }); }).on('error', reject);
  });
}

test.describe('1. TLS and access control', () => {
  for (const host of live.hosts) {
    test(`valid Let's Encrypt certificate and HTTP -> HTTPS on ${host.split('.')[0]}`, async () => {
      const c = await peerCert(host); // rejectUnauthorized: a bad chain/host/expiry throws here
      expect(c.authorized).toBe(true);
      expect(JSON.stringify(c.issuer)).toMatch(/Let's Encrypt/);
      expect(JSON.stringify(c.issuer)).not.toMatch(/STAGING|Fake/i);
      expect(c.subjectaltname).toContain(`DNS:${host}`);
      expect(new Date(c.valid_to).getTime()).toBeGreaterThan(Date.now() + 14 * 86400_000);
      const r = await httpGet(host);
      expect([301, 302, 307, 308]).toContain(r.status);
      expect(r.location).toMatch(new RegExp(`^https://${host.replace(/\./g, '\\.')}/`));
    });
  }

  test('an unauthenticated visitor is sent to Authelia', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(new RegExp(`^${live.authURL.replace(/\./g, '\\.')}/`));
    const r = await page.request.get('/api/me', { maxRedirects: 0 });
    expect([302, 401, 403]).toContain(r.status());
  });

  test('wrong password is refused', async ({ page }) => {
    await page.goto('/');
    await page.locator('#username-textfield').fill(live.admin.user);
    await page.locator('#password-textfield').fill('definitely-not-the-password');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByText(/incorrect username or password/i)).toBeVisible();
  });

  test('admin logs in (cookie domain == app host) and sees Admin', async ({ page }) => {
    await login(page, 'admin');
    await expect(page.getByRole('link', { name: 'Destinations' })).toBeVisible();
    expect((await api(page, 'GET', '/api/admin/users')).status).toBe(200);
  });

  test('a normal user has no admin access, also not through a percent-encoded path', async ({ page }) => {
    await login(page, 'user');
    await expect(page.getByRole('link', { name: 'Destinations' })).toHaveCount(0);
    expect((await api(page, 'GET', '/api/admin/users')).status).toBe(403);
    const enc = await api(page, 'GET', '/api/%61dmin/users');
    expect([400, 403, 404]).toContain(enc.status);
    expect(enc.text).not.toContain(live.admin.user + '"');
    const enc2 = await api(page, 'GET', '/api/admin%2Fusers');
    expect([400, 403, 404]).toContain(enc2.status);
    await page.goto('/admin/vpn');
    await expect(page.getByRole('form', { name: 'VPN settings' })).toHaveCount(0);
  });
});
