import { describe, expect, it } from 'vitest';
import { defaultEndpointGuard } from './upload.js';

describe('defaultEndpointGuard (shared lib/netguard)', () => {
  it('refuses private, loopback, metadata and compose-internal endpoints for user-owned destinations', async () => {
    for (const u of ['http://169.254.169.254', 'https://127.0.0.1:9000', 'https://10.0.0.5', 'https://vpn:8000', 'http://vpn:8000', 'https://[::1]/']) {
      await expect(defaultEndpointGuard(u, { allowPrivate: false }), u).rejects.toThrow();
    }
  });
  it('checks scheme-less endpoints as https (as rclone does)', async () => {
    await expect(defaultEndpointGuard('10.0.0.5:9000', { allowPrivate: false })).rejects.toThrow(/publicly routable/);
    await expect(defaultEndpointGuard('vpn:8000', { allowPrivate: false })).rejects.toThrow(/publicly routable/);
    await expect(defaultEndpointGuard('1.1.1.1:9000', { allowPrivate: false })).resolves.toBeDefined();
  });
  it('allows private hosts for shared (admin) destinations but still refuses other schemes', async () => {
    await expect(defaultEndpointGuard('http://minio:9000', { allowPrivate: true })).resolves.toBeDefined();
    await expect(defaultEndpointGuard('file:///etc/passwd', { allowPrivate: true })).rejects.toThrow();
  });
});
