import { expect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { live } from './env';

// ---- run state (shared between the numbered specs; lives in e2e/.out, which is git-ignored) -----------------------
const STATE = path.resolve('.out/live/state.json');
export interface State {
  runId: string;
  jobs: Record<string, { id: number; user: string }>;
  dest: Record<string, number>;
  ips: Record<string, string>;
  [k: string]: unknown;
}
export function state(): State {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  if (!fs.existsSync(STATE)) {
    const s: State = { runId: `r${new Date().toISOString().replace(/\D/g, '').slice(2, 12)}${crypto.randomBytes(2).toString('hex')}`, jobs: {}, dest: {}, ips: {} };
    fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
  }
  return JSON.parse(fs.readFileSync(STATE, 'utf8')) as State;
}
export function save(patch: Partial<State>): State {
  const s = { ...state(), ...patch };
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
  return s;
}
export const s3Prefix = (): string => `${live.s3.prefixBase()}/${state().runId}`;

// ---- login / API ----------------------------------------------------------------------------------------------------
export type Who = 'admin' | 'user' | 'user2';
export async function login(page: Page, who: Who): Promise<void> {
  const c = who === 'admin' ? live.admin : who === 'user' ? live.user : live.user2;
  await page.goto('/');
  await expect(page).toHaveURL(new RegExp(`^${live.authURL.replace(/[.]/g, '\\.')}`));
  await page.locator('#username-textfield').fill(c.user);
  await page.locator('#password-textfield').fill(c.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByTestId('current-user')).toBeVisible({ timeout: 30_000 });
}
export interface Api { status: number; json: any; text: string }
export async function api(page: Page, method: string, url: string, body?: unknown): Promise<Api> {
  if (!page.url().startsWith(live.baseURL)) await page.goto('/');
  return page.evaluate(async ({ method, url, body }) => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (method !== 'GET') headers['X-Requested-With'] = 'seedbox';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
    const text = await r.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text };
  }, { method, url, body });
}
export const jobRow = (page: Page, id: number) => page.locator(`[data-testid="job-row"][data-job-id="${id}"]`);

// ---- the Docker host over ssh (out-of-band checks only; credentials never travel this way) -------------------------
export function sh(cmd: string, timeoutMs = 120_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('ssh', ['-i', live.ssh.key().replace(/^~/, process.env.HOME ?? ''), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', live.ssh.target(), cmd],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (e, out, err) => resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out: String(out), err: String(err) }));
  });
}
export const compose = (args: string, t = 240_000) => sh(`cd ${live.ssh.dir}/deploy && sudo docker compose ${args}`, t);
/** A shell command executed inside the qbittorrent container (the VPN network namespace). */
export const inQbt = (cmd: string, t = 60_000) => sh(`sudo docker exec seedbox-qbittorrent-1 sh -c '${cmd.replace(/'/g, "'\\''")}'`, t);
export async function qbtJson<T = any>(p: string): Promise<T> {
  const r = await inQbt(`curl -fsS -m 10 http://127.0.0.1:8080${p}`);
  if (r.code !== 0) throw new Error(`qbt ${p}: ${r.err || r.out}`);
  return JSON.parse(r.out) as T;
}
export async function serverEgressIp(): Promise<string> {
  const r = await sh('curl -4 -fsS -m 15 https://api.ipify.org');
  return r.out.trim();
}
export const serverDnsIp = async (): Promise<string> => (await dns.lookup(live.domain, { family: 4 })).address;
export const mask = (ip: string | null | undefined): string => (ip ? `${ip.split('.').slice(0, 2).join('.')}.x.x` : String(ip));

