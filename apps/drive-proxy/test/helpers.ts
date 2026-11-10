import { vi } from 'vitest';
import { resetTokenCache } from '../src/token';
import type { Env } from '../src/types';

export const KEY = 'test-signing-key';
export const env: Env = {
  GDRIVE_CLIENT_ID: 'cid.example.com',
  GDRIVE_CLIENT_SECRET: 'csecret',
  GDRIVE_REFRESH_TOKEN: 'rtoken',
  SIGNING_KEY: KEY,
  ROOT_FOLDER_ID: 'ROOT',
};

export const FOLDER = 'application/vnd.google-apps.folder';

export interface DriveNode { id: string; name: string; mimeType?: string; parent: string; size?: string; md5Checksum?: string; modifiedTime?: string }

export interface Mock {
  calls: { url: URL; init?: RequestInit }[];
  nodes: DriveNode[];
  tokens: number;
  /** override media responses */
  media?: (url: URL, init: RequestInit | undefined, n: number) => Response | undefined;
  mediaCalls: number;
  /** token strings accepted by Drive; default accepts all */
  rejectFirstToken?: boolean;
}

export function installFakes(nodes: DriveNode[] = []): Mock {
  resetTokenCache();
  const store = new Map<string, Response>();
  (globalThis as any).caches = {
    default: {
      match: async (r: Request) => store.get(r.url)?.clone(),
      put: async (r: Request, res: Response) => void store.set(r.url, res),
    },
  };
  const m: Mock = { calls: [], nodes, tokens: 0, mediaCalls: 0 };
  vi.stubGlobal('fetch', async (input: any, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    m.calls.push({ url, init });
    if (url.origin === 'https://oauth2.googleapis.com') {
      m.tokens++;
      await new Promise((r) => setTimeout(r, 5));
      return Response.json({ access_token: `tok${m.tokens}`, expires_in: 3600 });
    }
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    if (m.rejectFirstToken && auth === 'Bearer tok1') return new Response('{}', { status: 401 });
    if (url.searchParams.get('alt') === 'media') {
      m.mediaCalls++;
      return m.media?.(url, init, m.mediaCalls) ?? new Response('hello world', { status: 200, headers: { 'content-length': '11' } });
    }
    // files.list: parse the q the way Drive would
    const qs = url.searchParams.get('q')!;
    const mm = /^name = '((?:[^'\\]|\\.)*)' and '((?:[^'\\]|\\.)*)' in parents and trashed = false$/.exec(qs);
    if (!mm) return new Response('bad q', { status: 400 });
    const un = (s: string) => s.replace(/\\(.)/g, '$1');
    const files = m.nodes
      .filter((n) => n.name === un(mm[1]!) && n.parent === un(mm[2]!))
      .map(({ parent: _p, ...f }) => ({ mimeType: 'application/octet-stream', ...f }));
    return Response.json({ files });
  });
  return m;
}

export async function signedReq(path: string, exp: number | string = 0, opts: { method?: string; headers?: Record<string, string>; query?: string; sigPath?: string } = {}): Promise<Request> {
  const { sign } = await import('../src/signing');
  const encoded = path.split('/').map((s, i) => (i === 0 ? s : encodeURIComponent(s))).join('/');
  const sig = await sign(KEY, opts.sigPath ?? path, exp);
  return new Request(`https://drive.example.com${encoded}?exp=${exp}&sig=${sig}${opts.query ?? ''}`, { method: opts.method, headers: opts.headers });
}
