import { expect, test } from '@playwright/test';
import { api, loginUI, userPage } from '../lib/app';
import { env } from '../lib/env';
import { raw } from '../lib/net';

test.describe('1. authentication', () => {
  test('unauthenticated visit is redirected to Authelia', async ({ browser }) => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: env.baseURL });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page).toHaveURL(/auth\.seedbox\.test/);
    await expect(page.locator('#username-textfield')).toBeVisible();
    // API calls get a plain 401, not a redirect
    const r = await raw(`${env.baseURL}/api/me`);
    expect(r.status).toBe(401);
    await ctx.close();
  });

  test('login lands on Downloads; a normal user has no admin nav and gets 403 from /api/admin/*', async ({ browser }) => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: env.baseURL });
    const page = await ctx.newPage();
    await loginUI(page, 'alice');
    await expect(page.getByRole('heading', { name: 'Downloads' })).toBeVisible();
    await expect(page.getByTestId('current-user')).toHaveText('alice');
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Downloads' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Storage' })).toBeVisible();
    for (const label of ['Destinations', 'VPN', 'Settings', 'Users', 'All jobs']) await expect(nav.getByRole('link', { name: label })).toHaveCount(0);
    for (const p of ['/api/admin/users', '/api/admin/settings', '/api/admin/jobs', '/api/admin/vpn/configs', '/api/admin/destinations', '/api/admin/engine/settings']) {
      expect((await api(page, 'GET', p)).status, p).toBe(403);
    }
    expect((await api(page, 'PUT', '/api/admin/settings', { 'limits.maxActiveJobsPerUser': 99 })).status).toBe(403);
    await page.goto('/admin/users');           // the SPA bounces non-admins back
    await expect(page).toHaveURL(/\/$/);
    await ctx.close();
  });

  test('admin sees the admin nav', async ({ browser }, testInfo) => {
    const { page, close } = await userPage(browser, testInfo, 'admin');
    const nav = page.getByRole('navigation', { name: 'Main' });
    for (const label of ['Destinations', 'VPN', 'Settings', 'Users', 'All jobs']) await expect(nav.getByRole('link', { name: label })).toBeVisible();
    await close();
  });

  test('a spoofed Remote-User header without a session is rejected; with a session it cannot elevate', async ({ browser }, testInfo) => {
    for (const p of ['/api/me', '/api/admin/users', '/api/jobs']) {
      const r = await raw(`${env.baseURL}${p}`, { headers: { 'remote-user': 'admin', 'remote-groups': 'admins,users', 'x-gateway-secret': 'guess' } });
      expect(r.status, p).toBe(401);
    }
    const { page, context, close } = await userPage(browser, testInfo, 'alice');
    const cookie = (await context.cookies()).filter((c) => c.domain.endsWith('seedbox.test')).map((c) => `${c.name}=${c.value}`).join('; ');
    const me = await raw(`${env.baseURL}/api/me`, { headers: { cookie, 'remote-user': 'admin', 'remote-groups': 'admins', 'remote-email': 'evil@x' } });
    expect(me.status).toBe(200);
    const j = JSON.parse(me.body.toString());
    expect(j.user.username).toBe('alice');
    expect(j.isAdmin).toBe(false);
    const admin = await raw(`${env.baseURL}/api/admin/users`, { headers: { cookie, 'remote-user': 'admin', 'remote-groups': 'admins' } });
    expect(admin.status).toBe(403);
    await page.close();
    await close();
  });

  test('percent-encoded admin path does not bypass authorisation', async ({ browser }, testInfo) => {
    const { context, close } = await userPage(browser, testInfo, 'alice');
    const cookie = (await context.cookies()).filter((c) => c.domain.endsWith('seedbox.test')).map((c) => `${c.name}=${c.value}`).join('; ');
    for (const p of ['/api/%61dmin/users', '/api/admin%2Fusers', '/api/%41dmin/users']) {
      const r = await raw(`${env.baseURL}${p}`, { headers: { cookie } });
      expect([400, 403, 404], `${p} -> ${r.status}`).toContain(r.status);
    }
    await close();
  });

  test('logout ends the session', async ({ browser }) => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: env.baseURL });
    const page = await ctx.newPage();
    await loginUI(page, 'carol');
    const loggedOut = page.waitForResponse((r) => r.url().includes('/api/logout'));
    await page.getByRole('link', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/auth\.seedbox\.test/);
    expect((await loggedOut).status()).toBe(200);
    await page.goto('/');
    await expect(page).toHaveURL(/auth\.seedbox\.test/);
    await expect(page.locator('#username-textfield')).toBeVisible();
    await ctx.close();
  });
});
