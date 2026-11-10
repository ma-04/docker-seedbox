/** Client for the VPN sidecar control API (services/vpn) plus config selection/rotation. */
import type { Config } from './config.js';
import { decrypt } from './crypto.js';
import type { Db } from './db.js';
import { getSetting, setSetting } from './settings.js';
import { now, type VpnConfigRow, type VpnStatus } from './types.js';

export interface VpnClient {
  status(): Promise<VpnStatus>;
  connect(name: string, wgConfig: string): Promise<VpnStatus>;
  disconnect(): Promise<void>;
  setMode(mode: 'off' | 'required'): Promise<void>;
}

export function vpnClient(config: Pick<Config, 'vpnUrl' | 'vpnControlToken'>, fetchImpl: typeof fetch = fetch): VpnClient {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${config.vpnUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${config.vpnControlToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`VPN control ${method} ${path} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return (await res.json().catch(() => ({}))) as T;
  }
  return {
    status: () => call('GET', '/status'),
    connect: (name, wgConfig) => call('POST', '/connect', { name, config: wgConfig }),
    disconnect: async () => { await call('POST', '/disconnect'); },
    setMode: async (mode) => { await call('POST', '/mode', { mode }); },
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
    db.prepare('UPDATE vpn_configs SET last_used_at = ?, last_error = ? WHERE id = ?').run(now(), String((err as Error).message).slice(0, 500), row.id);
    throw err;
  }
}
