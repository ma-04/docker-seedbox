/**
 * In-process forward proxy for rclone uploads to USER-OWNED destinations (docs/architecture.md § Egress proxy).
 *
 * Why: the SSRF guard checks the endpoint once, but rclone follows HTTP redirects (https://evil.example -> 307 ->
 * http://<internal>) and resolves names again when it connects (DNS rebinding). Routing rclone through this proxy
 * means every connection rclone makes, including redirect targets, is vetted at connect time:
 *   1. the target name is resolved HERE, every returned address must be allowed (netguard rules) and the port must be
 *      in the allow-list, otherwise 403;
 *   2. the upstream socket is opened to the vetted IP literal, never to the name, so the answer cannot change
 *      between check and connect.
 * Supports `CONNECT host:port` (HTTPS) and absolute-URI plain HTTP requests (only when `allowPlainHttp`).
 * Binds 127.0.0.1 on an ephemeral port, started lazily, requires a random per-process `Proxy-Authorization` so other
 * local processes cannot use it as an SSRF gadget. No dependencies.
 *
 * Known gap: Go's net/http never proxies requests whose host is `localhost` or a loopback IP, so a redirect to
 * loopback bypasses this proxy (it reaches only the worker container's own loopback, where nothing but this
 * token-protected proxy listens). Private/link-local/other internal targets are all proxied and refused.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent, createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, isIP, type AddressInfo, type Socket } from 'node:net';
import { isBlockedAddress } from '../lib/netguard.js';

export type EgressLookup = (host: string) => Promise<{ address: string; family: number }[]>;
/** Return true to allow a connection to this vetted address and port. */
export type EgressPolicy = (address: string, port: number) => boolean;

export interface EgressProxyOptions {
  /** Test seam: replaces the whole address/port policy. Default: public address (lib/netguard) and port in `allowedPorts`. */
  policy?: EgressPolicy;
  lookup?: EgressLookup;
  /** Default 443,80 (env EGRESS_ALLOWED_PORTS, comma separated). */
  allowedPorts?: number[];
  /** Forward plain `http://` absolute-URI requests. Default false: user destinations must use https. */
  allowPlainHttp?: boolean;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  token?: string;
}

const defaultLookup: EgressLookup = (host) => dnsLookup(host, { all: true, verbatim: true });