// ---- plain HTTPS without a browser (signed links, Range, tampering) -------------------------------------------------
export interface Fetched { status: number; headers: Record<string, string | string[] | undefined>; sha256: string; bytes: number; head: Buffer }
export function fetchHash(url: string, headers: Record<string, string> = {}, opts: { method?: string } = {}): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: opts.method ?? 'GET', headers: { 'accept-encoding': 'identity', ...headers } }, (res) => {
      const h = crypto.createHash('sha256');
      let bytes = 0; const head: Buffer[] = []; let headLen = 0;
      res.on('data', (c: Buffer) => { h.update(c); bytes += c.length; if (headLen < 512) { head.push(c); headLen += c.length; } });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, sha256: h.digest('hex'), bytes, head: Buffer.concat(head) }));
      res.on('error', reject);
    });
    req.setTimeout(10 * 60_000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
export async function getText(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.text();
}
export async function getBuffer(url: string): Promise<Buffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// ---- official torrents ------------------------------------------------------------------------------------------------
export interface Official { name: string; torrent: Buffer; sha256: string; size?: number }

/**
 * Adds HTTP web seeds (`url-list`) to a .torrent. The key lives outside the `info` dictionary, so the infohash and the
 * content are exactly the distro's own; libtorrent then also pulls pieces from the project's HTTPS mirror. Opt-in
 * (LIVE_WEBSEEDS=1) for VPNs that throttle or block BitTorrent peers (free tiers) but pass plain HTTPS.
 */
export function withWebSeeds(torrent: Buffer, urls: string[]): Buffer {
  if (!urls.length) return torrent;
  const b = (s: string) => Buffer.from(s, 'latin1');
  if (torrent[0] !== 0x64) throw new Error('not a bencoded dictionary');
  // walk the top-level dictionary to find where the key `url-list` has to be inserted (keys are sorted)
  let i = 1;
  const readInt = (): number => { const e = torrent.indexOf(0x3a, i); const n = Number(torrent.subarray(i, e).toString()); i = e + 1; return n; };
  const skip = (): void => {
    const c = torrent[i]!;
    if (c === 0x69) { i = torrent.indexOf(0x65, i) + 1; return; }
    if (c === 0x6c || c === 0x64) { i++; while (torrent[i] !== 0x65) skip(); i++; return; }
    const n = readInt(); i += n;
  };
  let insertAt = -1;
  while (torrent[i] !== 0x65) {
    const keyStart = i;
    const n = readInt(); const key = torrent.subarray(i, i + n).toString('latin1'); i += n;
    if (insertAt < 0 && key > 'url-list') insertAt = keyStart;
    if (key === 'url-list') return torrent;   // already has some
    skip();
  }
  if (insertAt < 0) insertAt = i;   // before the closing `e`
  const list = Buffer.concat([b('8:url-listl'), ...urls.map((u) => b(`${u.length}:${u}`)), b('e')]);
  return Buffer.concat([torrent.subarray(0, insertAt), list, torrent.subarray(insertAt)]);
}
const webSeedsOn = (): boolean => process.env.LIVE_WEBSEEDS === '1';
/** Official HTTPS mirror directories (plus LIVE_WEBSEEDS_UBUNTU / LIVE_WEBSEEDS_DEBIAN: comma separated extra directory URLs). */
const seedUrls = (name: string, defaults: string[], extra: string | undefined): string[] =>
  [...defaults, ...(extra ?? '').split(',').map((x) => x.trim()).filter(Boolean)].map((b) => `${b.replace(/\/+$/, '')}/${name}`);
const ver = (s: string) => s.split('.').map(Number);
const cmp = (a: string, b: string) => { const x = ver(a), y = ver(b); for (let i = 0; i < 3; i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; } return 0; };
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function sumFor(sums: string, name: string): string {
  const sha = new RegExp(`^([0-9a-f]{64}) [ *]${esc(name)}$`, 'm').exec(sums)?.[1];
  if (!sha) throw new Error(`no sha256 for ${name} in SHA256SUMS`);
  return sha;
}
/** Current Ubuntu Server LTS (highest NN.04[.N] directory that has a live-server ISO torrent), from releases.ubuntu.com. */
export async function ubuntuLts(): Promise<Official> {
  const idx = await getText('https://releases.ubuntu.com/');
  const dirs = [...new Set([...idx.matchAll(/href="(\d\d\.04(?:\.\d+)?)\/"/g)].map((m) => m[1]!))].sort(cmp).reverse();
  for (const d of dirs) {
    const listing = await getText(`https://releases.ubuntu.com/${d}/`);
    const t = new RegExp(`ubuntu-${esc(d)}-live-server-amd64\\.iso\\.torrent`).exec(listing)?.[0];
    if (!t) continue;
    const name = t.replace(/\.torrent$/, '');
    const sha256 = sumFor(await getText(`https://releases.ubuntu.com/${d}/SHA256SUMS`), name);
    const torrent = await getBuffer(`https://releases.ubuntu.com/${d}/${t}`);
    return { name, torrent: webSeedsOn() ? withWebSeeds(torrent, seedUrls(name, [`https://releases.ubuntu.com/${d}`], process.env.LIVE_WEBSEEDS_UBUNTU)) : torrent, sha256 };
  }
  throw new Error('no Ubuntu LTS server torrent found');
}
/** Debian netinst, from cdimage.debian.org. */
export async function debianNetinst(): Promise<Official> {
  const base = 'https://cdimage.debian.org/debian-cd/current/amd64';
  const listing = await getText(`${base}/bt-cd/`);
  const t = /debian-[\d.]+-amd64-netinst\.iso\.torrent/.exec(listing)?.[0];
  if (!t) throw new Error('no Debian netinst torrent found');
  const name = t.replace(/\.torrent$/, '');
  const sha256 = sumFor(await getText(`${base}/iso-cd/SHA256SUMS`), name);
  const torrent = await getBuffer(`${base}/bt-cd/${t}`);
  return { name, torrent: webSeedsOn() ? withWebSeeds(torrent, seedUrls(name, ['https://deb.debian.org/debian-cd/current/amd64/iso-cd'], process.env.LIVE_WEBSEEDS_DEBIAN)) : torrent, sha256 };
}

// ---- rclone (local, with the git-ignored credentials; used only for verification and run-scoped cleanup) --------------
export function rclone(args: string[], timeoutMs = 300_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('rclone', ['--config', live.rcloneConf(), ...args], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (e, out, err) =>
      resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out: String(out), err: String(err) }));
  });
}
export function rcloneSection(name: string): string {
  const lines = fs.readFileSync(live.rcloneConf(), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.trim() === `[${name}]`);
  if (start < 0) throw new Error(`rclone section [${name}] not found`);
  let end = lines.findIndex((l, i) => i > start && /^\s*\[.+\]\s*$/.test(l));
  if (end < 0) end = lines.length;
  return `${lines.slice(start, end).join('\n').trim()}\n`;
}
export function rcloneValue(section: string, key: string): string {
  const m = new RegExp(`^${key}\\s*=\\s*(.*)$`, 'm').exec(section);
  if (!m) throw new Error(`${key} missing in rclone section`);
  return m[1]!.trim();
}
export function signingKey(): string {
  const m = /^SIGNING_KEY=(.*)$/m.exec(fs.readFileSync(live.proxyEnvFile(), 'utf8'));
  if (!m) throw new Error('SIGNING_KEY missing');
  return m[1]!.trim();
}

/** Records evidence in the report and on stdout (the list reporter shows it). */
export function note(ti: import('@playwright/test').TestInfo, type: string, description: string): void {
  ti.annotations.push({ type, description });
  console.log(`[${type}] ${description}`);
}
