/** Client for the VPN sidecar control API (services/vpn) plus config selection/rotation. */
import type { Config } from './config.js';
import { decrypt } from './crypto.js';
import type { Db } from './db.js';
import { getSetting, setSetting } from './settings.js';
import { now, type VpnConfigRow, type VpnStatus } from './types.js';

/** The sidecar answered with an HTTP error status. `/connect` answers 409 when its mode is `off` (nothing to connect to). */
export class VpnHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export const isVpnConflict = (e: unknown): boolean => e instanceof VpnHttpError && e.status === 409;

export interface VpnClient {
  status(): Promise<VpnStatus>;
  connect(name: string, wgConfig: string): Promise<VpnStatus>;
  disconnect(): Promise<void>;
  setMode(mode: 'off' | 'required'): Promise<void>;
  /** Companion services the sidecar probes on loopback (they are unreachable from outside its namespace). */
  companions?(): Promise<{ flaresolverr: boolean }>;
}

export function vpnClient(config: Pick<Config, 'vpnUrl' | 'vpnControlToken'>, fetchImpl: typeof fetch = fetch): VpnClient {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${config.vpnUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${config.vpnControlToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new VpnHttpError(`VPN control ${method} ${path} failed (${res.status}): ${(await res.text()).slice(0, 200)}`, res.status);
    return (await res.json().catch(() => ({}))) as T;
  }
  return {
    status: () => call('GET', '/status'),
    connect: (name, wgConfig) => call('POST', '/connect', { name, config: wgConfig }),
    disconnect: async () => { await call('POST', '/disconnect'); },
    setMode: async (mode) => { await call('POST', '/mode', { mode }); },
    companions: () => call('GET', '/companions'),
  };
}

/** Validate wg-quick text and extract the endpoint host. Throws with a user-facing message. */
export function parseWgConfig(text: string): { endpointHost: string } {
  if (text.length > 16_384) throw new Error('WireGuard config is too large');
  const has = (re: RegExp) => re.test(text);
  if (!has(/^\s*\[Interface\]/im) || !has(/^\s*\[Peer\]/im)) throw new Error('Config must contain [Interface] and [Peer] sections');
  if (!has(/^\s*PrivateKey\s*=\s*\S+/im)) throw new Error('Missing Interface PrivateKey');
  if (!has(/^\s*PublicKey\s*=\s*\S+/im)) throw new Error('Missing Peer PublicKey');
  if (has(/^\s*(PreUp|PostUp|PreDown|PostDown|SaveConfig)\s*=/im)) throw new Error('PreUp/PostUp/PreDown/PostDown/SaveConfig are not allowed');
  const m = /^\s*Endpoint\s*=\s*(\[[0-9a-f:]+\]|[^:\s]+):(\d+)\s*$/im.exec(text);
  if (!m) throw new Error('Missing or invalid Peer Endpoint');
  return { endpointHost: m[1]!.replace(/^\[|\]$/g, '') };
}

/** The enabled config to use next: `id` if given, else least-recently-used enabled config other than the active one. */
export function pickConfig(db: Db, id?: number): VpnConfigRow | null {
  if (id !== undefined) return (db.prepare('SELECT * FROM vpn_configs WHERE id = ? AND enabled = 1').get(id) as VpnConfigRow | undefined) ?? null;
  const active = getSetting(db, 'vpn.activeConfigId');
  const rows = db.prepare('SELECT * FROM vpn_configs WHERE enabled = 1 ORDER BY COALESCE(last_used_at, 0) ASC, id ASC').all() as VpnConfigRow[];
  return rows.find((r) => r.id !== active) ?? rows[0] ?? null;
}

/** Connect using config `id` (or the next one). Records last_used_at / last_error and vpn.activeConfigId. */
export async function connectVpn(db: Db, config: Config, client: VpnClient, id?: number): Promise<VpnStatus> {
  const row = pickConfig(db, id);
  if (!row) throw new Error('No enabled VPN config available');
  try {
    const status = await client.connect(row.name, decrypt(config.appSecret, row.config_enc));
    db.prepare('UPDATE vpn_configs SET last_used_at = ?, last_error = NULL WHERE id = ?').run(now(), row.id);
    setSetting(db, 'vpn.activeConfigId', row.id);
    return status;
  } catch (err) {
    // 409 = the sidecar is in `off` mode: not this config's fault.
    if (isVpnConflict(err)) throw err;
    db.prepare('UPDATE vpn_configs SET last_used_at = ?, last_error = ? WHERE id = ?').run(now(), String((err as Error).message).slice(0, 500), row.id);
    throw err;
  }
}

// ---- DB-level guard serialising the worker's reconcile and the admin's rotate --------------------------------------
// A `settings` row `vpn.lock` = {token, until}. Compare-and-set inside an IMMEDIATE transaction, so api and worker (two
// processes sharing the SQLite file) never both run a connect. The row expires, so a crashed holder cannot wedge it.
const LOCK_KEY = 'vpn.lock';
const LOCK_TTL_SEC = 60;

/** Returns a token when the lock was taken, null when someone else holds an unexpired lock. */
export function acquireVpnLock(db: Db, ttlSec = LOCK_TTL_SEC, nowSec = now()): string | null {
  const token = `${process.pid}:${Math.random().toString(36).slice(2)}`;
  return db.transaction((): string | null => {
    const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(LOCK_KEY) as { value_json: string } | undefined;
    const cur = row ? (JSON.parse(row.value_json) as { token: string; until: number }) : null;
    if (cur && cur.until > nowSec) return null;
    db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
      .run(LOCK_KEY, JSON.stringify({ token, until: nowSec + ttlSec }));
    return token;
  }).immediate();
}

/** Like acquireVpnLock, but waits up to `waitMs` (the worker holds it only while its own /connect is in flight). */
export async function acquireVpnLockWait(db: Db, waitMs: number): Promise<string | null> {
  const until = Date.now() + waitMs;
  for (;;) {
    const t = acquireVpnLock(db);
    if (t || Date.now() >= until) return t;
    await new Promise((r) => setTimeout(r, 250));
  }
}

export function releaseVpnLock(db: Db, token: string): void {
  db.transaction(() => {
    const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(LOCK_KEY) as { value_json: string } | undefined;
    if (row && (JSON.parse(row.value_json) as { token: string }).token === token) db.prepare('DELETE FROM settings WHERE key = ?').run(LOCK_KEY);
  }).immediate();
}
