/** VPN reconcile: apply vpn.mode, (re)connect when down or stale, rotate per vpn.rotation. */
import type { Logger } from 'pino';
import type { Config } from '../lib/config.js';
import type { Db } from '../lib/db.js';
import { getSetting } from '../lib/settings.js';
import { connectVpn, type VpnClient } from '../lib/vpn.js';
import { now, type VpnConfigRow } from '../lib/types.js';

export const HANDSHAKE_STALE_SEC = 180;

export interface VpnReconcileDeps { db: Db; config: Config; vpn: VpnClient; log: Logger }

/**
 * One reconcile pass. `trafficExpected` = torrents are downloading/pending; an idle WireGuard tunnel
 * legitimately has an old handshake, so staleness is only a failure signal when traffic is expected.
 * Throws on sidecar errors; the caller rate-limits logging.
 */
export async function reconcileVpn(d: VpnReconcileDeps, trafficExpected: boolean): Promise<void> {
  const { db, config, vpn } = d;
  const mode = getSetting(db, 'vpn.mode');
  await vpn.setMode(mode);
  if (mode !== 'required') return;
  const enabled = (db.prepare('SELECT COUNT(*) AS n FROM vpn_configs WHERE enabled = 1').get() as { n: number }).n;
  if (enabled === 0) return;

  const status = await vpn.status();
  const rotation = getSetting(db, 'vpn.rotation');
  const activeId = getSetting(db, 'vpn.activeConfigId');
  const stale = trafficExpected && status.connected && status.lastHandshakeSec !== null && status.lastHandshakeSec > HANDSHAKE_STALE_SEC;

  if (!status.connected || stale) {
    d.log.info({ connected: status.connected, stale }, 'vpn: reconnecting');
    // 'manual' keeps the admin's choice (reconnect the active config); other modes move on to the next one.
    const active = activeId !== null
      ? (db.prepare('SELECT * FROM vpn_configs WHERE id = ? AND enabled = 1').get(activeId) as VpnConfigRow | undefined)
      : undefined;
    await connectVpn(db, config, vpn, rotation === 'manual' ? active?.id : undefined);
    return;
  }

  if (rotation === 'interval' && activeId !== null) {
    const active = db.prepare('SELECT * FROM vpn_configs WHERE id = ?').get(activeId) as VpnConfigRow | undefined;
    const minutes = getSetting(db, 'vpn.rotationMinutes');
    if (active && now() - (active.last_used_at ?? 0) > minutes * 60) {
      d.log.info('vpn: rotating (interval)');
      await connectVpn(db, config, vpn);
    }
  }
}
