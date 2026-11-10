import type { JobDto } from './api';

export type JobFilter = 'all' | 'active' | 'completed' | 'failed';

/** Merge an SSE `job` event into a list: replace by id when newer-or-equal, else prepend. Newest first. */
export function mergeJob(list: JobDto[] | undefined, job: JobDto): JobDto[] {
  const cur = list ?? [];
  const idx = cur.findIndex((j) => j.id === job.id);
  if (idx === -1) return [job, ...cur].sort(byNewest);
  const existing = cur[idx]!;
  if (existing.updatedAt > job.updatedAt) return cur;
  const next = cur.slice();
  next[idx] = job;
  return next;
}

export const byNewest = (a: JobDto, b: JobDto): number => b.createdAt - a.createdAt || b.id - a.id;

export const isActive = (j: JobDto): boolean => j.state === 'queued' || j.state === 'downloading' || j.state === 'uploading';

export function filterJobs(list: JobDto[], f: JobFilter): JobDto[] {
  switch (f) {
    case 'active': return list.filter(isActive);
    case 'completed': return list.filter((j) => j.state === 'completed');
    case 'failed': return list.filter((j) => j.state === 'failed' || j.state === 'cancelled');
    default: return list;
  }
}

export const displayName = (j: JobDto): string => j.name ?? j.infohash;
