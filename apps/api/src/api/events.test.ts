import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { alice, GW, HEX, magnet, makeLocalDest, setup } from './testutil.js';

describe('GET /events', () => {
  it('streams job events and pings, scoped to the caller', async () => {
    const env = setup();
    const dest = await makeLocalDest(env);
    const id = (await env.call(alice, 'POST', '/api/jobs', { magnet: magnet(HEX), destinationId: dest })).json().id;
    await env.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (env.app.server.address() as AddressInfo).port;
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { 'x-gateway-secret': GW, 'remote-user': 'alice' }, signal: ac.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const until = async (re: RegExp) => {
      const t = Date.now();
      while (!re.test(buf) && Date.now() - t < 4000) buf += dec.decode((await reader.read()).value);
      expect(buf).toMatch(re);
    };
    await until(/event: job\ndata: .*"state":"queued"/);
    env.db.prepare("UPDATE torrents SET progress = 0.5, state = 'downloading'").run();
    await until(/"downloadProgress":0\.5/);
    env.db.prepare("UPDATE jobs SET state = 'downloading', updated_at = updated_at + 1 WHERE id = ?").run(id);
    await until(/"state":"downloading"/);
    await until(/event: ping/);
    ac.abort();
    await env.app.close();
  });

  it('requires auth', async () => {
    const env = setup();
    expect((await env.call(null, 'GET', '/api/events')).statusCode).toBe(401);
  });
});
