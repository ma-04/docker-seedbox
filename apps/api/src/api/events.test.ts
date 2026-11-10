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

  const open = async (port: number, user: string) => {
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { 'x-gateway-secret': GW, 'remote-user': user }, signal: ac.signal });
    return { res, ac };
  };
  const drain = (res: Response) => { const r = res.body!.getReader(); let buf = ''; const dec = new TextDecoder(); let ended = false;
    void (async () => { try { for (;;) { const c = await r.read(); if (c.done) { ended = true; return; } buf += dec.decode(c.value); } } catch { ended = true; } })();
    return { text: () => buf, ended: () => ended }; };
  const until = async (f: () => boolean) => { const t = Date.now(); while (!f() && Date.now() - t < 3000) await new Promise((r) => setTimeout(r, 20)); expect(f()).toBe(true); };

  it('sends retry:, caps streams per user (oldest closed) and globally (503)', async () => {
    const env = setup(undefined, undefined, { sseMaxPerUser: 2, sseMaxTotal: 3 });
    await env.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (env.app.server.address() as AddressInfo).port;
    const a1 = await open(port, 'alice'); const d1 = drain(a1.res);
    await until(() => d1.text().includes('retry: 3000'));
    const a2 = await open(port, 'alice'); const d2 = drain(a2.res);
    const a3 = await open(port, 'alice'); const d3 = drain(a3.res);
    await until(() => d1.ended());           // oldest evicted
    expect(d2.ended()).toBe(false);
    expect(d3.ended()).toBe(false);
    const b1 = await open(port, 'bob'); const db1 = drain(b1.res);
    await until(() => db1.text().includes('retry:'));
    const c = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { 'x-gateway-secret': GW, 'remote-user': 'carol' } });
    expect(c.status).toBe(503);
    expect(c.headers.get('retry-after')).toBeTruthy();
    // a user already at their cap can still replace their own oldest stream even when the server is full
    const a4 = await open(port, 'alice'); const d4 = drain(a4.res);
    await until(() => d2.ended());
    expect(d4.ended()).toBe(false);
    for (const x of [a2, a3, a4, b1]) x.ac.abort();
    await env.app.close();
  });

  it('uses one shared poller and closes streams of users who become disabled', async () => {
    const env = setup(undefined, undefined, { sseMaxPerUser: 5 });
    await env.call({ name: 'dave' }, 'GET', '/api/me');
    await env.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (env.app.server.address() as AddressInfo).port;
    const prepared: string[] = [];
    const orig = env.db.prepare.bind(env.db);
    (env.db as unknown as { prepare: (s: string) => unknown }).prepare = (sql: string) => { if (/FROM jobs j/.test(sql)) prepared.push(sql); return orig(sql); };
    const opened = await Promise.all([open(port, 'dave'), open(port, 'dave'), open(port, 'alice')]);
    const drains = opened.map((o) => drain(o.res));
    await until(() => drains.every((d) => d.text().includes('retry:')));
    const before = prepared.length;
    await new Promise((r) => setTimeout(r, 300)); // ~6 ticks at 50ms
    const ticks = prepared.length - before;
    // One combined query per tick (~6 ticks), not one per connection per tick (3 x 6).
    expect(ticks).toBeGreaterThan(0);
    expect(ticks).toBeLessThanOrEqual(9);
    env.db.prepare("UPDATE users SET disabled = 1 WHERE username = 'dave'").run();
    await until(() => drains[0]!.ended() && drains[1]!.ended());
    expect(drains[2]!.ended()).toBe(false);
    for (const o of opened) o.ac.abort();
    await env.app.close();
  });
});
