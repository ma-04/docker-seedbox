import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { readFileSync } from 'node:fs';
import { connect, createServer as createTcp, type AddressInfo, type Server as TcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EgressProxy, parseAllowedPorts, type EgressPolicy } from './egress-proxy.js';
import { buildRcloneCommand, runRclone, type SpawnFn } from './rclone.js';

const bin = process.env.RCLONE_BIN || 'rclone';
const haveRclone = spawnSync(bin, ['version']).status === 0;
const realSpawn: SpawnFn = (cmd, args, opts) => spawn(cmd, args, { env: opts.env, stdio: ['ignore', 'ignore', 'pipe'] });

const toLoopback = async () => [{ address: '127.0.0.1', family: 4 }];
const listen = <T extends Server | TcpServer>(s: T): Promise<number> => new Promise((r) => (s as Server).listen(0, '127.0.0.1', () => r(((s as Server).address() as AddressInfo).port)));

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0)) await c(); });
const track = <T extends Server | TcpServer>(s: T): T => { cleanup.push(() => new Promise<void>((r) => { (s as Server).closeAllConnections?.(); s.close(() => r()); })); return s; };

async function startProxy(policy: EgressPolicy, extra: ConstructorParameters<typeof EgressProxy>[0] = {}) {
  const p = new EgressProxy({ policy, lookup: toLoopback, allowPlainHttp: true, connectTimeoutMs: 2000, ...extra });
  cleanup.push(() => p.stop());
  const port = await p.start();
  return { p, port, auth: 'Basic ' + Buffer.from(`seedbox:${p.token}`).toString('base64') };
}

