import { chromium, expect, type FullConfig } from '@playwright/test';
import fs from 'node:fs';
import { api, AUTH_DIR, loginUI, statePath } from './app';
import { env, type UserName } from './env';
import { getManifest, probe, wgConfig } from './infra';
import { raw } from './net';

async function waitFor(what: string, fn: () => Promise<boolean>, ms = 120_000): Promise<void> {
  const until = Date.now() + ms;
  let last = '';
  while (Date.now() < until) {
    try { if (await fn()) return; } catch (e) { last = String((e as Error).message); }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`stack not ready: ${what} ${last}`);
}

/** Waits for the stack, logs the four test users in through the real Authelia page, and resets mutable app state. */
export default async function globalSetup(config: FullConfig): Promise<void> {
  for (const [k, v] of Object.entries(env.passwords)) if (!v) throw new Error(`E2E_${k.toUpperCase()}_PASSWORD is not set (use E2E_ENV_FILE or run via e2e/run.sh)`);
  await waitFor('app (gateway + authelia)', async () => (await raw(`${env.baseURL}/api/health`)).status === 200);
  await waitFor('fixtures manifest', async () => !!(await getManifest()).multi.infohash);
  await waitFor('wireguard fixtures', async () => !!(await wgConfig('wg1')) && !!(await wgConfig('wg2')));
  await waitFor('qBittorrent reachable from its namespace', async () => (await probe('http://127.0.0.1:8080/api/v2/app/version')).status === 200);

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const browser = await chromium.launch(config.projects[0]!.use.launchOptions);
  try {
    for (const user of Object.keys(env.passwords) as UserName[]) {
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: env.baseURL });
      const page = await ctx.newPage();
      await loginUI(page, user);
      await ctx.storageState({ path: statePath(user) });
      if (user === 'admin') await resetState(page);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
}

/** Makes re-runs against a kept stack start clean: no jobs, no e2e destinations, no VPN configs, default settings. */
async function resetState(admin: import('@playwright/test').Page): Promise<void> {
  await api(admin, 'PUT', '/api/admin/settings', { 'vpn.mode': 'off' });
  for (const c of (await api(admin, 'GET', '/api/admin/vpn/configs')).json as { id: number }[]) await api(admin, 'DELETE', `/api/admin/vpn/configs/${c.id}`);
  await api(admin, 'PUT', '/api/admin/settings', {
    'vpn.mode': 'off', 'vpn.rotation': 'manual', 'limits.maxActiveJobsPerUser': 5, 'limits.maxTorrentBytes': 0, 'seeding.ratio': 0,
  });
  for (let pass = 0; pass < 2; pass++) { // first pass cancels live jobs, second deletes them
    for (const j of (await api(admin, 'GET', '/api/admin/jobs')).json as { id: number }[]) await api(admin, 'DELETE', `/api/admin/jobs/${j.id}`);
  }
  for (const d of (await api(admin, 'GET', '/api/admin/destinations')).json as { id: number; name: string }[]) {
    if (d.name.startsWith('e2e-')) await api(admin, 'DELETE', `/api/admin/destinations/${d.id}`);
  }
  for (const u of (await api(admin, 'GET', '/api/admin/users')).json as { id: number; username: string; disabled: boolean }[]) {
    if (u.username !== 'admin') await api(admin, 'PATCH', `/api/admin/users/${u.id}`, { disabled: false, maxActiveJobs: null });
  }
  expect((await api(admin, 'GET', '/api/admin/settings')).status).toBe(200);
}
