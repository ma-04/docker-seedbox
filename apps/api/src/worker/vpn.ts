/** VPN reconcile: apply vpn.mode, (re)connect when down or stale, rotate per vpn.rotation. */
import type { Logger } from 'pino';
import type { Config } from '../lib/config.js';
import type { Db } from '../lib/db.js';
import { getSetting, setSetting } from '../lib/settings.js';
import { acquireVpnLock, connectVpn, isVpnConflict, releaseVpnLock, type VpnClient } from '../lib/vpn.js';
import { now, type VpnConfigRow } from '../lib/types.js';

export const HANDSHAKE_STALE_SEC = 180;

export interface VpnReconcileDeps { db: Db; config: Config; vpn: VpnClient; log: Logger }

/**
 * Connect (or rotate) without racing the admin. The reconcile decided from a status snapshot taken earlier; by now the
 * admin may have switched `vpn.mode` to `off` or be rotating by hand. So: take the DB lock (skip the pass when the admin
 * holds it), re-read the mode under it, and treat the sidecar's 409 ("mode is off") as nothing to do.
 */
async function guardedConnect(d: VpnReconcileDeps, id?: number): Promise<void> {
  const { db, config, vpn } = d;
  if (getSetting(db, 'vpn.mode') === 'off') { d.log.info('vpn: mode is off; not connecting'); return; }
  const token = acquireVpnLock(db);
  if (!token) { d.log.info('vpn: another VPN change is in progress; skipping this pass'); return; }
  try {
    if (getSetting(db, 'vpn.mode') === 'off') { d.log.info('vpn: mode is off; not connecting'); return; }
    try {
      await connectVpn(db, config, vpn, id);
    } catch (err) {
      if (isVpnConflict(err)) { d.log.info('vpn: the sidecar refused /connect (mode is off); nothing to do'); return; }
      throw err;
    }
    // The admin may have switched to off while /connect was in flight: converge on their choice.
    if (getSetting(db, 'vpn.mode') === 'off') await vpn.setMode('off');
  } finally { releaseVpnLock(db, token); }
}

/**
 * One reconcile pass. `trafficExpected` = torrents are downloading/pending; an idle WireGuard tunnel
 * legitimately has an old handshake, so staleness is only a failure signal when traffic is expected.
 * Throws on sidecar errors; the caller rate-limits logging.
 */
export async function reconcileVpn(d: VpnReconcileDeps, trafficExpected: boolean): Promise<void> {
  const { db, config, vpn } = d;
  const mode = getSetting(db, 'vpn.mode');
  let status = await vpn.status();
  // Only touch the sidecar when its mode differs: `/mode off` tears a live tunnel down, so re-asserting it blindly is harmful.
  if (status.mode !== mode) {
    await vpn.setMode(mode);
    status = { ...status, mode };
  }
  if (mode !== 'required') return;
  const enabled = (db.prepare('SELECT COUNT(*) AS n FROM vpn_configs WHERE enabled = 1').get() as { n: number }).n;

  // The active config was deleted/disabled but its tunnel is still up (the API's disconnect call may have failed):
  // drop it. Required mode stays fail-closed on the sidecar; then fall through to connect another config if any.
  const activeNow = getSetting(db, 'vpn.activeConfigId');
  if (activeNow !== null && status.name !== null && !db.prepare('SELECT 1 FROM vpn_configs WHERE id = ? AND enabled = 1').get(activeNow)) {
    d.log.warn('vpn: the active config is gone or disabled; disconnecting its tunnel');
    await vpn.disconnect();
    status = { ...status, connected: false, name: null, publicIp: null, lastHandshakeSec: null };
    setSetting(db, 'vpn.activeConfigId', null);
  }
  if (enabled === 0) return;

  const rotation = getSetting(db, 'vpn.rotation');
  const activeId = getSetting(db, 'vpn.activeConfigId');
  const stale = trafficExpected && status.connected && status.lastHandshakeSec !== null && status.lastHandshakeSec > HANDSHAKE_STALE_SEC;

  if (!status.connected || stale) {
    d.log.info({ connected: status.connected, stale }, 'vpn: reconnecting');
    // 'manual' keeps the admin's choice (reconnect the active config); other modes move on to the next one.
    const active = activeId !== null
      ? (db.prepare('SELECT * FROM vpn_configs WHERE id = ? AND enabled = 1').get(activeId) as VpnConfigRow | undefined)
      : undefined;
    await guardedConnect(d, rotation === 'manual' ? active?.id : undefined);
    return;
  }

  if (rotation === 'interval' && activeId !== null) {
    const active = db.prepare('SELECT * FROM vpn_configs WHERE id = ?').get(activeId) as VpnConfigRow | undefined;
    const minutes = getSetting(db, 'vpn.rotationMinutes');
    if (active && now() - (active.last_used_at ?? 0) > minutes * 60) {
      d.log.info('vpn: rotating (interval)');
      await guardedConnect(d);
    }
  }
}