/** Send one CONNECT and return the status line plus whatever the tunnel echoes back. */
function rawConnect(proxyPort: number, target: string, auth?: string, tunnelData?: string): Promise<{ status: string; data: string }> {
  return new Promise((resolve) => {
    const s = connect(proxyPort, '127.0.0.1');
    let buf = '';
    let sent = false;
    s.on('connect', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`));
    s.on('data', (d) => {
      buf += d.toString();
      if (tunnelData && !sent && buf.includes('\r\n\r\n')) { sent = true; s.write(tunnelData); }
    });
    s.on('close', () => resolve({ status: buf.split('\r\n')[0]!, data: buf.split('\r\n\r\n').slice(1).join('\r\n\r\n') }));
    s.on('error', () => undefined);
    setTimeout(() => s.destroy(), 1500);
  });
}

function viaProxy(proxyPort: number, url: string, auth?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: url, headers: { host: u.host, ...(auth ? { 'proxy-authorization': auth } : {}) } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('EgressProxy', () => {
  it('requires the per-process token (407 otherwise) for CONNECT and plain requests', async () => {
    const { port, auth } = await startProxy(() => true);
    expect((await rawConnect(port, 'example.test:443')).status).toContain('407');
    expect((await rawConnect(port, 'example.test:443', 'Basic ' + Buffer.from('seedbox:wrong').toString('base64'))).status).toContain('407');
    expect((await viaProxy(port, 'http://example.test/')).status).toBe(407);
    expect((await viaProxy(port, 'http://example.test/', 'Basic ' + Buffer.from('seedbox:nope').toString('base64'))).status).toBe(407);
    expect(auth).toContain('Basic');
  });

  it('tunnels CONNECT to an allowed address and refuses a denied address or port with 403', async () => {
    const echo = track(createTcp((s) => s.on('data', (d) => s.write(`echo:${d}`))));
    const echoPort = await listen(echo);
    const { port, auth, p } = await startProxy((a, prt) => a === '127.0.0.1' && prt === echoPort);
    const ok = await rawConnect(port, `echo.example.test:${echoPort}`, auth, 'hello');
    expect(ok.status).toContain('200');
    expect(ok.data).toContain('echo:hello');
    expect((await rawConnect(port, `echo.example.test:${echoPort + 1}`, auth)).status).toContain('403');
    expect((await rawConnect(port, 'echo.example.test:notaport', auth)).status).toContain('400');
    expect(p.denied).toContain(`echo.example.test:${echoPort + 1}`);
  });

  it('default policy: public addresses on 443/80 only, everything private or off-list is 403', async () => {
    const pub = async () => [{ address: '93.184.216.34', family: 4 }];
    const mixed = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }];
    const mk = async (lookup: typeof pub) => {
      const p = new EgressProxy({ lookup, allowedPorts: [443], connectTimeoutMs: 300 });
      cleanup.push(() => p.stop());
      return { port: await p.start(), auth: 'Basic ' + Buffer.from(`seedbox:${p.token}`).toString('base64') };
    };
    const a = await mk(pub);
    expect((await rawConnect(a.port, 'x.example.com:8443', a.auth)).status).toContain('403'); // port not allowed
    expect((await rawConnect(a.port, '127.0.0.1:443', a.auth)).status).toContain('403');      // loopback literal
    expect((await rawConnect(a.port, '[::1]:443', a.auth)).status).toContain('403');
    expect((await rawConnect(a.port, '172.31.250.1:443', a.auth)).status).toContain('403');
    expect((await rawConnect(a.port, '169.254.169.254:443', a.auth)).status).toContain('403');
    expect((await rawConnect(a.port, 'x.example.com:443', a.auth)).status).not.toContain('403'); // allowed by policy (connect then fails/times out)
    const b = await mk(mixed);
    expect((await rawConnect(b.port, 'x.example.com:443', b.auth)).status).toContain('403'); // ANY private answer denies
  });

  it('resolves once and connects to the vetted IP, so a rebinding resolver cannot swap the address', async () => {
    const hits: string[] = [];
    const srv = track(createServer((_q, r) => { hits.push('A'); r.end('real'); }));
    const portA = await listen(srv);
    let calls = 0;
    const rebind = async () => (++calls === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.9.9.9', family: 4 }]);
    const { port, auth } = await startProxy((a, prt) => a === '127.0.0.1' && prt === portA, { lookup: rebind });
    const r = await viaProxy(port, `http://rebind.example.test:${portA}/x`, auth);
    expect(r).toEqual({ status: 200, body: 'real' });
    expect(calls).toBe(1);
  });

  it('plain HTTP forwarding is off unless enabled', async () => {
    const srv = track(createServer((_q, r) => r.end('x')));
    const portA = await listen(srv);
    const p = new EgressProxy({ policy: () => true, lookup: toLoopback });
    cleanup.push(() => p.stop());
    const port = await p.start();
    expect((await viaProxy(port, `http://a.example.test:${portA}/`, 'Basic ' + Buffer.from(`seedbox:${p.token}`).toString('base64'))).status).toBe(403);
  });

  it('parses EGRESS_ALLOWED_PORTS', () => {
    expect(parseAllowedPorts(undefined)).toEqual([443, 80]);
    expect(parseAllowedPorts('443, 9000,x,70000')).toEqual([443, 9000]);
    expect(parseAllowedPorts('')).toEqual([443, 80]);
  });
});

/**
 * Real rclone against a local "S3" that 307-redirects to a second listener. Go's net/http never proxies loopback hosts,
 * so both listeners are addressed by fake hostnames that only the proxy's injected resolver maps to 127.0.0.1.
 */
