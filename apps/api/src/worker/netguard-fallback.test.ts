import { describe, expect, it } from 'vitest';
import { fallbackEndpointGuard, isPrivateAddress } from './netguard-fallback.js';

describe('fallbackEndpointGuard', () => {
  it('flags private, loopback, link-local and metadata addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.250.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:7f00:1']) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '2606:4700::1111']) expect(isPrivateAddress(a), a).toBe(false);
  });

  it('rejects private endpoints for user-owned destinations (allowPrivate=false)', async () => {
    for (const u of ['http://169.254.169.254/latest', 'https://10.0.0.5:9000', 'http://localhost:9000', 'http://[::1]:9000', 'http://app.localhost']) {
      await expect(fallbackEndpointGuard(u, { allowPrivate: false }), u).rejects.toThrow(/private/);
    }
  });

  it('accepts a public IP literal and any private endpoint when allowPrivate (admin-managed)', async () => {
    await expect(fallbackEndpointGuard('https://1.1.1.1', { allowPrivate: false })).resolves.toBeUndefined();
    await expect(fallbackEndpointGuard('http://minio:9000', { allowPrivate: true })).resolves.toBeUndefined();
    await expect(fallbackEndpointGuard('http://10.0.0.5:9000', { allowPrivate: true })).resolves.toBeUndefined();
  });

  it('scheme-less endpoints are checked as https (what rclone connects to)', async () => {
    await expect(fallbackEndpointGuard('10.0.0.5:9000', { allowPrivate: false })).rejects.toThrow(/private/);
    await expect(fallbackEndpointGuard('1.1.1.1:9000', { allowPrivate: false })).resolves.toBeUndefined();
    await expect(fallbackEndpointGuard('minio:9000', { allowPrivate: true })).resolves.toBeUndefined();
  });

  it('only http(s), valid URLs', async () => {
    await expect(fallbackEndpointGuard('file:///etc/passwd', { allowPrivate: true })).rejects.toThrow(/http/);
    await expect(fallbackEndpointGuard('not a url', { allowPrivate: true })).rejects.toThrow(/Invalid/);
  });
});
