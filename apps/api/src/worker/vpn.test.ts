import { describe, expect, it } from 'vitest';
import { encrypt } from '../lib/crypto.js';
import { getSetting, setSetting } from '../lib/settings.js';
import { now } from '../lib/types.js';
import { Worker } from './loop.js';
import { FakeDownloader, FakeVpn, makeEnv, SECRET, silent } from './testkit.js';
import { reconcileVpn } from './vpn.js';

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
  });

  it('initial connect when required and not connected', async () => {
    const s = setup('on-failure');
    s.add('one', null);
    await s.run();
    expect(s.vpn.modes).toEqual(['required']);
    expect(s.vpn.connects).toEqual(['one']);
  });

  it('required with no configs: sets mode, no connect', async () => {
    const s = setup('on-failure');
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

  it('Worker.reconcileVpn never throws when the sidecar is unreachable', async () => {
    const env = makeEnv();
    const vpn = new FakeVpn();
    vpn.fail = true;
    const w = new Worker({ db: env.db, config: env.config, downloader: new FakeDownloader(), vpn, log: silent });
    await expect(w.reconcileVpn()).resolves.toBeUndefined();
  });
});