export function parseAllowedPorts(raw: string | undefined): number[] {
  const ports = (raw ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
  return ports.length ? ports : [443, 80];
}

const HOP_BY_HOP = new Set(['connection', 'proxy-connection', 'proxy-authorization', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

export class EgressProxy {
  readonly token: string;
  private server: Server | null = null;
  private starting: Promise<number> | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly policy: EgressPolicy;
  private readonly lookup: EgressLookup;
  private readonly allowPlainHttp: boolean;
  private readonly connectTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  /** Denied attempts (host:port), for logging/tests. */
  readonly denied: string[] = [];

  constructor(opts: EgressProxyOptions = {}) {
    const ports = new Set(opts.allowedPorts ?? parseAllowedPorts(process.env.EGRESS_ALLOWED_PORTS));
    this.policy = opts.policy ?? ((addr, port) => ports.has(port) && !isBlockedAddress(addr));
    this.lookup = opts.lookup ?? defaultLookup;
    this.allowPlainHttp = opts.allowPlainHttp ?? process.env.EGRESS_ALLOW_PLAIN_HTTP === '1';
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60_000;
    this.token = opts.token ?? randomBytes(24).toString('hex');
  }

  /** Start on first use; returns the proxy URL (with credentials) to hand to ONE rclone child. */
  async url(): Promise<string> {
    const port = await this.start();
    return `http://seedbox:${this.token}@127.0.0.1:${port}`;
  }

  /** Environment for the rclone child. NO_PROXY is empty so nothing is exempted by the environment. */
  async env(): Promise<{ env: NodeJS.ProcessEnv; secrets: string[] }> {
    const u = await this.url();
    return { env: { HTTPS_PROXY: u, HTTP_PROXY: u, https_proxy: u, http_proxy: u, NO_PROXY: '', no_proxy: '' }, secrets: [this.token] };
  }

  start(): Promise<number> {
    if (this.server) return Promise.resolve((this.server.address() as AddressInfo).port);
    this.starting ??= new Promise<number>((resolve, reject) => {
      const s = createServer((req, res) => void this.onRequest(req, res));
      s.on('connect', (req, socket, head) => void this.onConnect(req, socket as Socket, head));
      s.on('connection', (sock) => { this.sockets.add(sock); sock.on('close', () => this.sockets.delete(sock)); });
      s.on('clientError', (_e, sock) => { if (sock.writable) sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); else sock.destroy(); });
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => { this.server = s; resolve((s.address() as AddressInfo).port); });
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.starting = null;
    for (const sock of this.sockets) sock.destroy();
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  private authorised(header: string | string[] | undefined): boolean {
    if (typeof header !== 'string') return false;
    const m = /^Basic\s+(\S+)$/i.exec(header);
    if (!m) return false;
    const given = Buffer.from(Buffer.from(m[1]!, 'base64').toString('utf8').split(':').slice(1).join(':'));
    const want = Buffer.from(this.token);
    return given.length === want.length && timingSafeEqual(given, want);
  }

  /** Resolve `host` and vet EVERY address. Returns the addresses to connect to (IP literals), or null when denied. */
  private async vet(host: string, port: number): Promise<string[] | null> {
    const h = host.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    const deny = () => { this.denied.push(`${h}:${port}`); return null; };
    if (!h) return deny();
    let addrs: string[];
    if (isIP(h)) addrs = [h];
    else {
      try { addrs = (await this.lookup(h)).map((a) => a.address); } catch { return deny(); }
    }
    if (addrs.length === 0 || addrs.some((a) => isIP(a) === 0 || !this.policy(a, port))) return deny();
    return addrs;
  }

  /** Open a socket to the first reachable vetted address. */
  private open(addrs: string[], port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      let i = 0;
      const next = (): void => {
        if (i >= addrs.length) return reject(new Error('connect failed'));
        const sock = connect({ host: addrs[i++]!, port });
        const timer = setTimeout(() => sock.destroy(new Error('connect timeout')), this.connectTimeoutMs);
        sock.once('connect', () => { clearTimeout(timer); sock.setTimeout(this.idleTimeoutMs, () => sock.destroy()); resolve(sock); });
        sock.once('error', () => { clearTimeout(timer); sock.destroy(); next(); });
      };
      next();
    });
  }

  private async onConnect(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    client.on('error', () => client.destroy());
    client.setTimeout(this.idleTimeoutMs, () => client.destroy());
    const refuse = (line: string): void => { client.end(`HTTP/1.1 ${line}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    if (!this.authorised(req.headers['proxy-authorization'])) return refuse('407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="egress"');
    const m = /^(\[[0-9a-fA-F:.]+\]|[^:\s]+):(\d{1,5})$/.exec(req.url ?? '');
    if (!m) return refuse('400 Bad Request');
    const port = Number(m[2]);
    const addrs = port > 0 && port < 65536 ? await this.vet(m[1]!, port) : null;
    if (!addrs) return refuse('403 Forbidden');
    let upstream: Socket;
    try { upstream = await this.open(addrs, port); } catch { return refuse('502 Bad Gateway'); }
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fail = (code: number, msg: string, headers: Record<string, string> = {}): void => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(code, { 'content-type': 'text/plain', connection: 'close', ...headers });
      res.end(msg);
    };
    if (!this.authorised(req.headers['proxy-authorization'])) return fail(407, 'proxy authentication required', { 'proxy-authenticate': 'Basic realm="egress"' });
    let u: URL;
    try { u = new URL(req.url ?? ''); } catch { return fail(400, 'absolute-form request target required'); }
    if (u.protocol !== 'http:' || !this.allowPlainHttp) return fail(403, 'forbidden');
    const port = u.port ? Number(u.port) : 80;
    const addrs = await this.vet(u.hostname, port);
    if (!addrs) return fail(403, 'forbidden');
    let sock: Socket;
    try { sock = await this.open(addrs, port); } catch { return fail(502, 'bad gateway'); }
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) headers[k] = v;
    headers.host = u.host;
    // A one-shot agent whose only socket is the vetted, already connected one (so Node never resolves or connects itself).
    const agent = new Agent({ keepAlive: false });
    (agent as unknown as { createConnection: () => Socket }).createConnection = () => sock;
    const up = httpRequest({ method: req.method, path: u.pathname + u.search, headers, agent });
    up.on('response', (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on('error', () => fail(502, 'bad gateway'));
    res.on('close', () => up.destroy());
    req.pipe(up);
  }
}
