import { describe, expect, it } from 'vitest';
import { getSetting } from '../lib/settings.js';
import { acquireVpnLock, releaseVpnLock, VpnHttpError } from '../lib/vpn.js';
import { alice, fakeVpn, root, setup } from './testutil.js';

const WG = `[Interface]
PrivateKey = SUPERSECRETPRIVATEKEY=
Address = 10.0.0.2/32
DNS = 10.0.0.1

[Peer]
PublicKey = PUBKEY=
AllowedIPs = 0.0.0.0/0
Endpoint = vpn.example.test:51820
`;

describe('admin vpn', () => {
  it('validates configs, never returns config text, and tracks active', async () => {
    const vpn = fakeVpn();
    const env = setup(vpn);
    const bad = await env.call(root, 'POST', '/api/admin/vpn/configs', { name: 'bad', config: '[Interface]\nPrivateKey=x\nPostUp = rm -rf /' });
    expect(bad.statusCode).toBe(400);
    const created = await env.call(root, 'POST', '/api/admin/vpn/configs', { name: 'one', config: WG });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: 'one', endpointHost: 'vpn.example.test', enabled: true, active: false });
    expect(created.body).not.toContain('SUPERSECRET');
    expect((await env.call(root, 'POST', '/api/admin/vpn/configs', { name: 'one', config: WG })).statusCode).toBe(409);
    const raw = env.db.prepare('SELECT config_enc FROM vpn_configs').get() as { config_enc: string };
    expect(raw.config_enc).not.toContain('SUPERSECRET');

    const id = created.json().id;
    const rot = await env.call(root, 'POST', '/api/admin/vpn/rotate', {});
    expect(rot.json()).toMatchObject({ id, active: true });
    expect(vpn.calls).toContain('connect:one');
    const list = await env.call(root, 'GET', '/api/admin/vpn/configs');
    expect(list.body).not.toContain('SUPERSECRET');
    expect(list.json()[0].active).toBe(true);

    const dis = await env.call(root, 'PATCH', `/api/admin/vpn/configs/${id}`, { enabled: false });
    expect(dis.json()).toMatchObject({ enabled: false, active: false });
    expect(vpn.calls).toContain('disconnect');
    expect(getSetting(env.db, 'vpn.activeConfigId')).toBeNull();
    expect((await env.call(root, 'POST', '/api/admin/vpn/rotate', {})).statusCode).toBe(409);
    expect((await env.call(root, 'DELETE', `/api/admin/vpn/configs/${id}`)).statusCode).toBe(204);
    expect((await env.call(alice, 'GET', '/api/admin/vpn/configs')).statusCode).toBe(403);
  });

  it('rotate is serialised with the worker (409 while the DB lock is held) and maps the sidecar\'s off-mode 409', async () => {
    const vpn = fakeVpn();
    const env = setup(vpn, undefined, { vpnLockWaitMs: 0 });
    await env.call(root, 'POST', '/api/admin/vpn/configs', { name: 'one', config: WG });
    const token = acquireVpnLock(env.db)!;
    const busy = await env.call(root, 'POST', '/api/admin/vpn/rotate', {});
    expect(busy.statusCode).toBe(409);
    expect(vpn.calls).not.toContain('connect:one');
    // with a wait budget the admin rotate gets in as soon as the worker releases the lock
    const waiting = setup(fakeVpn(), undefined, { vpnLockWaitMs: 3000 });
    await waiting.call(root, 'POST', '/api/admin/vpn/configs', { name: 'one', config: WG });
    const held = acquireVpnLock(waiting.db)!;
    setTimeout(() => releaseVpnLock(waiting.db, held), 400);
    expect((await waiting.call(root, 'POST', '/api/admin/vpn/rotate', {})).statusCode).toBe(200);
    releaseVpnLock(env.db, token);
    expect((await env.call(root, 'POST', '/api/admin/vpn/rotate', {})).statusCode).toBe(200);
    expect(env.db.prepare("SELECT 1 FROM settings WHERE key = 'vpn.lock'").get()).toBeUndefined(); // released after use

    const off = setup(fakeVpn({ connect: async () => { throw new VpnHttpError('VPN control POST /connect failed (409)', 409); } }));
    await off.call(root, 'POST', '/api/admin/vpn/configs', { name: 'one', config: WG });
    const r = await off.call(root, 'POST', '/api/admin/vpn/rotate', {});
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toBe('Set VPN mode to required first');
    expect(off.db.prepare("SELECT 1 FROM settings WHERE key = 'vpn.lock'").get()).toBeUndefined();
  });

  it('status falls back when the sidecar is unreachable', async () => {
    const env = setup(fakeVpn({ status: async () => { throw new Error('down'); } }));
    const r = (await env.call(root, 'GET', '/api/admin/vpn/status')).json();
    expect(r).toMatchObject({ reachable: false, connected: false, name: null, mode: 'off', activeConfigId: null });
    const ok = setup();
    expect((await ok.call(root, 'GET', '/api/admin/vpn/status')).json()).toMatchObject({ reachable: true, connected: true });
  });
});

