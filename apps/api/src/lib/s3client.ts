/**
 * S3 SDK client factory for the API (destination test, link presigning).
 *  - `followRegionRedirects` is pinned to false: the SDK must never chase a redirect to another host.
 *  - for USER-OWNED destinations the TCP connection itself is vetted: a custom `lookup` resolves the name, refuses the
 *    connection when any answer is non-public and hands Node the vetted address, so a rebinding resolver cannot swap the
 *    address between the SSRF check and the connect. (IP-literal endpoints never resolve; assertPublicEndpoint
 *    already judged them.) Shared (admin) destinations are trusted and use the default handler.
 */
import { lookup as dnsLookup } from 'node:dns';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import type { LookupFunction } from 'node:net';
import { S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { isBlockedAddress } from './netguard.js';
import type { S3Config } from './types.js';

export type ResolveAll = (host: string) => Promise<{ address: string; family: number }[]>;

const defaultResolve: ResolveAll = (host) => new Promise((resolve, reject) => {
  dnsLookup(host, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs)));
});

export function vettedLookup(resolve: ResolveAll = defaultResolve): LookupFunction {
  return (hostname, options, cb) => {
    resolve(hostname).then((addrs) => {
      if (addrs.length === 0 || addrs.some((a) => isBlockedAddress(a.address))) {
        return cb(Object.assign(new Error('Endpoint host is not publicly routable'), { code: 'EBLOCKED' }) as NodeJS.ErrnoException, '', 4);
      }
      const want = options.family === 4 || options.family === 6 ? addrs.filter((a) => a.family === options.family) : addrs;
      const pick = want.length ? want : addrs;
      if (options.all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, pick);
      else cb(null, pick[0]!.address, pick[0]!.family);
    }, (err: NodeJS.ErrnoException) => cb(err, '', 4));
  };
}

export interface S3ClientOptions { shared: boolean; maxAttempts?: number; resolve?: ResolveAll }

export function makeS3Client(cfg: S3Config, o: S3ClientOptions): S3Client {
  const lookup = o.shared ? undefined : vettedLookup(o.resolve);
  return new S3Client({
    endpoint: cfg.endpoint, region: cfg.region, forcePathStyle: cfg.forcePathStyle ?? true,
    followRegionRedirects: false,
    ...(o.maxAttempts ? { maxAttempts: o.maxAttempts } : {}),
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    ...(lookup ? { requestHandler: new NodeHttpHandler({ httpsAgent: new HttpsAgent({ lookup }), httpAgent: new HttpAgent({ lookup }) }) } : {}),
  });
}
