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

/**
 * What removing a job does to its files, shown in the Remove confirmation. null = nothing was delivered (failed/cancelled
 * jobs), so no confirmation is needed. Must match the API: local library files are always deleted, S3 files only when the
 * admin enabled `cleanup.deleteRemoteOnJobDelete`, Google Drive files are always kept.
 */
export function removeNotice(job: Pick<JobDto, 'state' | 'destination'>, deleteRemoteOnJobDelete: boolean): string | null {
  if (job.state !== 'completed') return null;
  const t = job.destination.type;
  if (t === 'local') return 'The downloaded files will be deleted from the server and their download links stop working.';
  if (t === 's3' && deleteRemoteOnJobDelete) return `The uploaded files will be deleted from "${job.destination.name}" and cannot be recovered.`;
  return `The files already uploaded to "${job.destination.name}" are kept; only this entry is removed.`;
}
