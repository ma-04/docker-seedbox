import { describe, expect, it } from 'vitest';
import type { JobDto } from './api';
import { filterJobs, mergeJob, removeNotice } from './jobs';

const mk = (id: number, over: Partial<JobDto> = {}): JobDto => ({
  id, state: 'queued', name: null, infohash: 'a'.repeat(40), totalSize: 0, downloadProgress: 0, downloadSpeed: 0,
  uploadProgress: 0, uploadSpeed: 0, destination: { id: 1, name: 'd', type: 'local' }, error: null, folderUrl: null,
  createdAt: 100 + id, updatedAt: 100 + id, completedAt: null, ...over,
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
