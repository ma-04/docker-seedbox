import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { makeS3Client, vettedLookup } from './s3client.js';
import type { S3Config } from './types.js';

const cfg = (endpoint: string): S3Config => ({ type: 's3', endpoint, region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 'SK', bucket: 'b' });
const call = (l: ReturnType<typeof vettedLookup>, host: string, opts: object = {}) =>
  new Promise<{ err: NodeJS.ErrnoException | null; res: unknown }>((resolve) => {
    (l as unknown as (h: string, o: object, cb: (e: NodeJS.ErrnoException | null, ...r: unknown[]) => void) => void)(host, opts, (err, ...r) => resolve({ err, res: r.length > 1 ? r : r[0] }));
  });

describe('S3 client factory', () => {
  it('pins followRegionRedirects to false for shared and user-owned destinations', async () => {
    for (const shared of [true, false]) {
      expect(await Promise.resolve(makeS3Client(cfg('https://s3.example.test'), { shared }).config.followRegionRedirects)).toBe(false);
    }
  });

  it('never follows an HTTP redirect to another host', async () => {
    let second = 0;
    const b = createServer((_q, r) => { second++; r.end('x'); });
    await new Promise<void>((r) => b.listen(0, '127.0.0.1', r));
    const a = createServer((_q, r) => { r.writeHead(307, { location: `http://127.0.0.1:${(b.address() as AddressInfo).port}/x` }); r.end(); });
    await new Promise<void>((r) => a.listen(0, '127.0.0.1', r));
    const client = makeS3Client(cfg(`http://127.0.0.1:${(a.address() as AddressInfo).port}`), { shared: true, maxAttempts: 1 });
    await expect(client.send(new ListObjectsV2Command({ Bucket: 'b' }))).rejects.toBeDefined();
    client.destroy();
    a.close(); b.close();
    expect(second).toBe(0);
  });

  it('user-owned: refuses to connect when the name resolves to a non-public address (rebinding), without reaching the listener', async () => {
    let hits = 0;
    const srv = createServer((_q, r) => { hits++; r.end('x'); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    const client = makeS3Client(cfg(`http://rebind.example.test:${port}`), { shared: false, maxAttempts: 1, resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
    const err = await client.send(new ListObjectsV2Command({ Bucket: 'b' })).then(() => null, (e: Error & { code?: string }) => e);
    client.destroy();
    srv.close();
    expect(err).toBeTruthy();
    expect(hits).toBe(0);
  });
});

describe('vettedLookup', () => {
  it('passes a public answer through, in both the single and the `all` callback shapes', async () => {
    const l = vettedLookup(async () => [{ address: '93.184.216.34', family: 4 }]);
    expect((await call(l, 'x.example.com', {})).res).toEqual(['93.184.216.34', 4]);
    expect((await call(l, 'x.example.com', { all: true })).res).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });
  it.each(['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', 'fd00::1', '64:ff9b::7f00:1'])('rejects %s, and ANY private answer among public ones', async (bad) => {
    const only = await call(vettedLookup(async () => [{ address: bad, family: bad.includes(':') ? 6 : 4 }]), 'x.example.com');
    expect(only.err?.code).toBe('EBLOCKED');
    const mixed = await call(vettedLookup(async () => [{ address: '93.184.216.34', family: 4 }, { address: bad, family: bad.includes(':') ? 6 : 4 }]), 'x.example.com', { all: true });
    expect(mixed.err?.code).toBe('EBLOCKED');
  });
  it('propagates resolver errors', async () => {
    const r = await call(vettedLookup(async () => { throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); }), 'x.example.com');
    expect(r.err?.code).toBe('ENOTFOUND');
  });
});
