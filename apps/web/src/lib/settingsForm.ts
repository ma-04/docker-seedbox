import type { EngineSettingsDto, EngineSettingsUpdateDto, SettingsDto } from './api';
import { bytesToGb, gbToBytes } from './format';

/** Text-input state of Admin -> Settings (limits and seeding). */
export interface LimitsForm {
  maxJobs: string; maxGb: string; minFreeGb: string; ratio: string;
  seedMaxMinutes: string; failedGraceMinutes: string; metadataTimeoutMinutes: string;
}

export const limitsToForm = (d: SettingsDto): LimitsForm => ({
  maxJobs: String(d['limits.maxActiveJobsPerUser']),
  maxGb: String(bytesToGb(d['limits.maxTorrentBytes'])),
  minFreeGb: String(bytesToGb(d['limits.minFreeDiskBytes'])),
  ratio: String(d['seeding.ratio']),
  seedMaxMinutes: String(d['seeding.maxMinutes']),
  failedGraceMinutes: String(d['cleanup.failedGraceMinutes']),
  metadataTimeoutMinutes: String(d['limits.metadataTimeoutMinutes']),
});

/** Only the settings that differ from the stored ones. */
export function limitsPatch(cur: SettingsDto, f: LimitsForm): Partial<SettingsDto> {
  const want: Partial<SettingsDto> = {
    'limits.maxActiveJobsPerUser': Number(f.maxJobs),
    'limits.maxTorrentBytes': gbToBytes(Number(f.maxGb)),
    'limits.minFreeDiskBytes': gbToBytes(Number(f.minFreeGb)),
    'seeding.ratio': Number(f.ratio),
    'seeding.maxMinutes': Number(f.seedMaxMinutes),
    'cleanup.failedGraceMinutes': Number(f.failedGraceMinutes),
    'limits.metadataTimeoutMinutes': Number(f.metadataTimeoutMinutes),
  };
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(want)) if (v !== (cur as unknown as Record<string, unknown>)[k]) patch[k] = v;
  return patch as Partial<SettingsDto>;
}

/** Port shown/sent when "random port" is switched off and the engine has none (qBittorrent reports 0 for random). */
export const DEFAULT_LISTEN_PORT = 6881;

export type EngineForm = Record<keyof EngineSettingsDto, string | boolean>;
export const ENGINE_NUM_KEYS = ['downloadLimitKBps', 'uploadLimitKBps', 'maxConnections', 'maxConnectionsPerTorrent', 'maxUploads', 'maxUploadsPerTorrent',
  'maxActiveDownloads', 'maxActiveUploads', 'maxActiveTorrents', 'listenPort'] as const;

export const engineToForm = (d: EngineSettingsDto): EngineForm => {
  const f = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === 'number' ? String(v) : v])) as EngineForm;
  // Random port reads back as listen_port 0: show a usable port for when the box gets unchecked.
  if (d.listenPort < 1024) f.listenPort = String(DEFAULT_LISTEN_PORT);
  return f;
};

export function enginePatch(cur: EngineSettingsDto, f: EngineForm): EngineSettingsUpdateDto {
  const patch: Record<string, unknown> = {};
  for (const k of Object.keys(cur) as (keyof EngineSettingsDto)[]) {
    if (k === 'listenPort') continue; // handled below
    const v = (ENGINE_NUM_KEYS as readonly string[]).includes(k) ? Number(f[k]) : f[k];
    if (v !== cur[k]) patch[k] = v;
  }
  if (f.randomPort) return patch as EngineSettingsUpdateDto; // the port input is disabled; the API sends listen_port 0
  const port = Number(f.listenPort);
  // Turning random off always needs an explicit port.
  if (cur.randomPort || port !== cur.listenPort) patch.listenPort = port;
  return patch as EngineSettingsUpdateDto;
}
