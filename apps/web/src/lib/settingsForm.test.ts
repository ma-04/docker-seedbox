import { describe, expect, it } from 'vitest';
import type { EngineSettingsDto, SettingsDto } from './api';
import { DEFAULT_LISTEN_PORT, enginePatch, engineToForm, limitsPatch, limitsToForm } from './settingsForm';

const GB = 1024 ** 3;
const settings = (o: Partial<SettingsDto> = {}): SettingsDto => ({
  'vpn.mode': 'off', 'vpn.rotation': 'manual', 'vpn.rotationMinutes': 360, 'vpn.activeConfigId': null,
  'limits.maxActiveJobsPerUser': 5, 'limits.maxTorrentBytes': 0, 'limits.minFreeDiskBytes': 2 * GB, 'seeding.ratio': 0,
  'google.oauthClientId': '', 'google.oauthClientSecret': '',
  'cleanup.failedGraceMinutes': 60, 'limits.metadataTimeoutMinutes': 30, 'seeding.maxMinutes': 0, ...o,
});

describe('limits form', () => {
  it('shows the three new settings and produces no patch when nothing changed', () => {
    const cur = settings({ 'cleanup.failedGraceMinutes': 15, 'limits.metadataTimeoutMinutes': 0, 'seeding.maxMinutes': 90 });
    const f = limitsToForm(cur);
    expect(f).toMatchObject({ failedGraceMinutes: '15', metadataTimeoutMinutes: '0', seedMaxMinutes: '90' });
    expect(limitsPatch(cur, f)).toEqual({});
  });
  it('patches only the changed keys, with the API key names', () => {
    const cur = settings();
    const f = { ...limitsToForm(cur), failedGraceMinutes: '120', metadataTimeoutMinutes: '5', seedMaxMinutes: '45', maxGb: '10' };
    expect(limitsPatch(cur, f)).toEqual({
      'cleanup.failedGraceMinutes': 120, 'limits.metadataTimeoutMinutes': 5, 'seeding.maxMinutes': 45, 'limits.maxTorrentBytes': 10 * GB,
    });
  });
});

const engine = (o: Partial<EngineSettingsDto> = {}): EngineSettingsDto => ({
  downloadLimitKBps: 0, uploadLimitKBps: 0, maxConnections: 200, maxConnectionsPerTorrent: 100, maxUploads: 20, maxUploadsPerTorrent: 4,
  queueingEnabled: true, maxActiveDownloads: 3, maxActiveUploads: 3, maxActiveTorrents: 5, dht: true, pex: true, lsd: true,
  encryption: 'prefer', anonymousMode: false, listenPort: 6881, randomPort: false, addTrackersEnabled: false, addTrackers: '', ...o,
});

describe('engine form: random listen port (issue #3)', () => {
  it('random port on (listen_port 0): shows a usable default port, nothing to save', () => {
    const cur = engine({ randomPort: true, listenPort: 0 });
    const f = engineToForm(cur);
    expect(f.randomPort).toBe(true);
    expect(f.listenPort).toBe(String(DEFAULT_LISTEN_PORT));
    expect(enginePatch(cur, f)).toEqual({});
  });
  it('unchecking random port sends randomPort:false with the default port (never 0)', () => {
    const cur = engine({ randomPort: true, listenPort: 0 });
    const f = { ...engineToForm(cur), randomPort: false };
    expect(enginePatch(cur, f)).toEqual({ randomPort: false, listenPort: 6881 });
  });
  it('unchecking and typing a port sends that port', () => {
    const cur = engine({ randomPort: true, listenPort: 0 });
    expect(enginePatch(cur, { ...engineToForm(cur), randomPort: false, listenPort: '51413' })).toEqual({ randomPort: false, listenPort: 51413 });
  });
  it('checking random port sends only randomPort:true even if the port input was edited', () => {
    const cur = engine({ randomPort: false, listenPort: 51413 });
    expect(enginePatch(cur, { ...engineToForm(cur), randomPort: true })).toEqual({ randomPort: true });
    expect(enginePatch(cur, { ...engineToForm(cur), randomPort: true, listenPort: '7000' })).toEqual({ randomPort: true });
  });
  it('a fixed port: changing it sends it, leaving it alone sends nothing', () => {
    const cur = engine({ listenPort: 51413 });
    expect(enginePatch(cur, engineToForm(cur))).toEqual({});
    expect(enginePatch(cur, { ...engineToForm(cur), listenPort: '6000' })).toEqual({ listenPort: 6000 });
  });
  it('other fields are still diffed numerically', () => {
    const cur = engine();
    expect(enginePatch(cur, { ...engineToForm(cur), maxConnections: '300', dht: false })).toEqual({ maxConnections: 300, dht: false });
  });
});
