import type { JobDto } from './api';
import { formatDuration } from './format';

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

// ---- download step ("where is this download stuck?") ----

export const JOB_STEPS = ['Queued', 'Connecting', 'Downloading', 'Uploading', 'Done'] as const;
export type JobStepName = (typeof JOB_STEPS)[number];

export interface JobStep {
  /** Index into JOB_STEPS of the step the job is on. */
  index: number;
  /** Step names; "Uploading" reads "Saving" for local destinations. */
  steps: string[];
  /** One line: what is happening right now, or what it is waiting on. */
  message: string;
  /** true = it is waiting on something that will not fix itself soon (show it as a warning). */
  stuck: boolean;
}

/** A download whose progress has not moved for this long is reported as stuck (bursty swarms pause for a minute or two). */
export const STUCK_AFTER_SEC = 5 * 60;

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function swarm(st: NonNullable<JobDto['stage']>): string {
  const seeds = st.seedsTotal > 0 ? `${st.seeds} of ${st.seedsTotal} seeds connected` : `${plural(st.seeds, 'seed')} connected`;
  return st.peers > 0 ? `${seeds}, ${plural(st.peers, 'other peer')}` : seeds;
}

/**
 * Which step a job is on and why it is not moving, from the job state and the worker's download stage.
 * null for failed/cancelled jobs (their error says why).
 */
export function jobStep(job: Pick<JobDto, 'state' | 'stage' | 'destination' | 'downloadProgress'>, nowSec: number = Math.floor(Date.now() / 1000)): JobStep | null {
  const steps: string[] = [...JOB_STEPS];
  if (job.destination.type === 'local') steps[3] = 'Saving';
  const at = (index: number, message: string, stuck = false): JobStep => ({ index, steps, message, stuck });
  const st = job.stage;
  const idle = st?.lastProgressAt != null ? Math.max(0, nowSec - st.lastProgressAt) : 0;
  const idleText = formatDuration(idle).split(' ')[0];

  switch (job.state) {
    case 'failed': case 'cancelled': return null;
    case 'completed': return at(4, 'Finished');
    case 'uploading': return at(3, job.destination.type === 'local' ? 'Moving the files into your library' : `Uploading to ${job.destination.name}`);
    case 'queued':
      switch (st?.stage) {
        case 'waiting-vpn': return at(0, 'Waiting for the VPN to connect', true);
        case 'waiting-disk': return at(0, 'Waiting for free disk space on the server', true);
        case 'waiting-engine': return at(0, 'Waiting for the download engine (qBittorrent) to respond', true);
        case 'adding': return at(1, 'Handing the torrent to the download engine');
        default: return at(0, 'Waiting to start');
      }
    case 'downloading': break;
  }
  // The torrent is done; the worker starts the upload on its next pass.
  if (!st) return job.downloadProgress >= 1 ? at(3, 'Download finished, starting the upload') : at(1, 'Connecting to the download engine');
  switch (st.stage) {
    case null: case 'adding': return at(1, 'Connecting to the download engine');
    case 'waiting-vpn': return at(1, 'Waiting for the VPN to connect', true);
    case 'waiting-disk': return at(1, 'Waiting for free disk space on the server', true);
    case 'waiting-engine': return at(2, 'The download engine (qBittorrent) is not responding; retrying', true);
    case 'metadata': {
      const who = st.seeds + st.peers > 0 ? `${plural(st.seeds + st.peers, 'peer')} connected` : 'no peers found yet';
      return idle >= STUCK_AFTER_SEC
        ? at(1, `No peer has sent the torrent's file list after ${idleText} (${who})`, true)
        : at(1, `Getting the torrent's file list from peers (${who})`);
    }
    case 'queued': return at(2, 'Queued in the download engine until another download finishes');
    case 'checking': return at(2, 'Checking data already on disk');
    case 'paused': return at(2, 'Paused in the download engine', true);
    case 'moving': return at(2, 'Moving downloaded files');
    case 'stalled': case 'downloading':
      if (idle >= STUCK_AFTER_SEC) return at(2, `No progress for ${idleText}: ${swarm(st)}`, true);
      return at(2, st.stage === 'stalled' ? `Waiting for peers to send data: ${swarm(st)}` : swarm(st));
  }
}
