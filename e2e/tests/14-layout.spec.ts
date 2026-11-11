import { expect, test } from '@playwright/test';
import { PORTAL_URL, api, cookieHeader, submitLogin, userPage } from '../lib/app';
import { env } from '../lib/env';
import { gatewayConfig } from '../lib/infra';
import { raw } from '../lib/net';

// The hosts layout of the stack (e2e/run.sh --layout): where the Authelia portal and the signed downloads live, and that
// sharing the app's host opens no way around the login. Runs in every layout; the single-domain-only checks say so.
const portalOnApp = env.layout !== 'multi';

test.describe(`14. hosts layout (${env.layout})`, () => {
  test('logged out: a deep link with a query goes to the portal with rd=<full URL> and comes back to it after login', async ({ browser }) => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: env.baseURL });
    const page = await ctx.newPage();
    try {
      const target = `${env.baseURL}/storage?tab=a%2Fb&x=1`;
      await page.goto(target);
      await expect(page).toHaveURL(PORTAL_URL);
      const at = new URL(page.url());
      expect(`${at.origin}${at.pathname}`).toBe(`${env.authURL}/`);
      expect(at.searchParams.get('rd')).toBe(target);
      await expect(page.locator('#username-textfield')).toBeVisible();
      await submitLogin(page, 'bob');
      await expect(page.getByTestId('current-user')).toHaveText('bob', { timeout: 30_000 });
      expect(page.url()).toBe(target);

      // the session cookie: path /, scoped to the app host in the single-domain layouts, to the parent domain otherwise
      const session = (await ctx.cookies()).find((c) => c.name === 'seedbox_session');
      expect(session, 'session cookie').toBeTruthy();
      expect(session!.path).toBe('/');
      expect(session!.httpOnly).toBe(true);
      expect(session!.secure).toBe(true);
      expect(session!.domain.replace(/^\./, '')).toBe(portalOnApp ? 'app.seedbox.test' : 'seedbox.test');
    } finally {
      await ctx.close();
    }
  });

  test('/api/* without a session is a bare 401 (no redirect), whatever the client accepts', async () => {
    for (const accept of ['application/json', 'text/html', '*/*']) {
      for (const p of ['/api/me', '/api/jobs', '/api/admin/users', '/api/events']) {
        const r = await raw(`${env.baseURL}${p}`, { headers: { accept } });
        expect(r.status, `${p} (${accept})`).toBe(401);
        expect(r.headers.location, `${p} (${accept})`).toBeUndefined();
      }
    }
    expect((await raw(`${env.baseURL}/api/health`)).status).toBe(200);   // the one login-free API route
  });

  test('the portal answers without a session and serves its own assets and API from its base path', async () => {
    const index = await raw(`${env.authURL}/`);
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toContain('text/html');
    const html = index.body.toString();
    expect(html.toLowerCase()).toContain('authelia');
    const base = new URL(env.authURL).pathname.replace(/\/$/, '');
    // every asset reference points below the portal's base path, and loads
    const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]!);
    expect(assets.length).toBeGreaterThan(0);
    for (const a of assets) {
      const u = new URL(a, `${env.authURL}/`);
      expect(u.pathname.startsWith(`${base}/`), a).toBe(true);
      expect((await raw(u.toString())).status, a).toBe(200);
    }
    const health = await raw(`${env.authURL}/api/health`);
    expect(health.status).toBe(200);
    const state = await raw(`${env.authURL}/api/state`);
    expect(state.status).toBe(200);
    expect(JSON.parse(state.body.toString()).data.username).toBe('');
    if (portalOnApp) {
      // /auth (no slash) adds the slash and keeps the query
      const bare = await raw(`${env.baseURL}/auth?rd=${encodeURIComponent(`${env.baseURL}/`)}`);
      expect(bare.status).toBe(301);
      expect(bare.headers.location).toBe(`/auth/?rd=${encodeURIComponent(`${env.baseURL}/`)}`);
    }
  });

  test('spoofed Remote-* / X-Gateway-Secret headers on the portal and on /dl/ identify nobody', async () => {
    const spoof = { 'remote-user': 'admin', 'remote-groups': 'admins', 'remote-email': 'evil@x', 'remote-name': 'Evil', 'x-gateway-secret': 'guess' };
    const state = await raw(`${env.authURL}/api/state`, { headers: spoof });
    expect(JSON.parse(state.body.toString()).data).toMatchObject({ username: '', authentication_level: 0 });
    const info = await raw(`${env.authURL}/api/user/info`, { headers: spoof });
    expect([401, 403]).toContain(info.status);
    const dl = await raw(`${env.filesURL}/dl/nothing/here.bin?exp=0&sig=00`, { headers: spoof });
    expect([403, 404]).toContain(dl.status);
    expect(dl.body.toString()).not.toContain('admin');

    // and the running gateway really blanks them (plus the cookie) towards Authelia and the API
    const conf = await gatewayConfig();
    const get = (f: string) => conf.get(f) ?? '';
    const clear = get('/etc/nginx/snippets/remote-clear.conf');
    for (const h of ['Remote-User', 'Remote-Groups', 'Remote-Email', 'Remote-Name']) expect(clear).toContain(`proxy_set_header ${h} "";`);
    const portal = get('/etc/nginx/snippets/authelia-portal.conf');
    expect(portal).toContain('include /etc/nginx/snippets/remote-clear.conf;');
    expect(portal).toContain('proxy_set_header X-Gateway-Secret "";');
    expect(portal).not.toContain('auth_request');
    const files = get('/etc/nginx/snippets/files-locations.conf');
    expect(files).toContain('include /etc/nginx/snippets/remote-clear.conf;');
    expect(files).toContain('proxy_set_header Cookie "";');
    // the generated app-host locations match the layout
    const appLoc = get('/tmp/gateway/app-locations.conf');
    expect(appLoc.includes('location ^~ /auth/'), 'portal under /auth/ on the app host').toBe(portalOnApp);
    expect(appLoc.includes('include /etc/nginx/snippets/files-locations.conf;'), '/dl/ on the app host').toBe(env.layout === 'single');
    const servers = get('/tmp/gateway/servers.conf');
    expect(servers.includes('server_name auth.seedbox.test;')).toBe(env.layout === 'multi');
    expect(servers.includes('server_name files.seedbox.test;')).toBe(env.layout !== 'single');
  });

  test("Authelia's own API under the portal path is no way around the app's login", async ({ browser }, testInfo) => {
    // the authz endpoint answers for itself only: no session -> 401, and its answer never reaches the app's API
    const authz = await raw(`${env.authURL}/api/authz/auth-request`, {
      headers: { 'x-original-url': `${env.baseURL}/api/me`, 'x-original-method': 'GET', 'remote-user': 'admin' },
    });
    expect(authz.status).toBe(401);
    for (const p of ['/api/me', '/api/admin/users', '/api/jobs']) {
      const r = await raw(`${env.authURL}${p}`);       // served by Authelia (its 404 / portal), never by the app's API
      expect(r.body.toString(), p).not.toContain('isAdmin');
      expect(r.body.toString(), p).not.toMatch(/"username":"admin"/);
    }
    // path tricks from the portal prefix into the app's API stay behind the login
    // (each either normalises to /api/me -> 401, or stays below /auth/ -> Authelia; never the app's API without a login)
    for (const p of ['/auth/../api/me', '/auth/%2e%2e/api/me', '/auth/..%2fapi/me', '/auth//../api/me', '/auth%2f../api/me']) {
      const r = await raw(`${env.baseURL}${p}`);
      expect(r.body.toString(), `${p} -> ${r.status}`).not.toContain('isAdmin');
      expect(r.body.toString(), `${p} -> ${r.status}`).not.toContain('"username":');
    }
    // with a real session Authelia's endpoints still only describe that session
    const { context, close } = await userPage(browser, testInfo, 'alice');
    const cookie = await cookieHeader(context);
    const who = await raw(`${env.authURL}/api/authz/auth-request`, { headers: { cookie, 'x-original-url': `${env.baseURL}/api/me`, 'x-original-method': 'GET' } });
    expect(who.status).toBe(200);
    expect(who.headers['remote-user']).toBe('alice');
    await close();
  });

  test('the portal path shadows no SPA or API route', async ({ browser }, testInfo) => {
    const { page, context, close } = await userPage(browser, testInfo, 'alice');
    try {
      for (const p of ['/', '/storage', '/add?magnet=x', '/admin']) {
        const r = await raw(`${env.baseURL}${p}`, { headers: { cookie: await cookieHeader(context), accept: 'text/html' } });
        expect(r.status, p).toBe(200);
        expect(r.body.toString(), p).not.toMatch(/authelia/i);
      }
      // prefixes that merely start with "auth" / "dl" are the SPA's, not the portal's or the download handler's
      for (const p of ['/authors', '/auth-x', '/dlx', '/download']) {
        const r = await raw(`${env.baseURL}${p}`, { headers: { cookie: await cookieHeader(context), accept: 'text/html' } });
        expect(r.status, p).toBe(200);
        expect(r.body.toString(), p).not.toMatch(/authelia/i);
      }
      expect((await api(page, 'GET', '/api/me')).json.user.username).toBe('alice');
      expect((await api(page, 'GET', '/api/health')).json).toEqual({ ok: true });
    } finally {
      await close();
    }
  });
});
