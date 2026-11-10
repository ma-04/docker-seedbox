import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, endpoints } from './api';

afterEach(() => vi.unstubAllGlobals());

function capture() {
  const seen: { url: string; method: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    seen.push({ url, method: String(init.method), headers: init.headers as Record<string, string> });
    return new Response('{}', { status: 200 });
  });
  return seen;
}

describe('api() CSRF header', () => {
  it('sends X-Requested-With: seedbox on every non-GET request, JSON and multipart', async () => {
    const seen = capture();
    await endpoints.addMagnet('magnet:?xt=urn:btih:' + 'a'.repeat(40), 1);
    await endpoints.addTorrentFile(new File(['x'], 'a.torrent'), 1);
    await endpoints.deleteJob(1);
    await endpoints.retryJob(1);
    await endpoints.admin.updateSettings({});
    await endpoints.admin.vpnRotate();
    await endpoints.testDestination(1);
    expect(seen).toHaveLength(7);
    for (const s of seen) expect(s.headers['X-Requested-With'], `${s.method} ${s.url}`).toBe('seedbox');
  });
  it('is not needed (and not sent) for GET', async () => {
    const seen = capture();
    await api('/me');
    expect(seen[0]!.headers['X-Requested-With']).toBeUndefined();
  });
});
