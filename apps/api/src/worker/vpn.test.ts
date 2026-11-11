import { describe, expect, it } from 'vitest';
import { encrypt } from '../lib/crypto.js';
import { getSetting, setSetting } from '../lib/settings.js';
import { now } from '../lib/types.js';
import { Worker } from './loop.js';
import { FakeDownloader, FakeVpn, makeEnv, SECRET, silent } from './testkit.js';
import { reconcileVpn } from './vpn.js';
import { acquireVpnLock, releaseVpnLock, VpnHttpError } from '../lib/vpn.js';

function setup(rotation: 'manual' | 'interval' | 'on-failure') {
  const env = makeEnv();
  const vpn = new FakeVpn();
  setSetting(env.db, 'vpn.mode', 'required');
  setSetting(env.db, 'vpn.rotation', rotation);
  const add = (name: string, lastUsed: number | null) => Number(env.db.prepare(
    'INSERT INTO vpn_configs (name, config_enc, enabled, last_used_at, created_at) VALUES (?, ?, 1, ?, ?)',
  ).run(name, encrypt(SECRET, `[Interface]\n# ${name}`), lastUsed, now()).lastInsertRowid);
  const run = (traffic = true) => reconcileVpn({ db: env.db, config: env.config, vpn, log: silent }, traffic);
  return { ...env, vpn, add, run };
}