describe('admin settings', () => {
  it('omits google keys, validates, and syncs vpn mode', async () => {
    const vpn = fakeVpn();
    const env = setup(vpn);
    const g = (await env.call(root, 'GET', '/api/admin/settings')).json();
    expect(g['limits.maxActiveJobsPerUser']).toBe(5);
    expect(Object.keys(g).some((k) => k.startsWith('google.'))).toBe(false);

    expect((await env.call(root, 'PUT', '/api/admin/settings', { 'limits.maxActiveJobsPerUser': 'many' })).statusCode).toBe(400);
    expect((await env.call(root, 'PUT', '/api/admin/settings', { 'vpn.rotationMinutes': 0 })).statusCode).toBe(400);
    expect((await env.call(root, 'PUT', '/api/admin/settings', { 'vpn.mode': 'required' })).statusCode).toBe(409);

    for (const bad of [{ 'cleanup.failedGraceMinutes': -1 }, { 'limits.metadataTimeoutMinutes': 1.5 }, { 'seeding.maxMinutes': 'x' }, { 'seeding.maxMinutes': 10_000_000 }]) {
      expect((await env.call(root, 'PUT', '/api/admin/settings', bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    const fresh = (await env.call(root, 'GET', '/api/admin/settings')).json();
    expect([fresh['cleanup.failedGraceMinutes'], fresh['limits.metadataTimeoutMinutes'], fresh['seeding.maxMinutes']]).toEqual([60, 30, 0]);
    const lim = await env.call(root, 'PUT', '/api/admin/settings', { 'cleanup.failedGraceMinutes': 15, 'limits.metadataTimeoutMinutes': 0, 'seeding.maxMinutes': 90 });
    expect(lim.statusCode).toBe(200);
    expect(lim.json()).toMatchObject({ 'cleanup.failedGraceMinutes': 15, 'limits.metadataTimeoutMinutes': 0, 'seeding.maxMinutes': 90 });
    expect(getSetting(env.db, 'seeding.maxMinutes')).toBe(90);

    // google keys and activeConfigId are ignored
    const ignored = await env.call(root, 'PUT', '/api/admin/settings', { 'google.oauthClientSecret': 'x', 'vpn.activeConfigId': 9, 'limits.maxActiveJobsPerUser': 7 });
    expect(ignored.json()['limits.maxActiveJobsPerUser']).toBe(7);
    expect(getSetting(env.db, 'google.oauthClientSecret')).toBe('');
    expect(getSetting(env.db, 'vpn.activeConfigId')).toBeNull();

    await env.call(root, 'POST', '/api/admin/vpn/configs', { name: 'one', config: WG });
    const ok = await env.call(root, 'PUT', '/api/admin/settings', { 'vpn.mode': 'required' });
    expect(ok.json()['vpn.mode']).toBe('required');
    expect(vpn.calls).toContain('mode:required');
    expect((await env.call(alice, 'PUT', '/api/admin/settings', {})).statusCode).toBe(403);
  });

  it('ignores vpn.setMode failures', async () => {
    const env = setup(fakeVpn({ setMode: async () => { throw new Error('x'); } }));
    await env.call(root, 'POST', '/api/admin/vpn/configs', { name: 'one', config: WG });
    expect((await env.call(root, 'PUT', '/api/admin/settings', { 'vpn.mode': 'required' })).statusCode).toBe(200);
  });
});
