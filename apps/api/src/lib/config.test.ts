import { describe, expect, it } from 'vitest';
import { hostLayout, loadConfig } from './config.js';

const base = { APP_SECRET: 's'.repeat(40), GATEWAY_SECRET: 'g', VPN_CONTROL_TOKEN: 'v' };

describe('hosts layout', () => {
  it('single domain: AUTH_HOST and FILES_HOST unset or empty -> portal under /auth, downloads on the app host', () => {
    for (const env of [{ APP_HOST: 'seedbox.example.com' }, { APP_HOST: 'seedbox.example.com', AUTH_HOST: '', FILES_HOST: '' }]) {
      expect(hostLayout(env, 'https')).toEqual({
        appHost: 'seedbox.example.com', authHost: 'seedbox.example.com', filesHost: 'seedbox.example.com',
        authPortalUrl: 'https://seedbox.example.com/auth', filesBaseUrl: 'https://seedbox.example.com',
      });
    }
  });

  it('a host equal to APP_HOST (any case, stray spaces) counts as the same host', () => {
    const l = hostLayout({ APP_HOST: 'Seedbox.Example.com', AUTH_HOST: 'seedbox.example.com ', FILES_HOST: 'SEEDBOX.EXAMPLE.COM' }, 'https');
    expect(l.authPortalUrl).toBe('https://seedbox.example.com/auth');
    expect(l.filesBaseUrl).toBe('https://seedbox.example.com');
  });

  it('separate download host only: login stays on the app host', () => {
    const l = hostLayout({ APP_HOST: 'seedbox.example.com', FILES_HOST: 'dl.example.net' }, 'https');
    expect(l).toMatchObject({ authHost: 'seedbox.example.com', authPortalUrl: 'https://seedbox.example.com/auth', filesHost: 'dl.example.net', filesBaseUrl: 'https://dl.example.net' });
  });

  it('three hosts: exactly the URLs used before single-domain support', () => {
    const l = hostLayout({ APP_HOST: 'seedbox.example.com', AUTH_HOST: 'auth.seedbox.example.com', FILES_HOST: 'files.seedbox.example.com' }, 'https');
    expect(l).toEqual({
      appHost: 'seedbox.example.com', authHost: 'auth.seedbox.example.com', filesHost: 'files.seedbox.example.com',
      authPortalUrl: 'https://auth.seedbox.example.com', filesBaseUrl: 'https://files.seedbox.example.com',
    });
  });

  it('loadConfig applies the layout and PUBLIC_SCHEME (empty -> https)', () => {
    const c = loadConfig({ ...base, APP_HOST: 'a.example.test', PUBLIC_SCHEME: '' });
    expect(c.authPortalUrl).toBe('https://a.example.test/auth');
    expect(loadConfig({ ...base, APP_HOST: 'a.example.test', AUTH_HOST: 'login.example.test', PUBLIC_SCHEME: 'http' }).authPortalUrl).toBe('http://login.example.test');
    expect(loadConfig({ ...base }).appHost).toBe('localhost');
  });
});
