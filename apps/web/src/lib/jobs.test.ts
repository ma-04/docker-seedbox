import { describe, expect, it } from 'vitest';
import type { JobDto } from './api';
import { filterJobs, jobStep, mergeJob, removeNotice } from './jobs';

const mk = (id: number, over: Partial<JobDto> = {}): JobDto => ({
  id, state: 'queued', name: null, infohash: 'a'.repeat(40), totalSize: 0, downloadProgress: 0, downloadSpeed: 0,
  uploadProgress: 0, uploadSpeed: 0, destination: { id: 1, name: 'd', type: 'local' }, error: null, folderUrl: null,
  createdAt: 100 + id, updatedAt: 100 + id, completedAt: null, stage: null, ...over,
});

describe('mergeJob', () => {
  it('inserts unknown jobs newest first', () => {
    expect(mergeJob([mk(1)], mk(2)).map((j) => j.id)).toEqual([2, 1]);
    expect(mergeJob(undefined, mk(1))).toHaveLength(1);
  });
  it('replaces by id', () => {
    const out = mergeJob([mk(1), mk(2)], mk(2, { state: 'downloading', updatedAt: 500 }));
    expect(out).toHaveLength(2);
    expect(out.find((j) => j.id === 2)?.state).toBe('downloading');
  });
  it('ignores stale events', () => {
    const cur = [mk(1, { state: 'completed', updatedAt: 900 })];
    expect(mergeJob(cur, mk(1, { state: 'downloading', updatedAt: 800 }))).toBe(cur);
  });
});

describe('filterJobs', () => {
  const list = [mk(1, { state: 'downloading' }), mk(2, { state: 'completed' }), mk(3, { state: 'failed' }), mk(4, { state: 'cancelled' })];
  it('filters', () => {
    expect(filterJobs(list, 'all')).toHaveLength(4);
    expect(filterJobs(list, 'active').map((j) => j.id)).toEqual([1]);
    expect(filterJobs(list, 'completed').map((j) => j.id)).toEqual([2]);
    expect(filterJobs(list, 'failed').map((j) => j.id)).toEqual([3, 4]);
  });
});

describe('removeNotice', () => {
  const dest = (type: JobDto['destination']['type']) => ({ id: 1, name: 'My dest', type });
  it('needs no confirmation when nothing was delivered', () => {
    for (const state of ['queued', 'downloading', 'uploading', 'failed', 'cancelled'] as const) expect(removeNotice({ state, destination: dest('local') }, true)).toBeNull();
  });
  it('local: files are deleted', () => {
    expect(removeNotice({ state: 'completed', destination: dest('local') }, false)).toMatch(/deleted from the server/);
  });
  it('remote: kept unless the S3 setting is on; Drive is always kept', () => {
    expect(removeNotice({ state: 'completed', destination: dest('s3') }, false)).toMatch(/are kept/);
    expect(removeNotice({ state: 'completed', destination: dest('s3') }, true)).toMatch(/will be deleted from "My dest"/);
    expect(removeNotice({ state: 'completed', destination: dest('gdrive') }, true)).toMatch(/are kept/);
  });
});

describe('jobStep', () => {
  const NOW = 10_000;
  const st = (o: Partial<NonNullable<JobDto['stage']>>): JobDto['stage'] => ({ stage: null, seeds: 0, peers: 0, seedsTotal: 0, lastProgressAt: NOW, ...o });
  const step = (over: Partial<JobDto>) => jobStep(mk(1, over), NOW);

  it('queued jobs say what they wait on', () => {
    expect(step({})).toMatchObject({ index: 0, message: 'Waiting to start', stuck: false });
    expect(step({ stage: st({ stage: 'waiting-vpn', lastProgressAt: null }) })).toMatchObject({ index: 0, stuck: true, message: expect.stringMatching(/VPN/) });
    expect(step({ stage: st({ stage: 'waiting-disk' }) })).toMatchObject({ index: 0, stuck: true, message: expect.stringMatching(/disk space/) });
    expect(step({ stage: st({ stage: 'adding' }) })).toMatchObject({ index: 1, stuck: false });
  });

  it('metadata: connecting step, stuck after 5 minutes without the file list', () => {
    expect(step({ state: 'downloading', stage: st({ stage: 'metadata', peers: 2, lastProgressAt: NOW - 60 }) }))
      .toMatchObject({ index: 1, stuck: false, message: "Getting the torrent's file list from peers (2 peers connected)" });
    expect(step({ state: 'downloading', stage: st({ stage: 'metadata', lastProgressAt: NOW - 600 }) }))
      .toMatchObject({ index: 1, stuck: true, message: "No peer has sent the torrent's file list after 10m (no peers found yet)" });
  });

  it('downloading shows the swarm; no progress for 5+ minutes is stuck', () => {
    expect(step({ state: 'downloading', stage: st({ stage: 'downloading', seeds: 5, peers: 1, seedsTotal: 49 }) }))
      .toMatchObject({ index: 2, stuck: false, message: '5 of 49 seeds connected, 1 other peer' });
    expect(step({ state: 'downloading', stage: st({ stage: 'downloading', seeds: 5, seedsTotal: 3 }) })!.message).toBe('5 seeds connected');
    expect(step({ state: 'downloading', stage: st({ stage: 'stalled', seeds: 0, seedsTotal: 49, lastProgressAt: NOW - 30 }) }))
      .toMatchObject({ index: 2, stuck: false, message: 'Waiting for peers to send data: 0 of 49 seeds connected' });
    expect(step({ state: 'downloading', stage: st({ stage: 'stalled', seeds: 1, lastProgressAt: NOW - 12 * 60 }) }))
      .toMatchObject({ index: 2, stuck: true, message: 'No progress for 12m: 1 seed connected' });
    expect(step({ state: 'downloading', stage: st({ stage: 'paused' }) })).toMatchObject({ index: 2, stuck: true });
    expect(step({ state: 'downloading', stage: st({ stage: 'waiting-engine' }) })).toMatchObject({ index: 2, stuck: true });
    expect(step({ state: 'downloading', stage: st({ stage: 'waiting-vpn' }) })).toMatchObject({ index: 1, stuck: true, message: expect.stringMatching(/VPN/) });
  });

  it('a finished download waiting for its upload is on the upload step, not "connecting"', () => {
    expect(step({ state: 'downloading', downloadProgress: 1, stage: null })).toMatchObject({ index: 3, stuck: false });
    expect(step({ state: 'downloading', downloadProgress: 0, stage: null })).toMatchObject({ index: 1 });
  });

  it('later steps, local destinations say Saving, failed jobs have no step', () => {
    expect(step({ state: 'uploading', destination: { id: 1, name: 'Drive', type: 'gdrive' } })).toMatchObject({ index: 3, message: 'Uploading to Drive' });
    expect(step({ state: 'uploading' })!.steps[3]).toBe('Saving');
    expect(step({ state: 'completed' })).toMatchObject({ index: 4, message: 'Finished' });
    expect(step({ state: 'failed' })).toBeNull();
    expect(step({ state: 'cancelled' })).toBeNull();
  });
});