describe.skipIf(!haveRclone)('real rclone through the egress proxy', () => {
  async function scenario(allowSecond: boolean) {
    const hitsA: string[] = [];
    const hitsB: string[] = [];
    let portB = 0;
    const a = track(createServer((q, r) => {
      q.resume();
      hitsA.push(`${q.method} ${q.url}`);
      r.writeHead(307, { location: `http://second.fake.test:${portB}/stolen${q.url}`, 'content-length': '0' });
      r.end();
    }));
    const b = track(createServer((q, r) => { q.resume(); hitsB.push(`${q.method} ${q.url}`); r.writeHead(403, { 'content-length': '0' }); r.end(); }));
    const portA = await listen(a);
    portB = await listen(b);
    const { p } = await startProxy((addr, prt) => addr === '127.0.0.1' && (prt === portA || (allowSecond && prt === portB)));
    const root = mkdtempSync(join(tmpdir(), 'egress-rclone-'));
    const src = join(root, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'f.txt'), 'hello');
    const cmd = buildRcloneCommand(
      { type: 's3', endpoint: `http://first.fake.test:${portA}`, region: 'us-east-1', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-secret-secret', bucket: 'bkt', forcePathStyle: true },
      src, 'job', { egress: await p.env() },
    );
    cmd.args.push('--retries', '1', '--low-level-retries', '1', '--contimeout', '3s', '--timeout', '5s');
    cmd.env.HOME = root;
    const err = await runRclone({ spawn: realSpawn, bin, cmd, onStats: () => undefined, stallMs: 20_000 }).then(() => null, (e: Error) => e);
    return { err, hitsA, hitsB, denied: p.denied, portB };
  }

  it('control: when the proxy allows the redirect target, rclone follows it (proves the proxy is used and redirects are followed)', async () => {
    const r = await scenario(true);
    expect(r.hitsA.length).toBeGreaterThan(0);
    expect(r.hitsB.length).toBeGreaterThan(0);
    expect(r.denied).toEqual([]);
  }, 60_000);

  it('a redirect to a denied target never reaches the second listener and the upload fails', async () => {
    const r = await scenario(false);
    expect(r.hitsA.length).toBeGreaterThan(0);        // the (allowed) endpoint was reached through the proxy
    expect(r.hitsB).toEqual([]);                     // the redirect target was not
    expect(r.denied.some((d) => d === `second.fake.test:${r.portB}`)).toBe(true);
    expect(r.err).toBeTruthy();
  }, 60_000);
});

/**
 * Production shape: an https endpoint, so rclone (Go) sends `CONNECT host:port` with the Proxy-Authorization from the proxy URL's
 * userinfo, then TLS through the tunnel. Self-signed certificate, so rclone runs with --no-check-certificate.
 */
const haveOpenssl = spawnSync('openssl', ['version']).status === 0;
describe.skipIf(!haveRclone || !haveOpenssl)('real rclone through the egress proxy: https (CONNECT)', () => {
  async function scenario(allowSecond: boolean) {
    const dir = mkdtempSync(join(tmpdir(), 'egress-tls-'));
    const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=first.fake.test']);
    if (gen.status !== 0) throw new Error(`openssl failed: ${gen.stderr}`);
    const tls = { key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) };
    const hitsA: string[] = [];
    const hitsB: string[] = [];
    let portB = 0;
    const a = track(createHttps(tls, (q, r) => {
      q.resume();
      hitsA.push(`${q.method} ${q.url}`);
      r.writeHead(307, { location: `https://second.fake.test:${portB}/stolen`, 'content-length': '0' });
      r.end();
    }));
    const b = track(createHttps(tls, (q, r) => { q.resume(); hitsB.push(`${q.method} ${q.url}`); r.writeHead(403, { 'content-length': '0' }); r.end(); }));
    const portA = await listen(a as unknown as Server);
    portB = await listen(b as unknown as Server);
    const { p } = await startProxy((addr, prt) => addr === '127.0.0.1' && (prt === portA || (allowSecond && prt === portB)));
    const src = join(dir, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'f.txt'), 'hello');
    const cmd = buildRcloneCommand(
      { type: 's3', endpoint: `https://first.fake.test:${portA}`, region: 'us-east-1', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-secret-secret', bucket: 'bkt', forcePathStyle: true },
      src, 'job', { egress: await p.env() },
    );
    cmd.args.push('--no-check-certificate', '--retries', '1', '--low-level-retries', '1', '--contimeout', '3s', '--timeout', '5s');
    cmd.env.HOME = dir;
    const err = await runRclone({ spawn: realSpawn, bin, cmd, onStats: () => undefined, stallMs: 20_000 }).then(() => null, (e: Error) => e);
    return { err, hitsA, hitsB, denied: p.denied, portB };
  }

  it('control: an allowed redirect target is followed through the tunnel (CONNECT + token work)', async () => {
    const r = await scenario(true);
    expect(r.hitsA.length).toBeGreaterThan(0);
    expect(r.hitsB.length).toBeGreaterThan(0);
    expect(r.denied).toEqual([]);
  }, 60_000);

  it('a CONNECT to a denied redirect target is refused: the second listener is never reached', async () => {
    const r = await scenario(false);
    expect(r.hitsA.length).toBeGreaterThan(0);
    expect(r.hitsB).toEqual([]);
    expect(r.denied).toContain(`second.fake.test:${r.portB}`);
    expect(r.err).toBeTruthy();
  }, 60_000);
});