describe('vpn reconcile', () => {
  it('applies the mode and does nothing else when off', async () => {
    const s = setup('on-failure');
    setSetting(s.db, 'vpn.mode', 'off');
    s.add('one', null);
    await s.run();
    expect(s.vpn.modes).toEqual(['off']);
    expect(s.vpn.connects).toEqual([]);
    await s.run(); // already off: the sidecar is not touched again
    expect(s.vpn.modes).toEqual(['off']);
  });

  it('never re-asserts a mode the sidecar already has (setMode off tears a live tunnel down)', async () => {
    const s = setup('on-failure');
    s.add('one', null);
    s.vpn.status_ = { ...s.vpn.status_, mode: 'required', connected: true, lastHandshakeSec: 3 };
    await s.run(); await s.run();
    expect(s.vpn.modes).toEqual([]);
    setSetting(s.db, 'vpn.mode', 'off');
    await s.run(); await s.run();
    expect(s.vpn.modes).toEqual(['off']);
  });

  it('a sidecar that booted fail-closed (required) is switched to the admin mode right away, once', async () => {
    const s = setup('on-failure');
    setSetting(s.db, 'vpn.mode', 'off');
    s.vpn.status_ = { ...s.vpn.status_, mode: 'required' };
    await s.run();
    expect(s.vpn.modes).toEqual(['off']);
  });

  it('initial connect when required and not connected', async () => {
    const s = setup('on-failure');
    s.add('one', null);
    s.vpn.status_.mode = 'off'; // sidecar currently open
    await s.run();
    expect(s.vpn.modes).toEqual(['required']);
    expect(s.vpn.connects).toEqual(['one']);
  });

  it('required with no configs: sets mode, no connect', async () => {
    const s = setup('on-failure');
    s.vpn.status_.mode = 'off';
    await s.run();
    expect(s.vpn.modes).toEqual(['required']);
    expect(s.vpn.connects).toEqual([]);
  });

  it('on-failure rotates to the next config when the tunnel drops or the handshake is stale', async () => {
    const s = setup('on-failure');
    const a = s.add('a', 100);
    s.add('b', 200);
    setSetting(s.db, 'vpn.activeConfigId', a);
    s.vpn.status_ = { ...s.vpn.status_, connected: false };
    await s.run();
    expect(s.vpn.connects).toEqual(['b']);
    s.vpn.status_.lastHandshakeSec = 500;
    await s.run();
    expect(s.vpn.connects).toEqual(['b', 'a']);
    // an idle tunnel with an old handshake is fine
    s.vpn.status_.lastHandshakeSec = 500;
    await s.run(false);
    expect(s.vpn.connects).toEqual(['b', 'a']);
  });

  it('interval: rotates once the active config is older than vpn.rotationMinutes', async () => {
    const s = setup('interval');
    setSetting(s.db, 'vpn.rotationMinutes', 10);
    const a = s.add('a', now() - 60);
    s.add('b', now() - 3600);
    setSetting(s.db, 'vpn.activeConfigId', a);
    s.vpn.status_ = { ...s.vpn.status_, connected: true, lastHandshakeSec: 3 };
    await s.run();
    expect(s.vpn.connects).toEqual([]);
    s.db.prepare('UPDATE vpn_configs SET last_used_at = ? WHERE id = ?').run(now() - 11 * 60, a);
    await s.run();
    expect(s.vpn.connects).toEqual(['b']);
    expect(getSetting(s.db, 'vpn.activeConfigId')).not.toBe(a);
  });

  it('manual: reconnects the active config and never rotates', async () => {
    const s = setup('manual');
    const a = s.add('a', now() - 10 * 3600);
    s.add('b', null);
    setSetting(s.db, 'vpn.activeConfigId', a);
    setSetting(s.db, 'vpn.rotationMinutes', 1);
    s.vpn.status_ = { ...s.vpn.status_, connected: true, lastHandshakeSec: 3 };
    await s.run();
    expect(s.vpn.connects).toEqual([]); // old config, still no rotation
    s.vpn.status_.connected = false;
    await s.run();
    expect(s.vpn.connects).toEqual(['a']);
  });

  it('a tunnel whose config was deleted/disabled is disconnected, then another config is connected', async () => {
    const s = setup('on-failure');
    const a = s.add('a', 100);
    const b = s.add('b', 200);
    setSetting(s.db, 'vpn.activeConfigId', a);
    s.vpn.status_ = { ...s.vpn.status_, connected: true, name: 'a', lastHandshakeSec: 3 };
    s.db.prepare('UPDATE vpn_configs SET enabled = 0 WHERE id = ?').run(a);
    await s.run();
    expect(s.vpn.disconnects).toBe(1);
    expect(s.vpn.connects).toEqual(['b']);
    expect(getSetting(s.db, 'vpn.activeConfigId')).toBe(b);
  });

  it('with no enabled config left the orphaned tunnel is disconnected and the sidecar stays required', async () => {
    const s = setup('on-failure');
    const a = s.add('a', 100);
    setSetting(s.db, 'vpn.activeConfigId', a);
    s.vpn.status_ = { ...s.vpn.status_, connected: true, name: 'a', lastHandshakeSec: 3 };
    s.db.prepare('DELETE FROM vpn_configs WHERE id = ?').run(a);
    await s.run();
    expect(s.vpn.disconnects).toBe(1);
    expect(s.vpn.connects).toEqual([]);
    expect(s.vpn.modes).toEqual([]); // never switched to off
  });

  it('Worker.start() applies vpn.mode immediately, not after vpnEveryMs', async () => {
    const env = makeEnv();
    const vpn = new FakeVpn();
    setSetting(env.db, 'vpn.mode', 'off');
    const w = new Worker({ db: env.db, config: env.config, downloader: new FakeDownloader(), vpn, log: silent, vpnEveryMs: 1e9, tickMs: 1e9 });
    w.start();
    await w.idle();
    expect(vpn.modes).toEqual(['off']);
    await w.stop();
  });

  it('Worker.reconcileVpn never throws when the sidecar is unreachable', async () => {
    const env = makeEnv();
    const vpn = new FakeVpn();
    vpn.fail = true;
    const w = new Worker({ db: env.db, config: env.config, downloader: new FakeDownloader(), vpn, log: silent });
    await expect(w.reconcileVpn()).resolves.toBeUndefined();
  });

  describe('races with the admin', () => {
    it('re-reads vpn.mode right before connecting: an admin switch to off during the reconcile prevents /connect', async () => {
      const s = setup('on-failure');
      s.add('one', null);
      s.vpn.status_.mode = 'required';
      // the admin flips the mode to off while the reconcile is between its status snapshot and the connect decision
      const status = s.vpn.status.bind(s.vpn);
      s.vpn.status = async () => { const r = await status(); setSetting(s.db, 'vpn.mode', 'off'); return r; };
      await s.run();
      expect(s.vpn.connects).toEqual([]);
    });

    it('treats a 409 from /connect as "mode is off, nothing to do": no throw, no config error recorded', async () => {
      const s = setup('on-failure');
      const id = s.add('one', null);
      s.vpn.connect = async () => { throw new VpnHttpError('VPN control POST /connect failed (409): mode is off', 409); };
      await expect(s.run()).resolves.toBeUndefined();
      expect((s.db.prepare('SELECT last_error FROM vpn_configs WHERE id = ?').get(id) as { last_error: string | null }).last_error).toBeNull();
      // any other sidecar error is still an error
      s.vpn.connect = async () => { throw new VpnHttpError('boom (500)', 500); };
      await expect(s.run()).rejects.toThrow(/boom/);
    });

    it('is serialised with an admin rotate by the DB lock: a held lock skips the pass, an expired one does not', async () => {
      const s = setup('on-failure');
      s.add('one', null);
      const token = acquireVpnLock(s.db)!;
      expect(token).toBeTruthy();
      expect(acquireVpnLock(s.db)).toBeNull(); // compare-and-set: only one holder
      await s.run();
      expect(s.vpn.connects).toEqual([]);
      releaseVpnLock(s.db, token);
      await s.run();
      expect(s.vpn.connects).toEqual(['one']);
      expect(s.db.prepare("SELECT 1 FROM settings WHERE key = 'vpn.lock'").get()).toBeUndefined(); // released
      // an expired lock (crashed holder) does not wedge the guard, and a stale token cannot release a newer lock
      const old = acquireVpnLock(s.db, 60, now() - 120)!;
      const fresh = acquireVpnLock(s.db)!;
      expect(fresh).toBeTruthy();
      releaseVpnLock(s.db, old);
      expect(acquireVpnLock(s.db)).toBeNull();
    });

    it('converges on off when the admin switched during /connect', async () => {
      const s = setup('on-failure');
      s.add('one', null);
      const connect = s.vpn.connect.bind(s.vpn);
      s.vpn.connect = async (n: string, c: string) => { const r = await connect(n, c); setSetting(s.db, 'vpn.mode', 'off'); return r; };
      s.vpn.status_.mode = 'required';
      await s.run();
      expect(s.vpn.modes).toContain('off');
    });
  });
});
