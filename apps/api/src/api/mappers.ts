import type { Db } from '../lib/db.js';
import type { DestinationDto, JobDto, UserDto } from '../lib/dto.js';
import { maskConfig } from '../lib/destinations.js';
import { decryptJson } from '../lib/crypto.js';
import type { DestinationConfig, DestinationRow, JobRow, UserRow } from '../lib/types.js';

export const ACTIVE_STATES = ['queued', 'downloading', 'uploading'] as const;
export const TERMINAL_STATES = ['completed', 'failed', 'cancelled'] as const;
export const ACTIVE_SQL = "('queued','downloading','uploading')";

export interface JobJoin extends JobRow {
  t_name: string | null; t_infohash: string; t_total_size: number; t_progress: number; t_dl_speed: number; t_state: string;
  d_name: string; d_type: DestinationRow['type']; u_username: string;
}

export const JOB_SELECT = `SELECT j.*, t.name AS t_name, t.infohash AS t_infohash, t.total_size AS t_total_size,
  t.progress AS t_progress, t.dl_speed AS t_dl_speed, t.state AS t_state, d.name AS d_name, d.type AS d_type, u.username AS u_username
  FROM jobs j JOIN torrents t ON t.id = j.torrent_id JOIN destinations d ON d.id = j.destination_id JOIN users u ON u.id = j.user_id`;

export function jobDto(r: JobJoin, withUser = false): JobDto {
  const dlDone = r.state === 'uploading' || r.state === 'completed';
  const dto: JobDto = {
    id: r.id, state: r.state, name: r.t_name, infohash: r.t_infohash, totalSize: r.t_total_size,
    downloadProgress: dlDone ? 1 : r.t_progress,
    downloadSpeed: r.state === 'downloading' ? r.t_dl_speed : 0,
    uploadProgress: r.upload_progress, uploadSpeed: r.upload_speed,
    destination: { id: r.destination_id, name: r.d_name, type: r.d_type },
    error: r.error, folderUrl: r.folder_url, createdAt: r.created_at, updatedAt: r.updated_at, completedAt: r.completed_at,
  };
  if (withUser) dto.user = { id: r.user_id, username: r.u_username };
  return dto;
}

export function getJobJoin(db: Db, id: number): JobJoin | undefined {
  return db.prepare(`${JOB_SELECT} WHERE j.id = ?`).get(id) as JobJoin | undefined;
}

export function destinationDto(secret: string, row: DestinationRow, hideConfig: boolean): DestinationDto {
  const config = hideConfig ? {} : maskConfig(decryptJson<DestinationConfig>(secret, row.config_enc));
  return {
    id: row.id, name: row.name, type: row.type, shared: row.owner_user_id === null, enabled: !!row.enabled,
    isDefault: !!row.is_default, config, createdAt: row.created_at,
  };
}

export function userDto(u: UserRow & { active_jobs: number }): UserDto {
  return {
    id: u.id, username: u.username, email: u.email, displayName: u.display_name, isAdmin: !!u.is_admin,
    disabled: !!u.disabled, maxActiveJobs: u.max_active_jobs, activeJobs: u.active_jobs, createdAt: u.created_at, lastSeenAt: u.last_seen_at,
  };
}
