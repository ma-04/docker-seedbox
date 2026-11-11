import { describe, expect, it } from 'vitest';
import { alice, bob, root, setup } from './testutil.js';

describe('auth', () => {
  it('rejects missing or wrong gateway secret, even for health', async () => {
    const env = setup();
    expect((await env.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(401);
    expect((await env.app.inject({ method: 'GET', url: '/api/health', headers: { 'x-gateway-secret': 'nope' } })).statusCode).toBe(401);
    const ok = await env.call(null, 'GET', '/api/health');
    expect(ok.statusCode).toBe(200);
    expect((await env.call(null, 'GET', '/api/me')).statusCode).toBe(401);
  });

  it('requires Remote-User and uses the error envelope', async () => {
    const env = setup();
    const r = await env.call(null, 'GET', '/api/me');
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });
  });

  it('auto-provisions users and refreshes admin from groups', async () => {
    const env = setup();
    const r = await env.call({ name: 'carol', groups: 'x, admins' }, 'GET', '/api/me', undefined, {
      headers: { 'remote-email': 'c@example.test', 'remote-name': 'Carol' },
    });
    expect(r.json()).toMatchObject({
      user: { username: 'carol', email: 'c@example.test', displayName: 'Carol' }, isAdmin: true,
      googleConnectAvailable: false, logoutUrl: 'https://auth.example.test/logout',
    });
    // single-domain layout: the portal (and its logout page) lives under /auth on the app host
    for (const hosts of [{ AUTH_HOST: '', FILES_HOST: '' }, { AUTH_HOST: 'App.Example.test', FILES_HOST: 'dl.example.test' }]) {
      const single = setup(undefined, undefined, {}, hosts);
      expect((await single.call(alice, 'GET', '/api/me')).json().logoutUrl).toBe('https://app.example.test/auth/logout');
    }
    const again = await env.call({ name: 'carol' }, 'GET', '/api/me');
    expect(again.json().isAdmin).toBe(false);
    expect((env.db.prepare('SELECT COUNT(*) n FROM users').get() as { n: number }).n).toBe(1);
  });

  it('gates /api/admin and blocks disabled users', async () => {
    const env = setup();
    expect((await env.call(alice, 'GET', '/api/admin/users')).statusCode).toBe(403);
    expect((await env.call(root, 'GET', '/api/admin/users')).statusCode).toBe(200);
    await env.call(bob, 'GET', '/api/me');
    const users = (await env.call(root, 'GET', '/api/admin/users')).json();
    const b = users.find((u: { username: string }) => u.username === 'bob');
    expect((await env.call(root, 'PATCH', `/api/admin/users/${b.id}`, { disabled: true })).json().disabled).toBe(true);
    expect((await env.call(bob, 'GET', '/api/me')).statusCode).toBe(403);
    const self = users.find((u: { username: string }) => u.username === 'root');
    expect((await env.call(root, 'PATCH', `/api/admin/users/${self.id}`, { disabled: true })).statusCode).toBe(409);
  });

  it('returns 404 JSON for unknown routes', async () => {
    const env = setup();
    const r = await env.call(null, 'GET', '/nothing');
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('not_found');
  });
});
