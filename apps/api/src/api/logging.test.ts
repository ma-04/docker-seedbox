import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { deriveKey } from '../lib/crypto.js';
import { encryptConfig } from '../lib/destinations.js';
import { signedUrl } from '../lib/signing.js';
import { alice, fakeVpn, GW, HEX, makeLocalDest, root, setup } from './testutil.js';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
  return { lines, logger: { level: 'trace', stream } };
}

describe('request logging never contains credentials', () => {
  it('strips the query from a /dl request (exp/sig) and logs no secret headers', async () => {
    const cap = capture();
    const env = setup(fakeVpn(), undefined, { logger: cap.logger });
    const key = deriveKey(env.config.appSecret, 'local-links');
    env.db.prepare("INSERT INTO destinations (id, owner_user_id, name, type, config_enc, enabled, is_default, created_at) VALUES (1, NULL, 'L', 'local', ?, 1, 0, 1)")
      .run(encryptConfig(env.config.appSecret, { type: 'local', subdir: 'lib' }));
    const u = new URL(signedUrl('https://files.example.test', key, '/lib/bob/x/ok.txt', 3600, '/dl'));
    const sig = u.searchParams.get('sig')!;
    expect(sig.length).toBeGreaterThan(10);
    await env.call(null, 'GET', u.pathname + u.search, undefined, { headers: { cookie: 'session=SECRETCOOKIE', authorization: 'Bearer SECRETBEARER' } });
    const log = cap.lines.join('');
    expect(log).toContain('/dl/lib/bob/x/ok.txt'); // the request IS logged, just without its query
    for (const secret of [sig, 'exp=', 'sig=', GW, 'SECRETCOOKIE', 'SECRETBEARER', 'x-gateway-secret']) expect(log).not.toContain(secret);
  });

  it('never logs a magnet link, its passkey, the query string or auth headers on job create', async () => {
    const cap = capture();
    const env = setup(fakeVpn(), undefined, { logger: cap.logger });
    const dest = await makeLocalDest(env);
    const magnet = `magnet:?xt=urn:btih:${HEX}&dn=Secret%20Movie&tr=${encodeURIComponent('https://private.example.com/announce?passkey=PASSKEY123')}`;
    const r = await env.call(alice, 'POST', `/api/jobs?rd=RDVALUE`, { magnet, destinationId: dest }, { headers: { authorization: 'Bearer SECRETBEARER' } });
    expect(r.statusCode).toBe(201);
    await env.call(root, 'GET', '/api/admin/jobs?state=queued');
    const log = cap.lines.join('');
    expect(log).toContain('/api/jobs');
    for (const secret of ['PASSKEY123', 'passkey', 'rd=', 'RDVALUE', 'Secret%20Movie', 'magnet:', HEX, 'SECRETBEARER', GW, 'state=queued']) expect(log).not.toContain(secret);
  });

  it('logger stays off when not requested', async () => {
    const env = setup();
    expect((await env.call(null, 'GET', '/api/health')).statusCode).toBe(200);
  });
});
