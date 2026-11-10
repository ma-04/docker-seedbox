import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureFolder, findChild } from './gdrive.js';

const creds = { clientId: 'c', clientSecret: 's', refreshToken: 'gdrive-test-refresh' };
const google = { authUrl: 'http://g/auth', tokenUrl: 'http://g/token', apiBaseUrl: 'http://g/api' } as never;

afterEach(() => vi.unstubAllGlobals());

function stub(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/token')) return Response.json({ access_token: 'tok', expires_in: 3600 });
    return handler(url, init);
  });
  return calls;
}

describe('gdrive lib', () => {
  it('findChild asks for the OLDEST match first so duplicate folders resolve deterministically', async () => {
    const calls = stub(() => Response.json({ files: [{ id: 'oldest', mimeType: 'x' }] }));
    expect(await findChild(creds, google, 'P', 'Name', true)).toMatchObject({ id: 'oldest' });
    const url = new URL(calls.find((c) => c.url.includes('/files?'))!.url);
    expect(url.searchParams.get('orderBy')).toBe('createdTime');
    expect(url.searchParams.get('fields')).toContain('createdTime');
  });

  it('every Google request carries an abort signal (30 s timeout), including the token refresh', async () => {
    const calls = stub(() => Response.json({ files: [] }));
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return url.endsWith('/token') ? Response.json({ access_token: 'tok2', expires_in: 3600 }) : Response.json({ files: [], id: 'new' });
    });
    await ensureFolder({ ...creds, refreshToken: 'another-refresh' }, google, 'P', 'N');
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) expect(c.init.signal).toBeInstanceOf(AbortSignal);
  });
});
