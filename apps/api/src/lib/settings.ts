import type { Db } from './db.js';

/** Settings keys and defaults (docs/architecture.md § API). Secret values are stored encrypted by the caller. */
export const SETTING_DEFAULTS = {
  'vpn.mode': 'off' as 'off' | 'required',
  'vpn.rotation': 'manual' as 'manual' | 'interval' | 'on-failure',
  'vpn.rotationMinutes': 360,
  'vpn.activeConfigId': null as number | null,
  'limits.maxActiveJobsPerUser': 5,
  'limits.maxTorrentBytes': 0,
  'limits.minFreeDiskBytes': 2 * 1024 ** 3,
  'seeding.ratio': 0,
  'google.oauthClientId': '',
  'google.oauthClientSecret': '', // encrypted blob when set
  'cleanup.failedGraceMinutes': 60, // keep downloaded data this long after an upload failed, so "Retry" skips the re-download
  'limits.metadataTimeoutMinutes': 30, // a magnet without metadata after this long fails (0 = never)
  'seeding.maxMinutes': 0, // 0 = no cap; with seeding.ratio > 0, stop seeding after this many minutes
};
export type SettingKey = keyof typeof SETTING_DEFAULTS;
export type Settings = typeof SETTING_DEFAULTS;

export function getSetting<K extends SettingKey>(db: Db, key: K): Settings[K] {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined;
  return row ? (JSON.parse(row.value_json) as Settings[K]) : SETTING_DEFAULTS[key];
}

export function setSetting<K extends SettingKey>(db: Db, key: K, value: Settings[K]): void {
  db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
    .run(key, JSON.stringify(value));
}

export function getAllSettings(db: Db): Settings {
  const out = { ...SETTING_DEFAULTS } as Record<string, unknown>;
  for (const k of Object.keys(SETTING_DEFAULTS) as SettingKey[]) out[k] = getSetting(db, k);
  return out as Settings;
}
