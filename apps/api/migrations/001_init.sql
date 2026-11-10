CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT,
  display_name TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  max_active_jobs INTEGER,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE destinations (
  id INTEGER PRIMARY KEY,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('gdrive','s3','local')),
  config_enc TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE torrents (
  id INTEGER PRIMARY KEY,
  infohash TEXT NOT NULL UNIQUE,
  name TEXT,
  source_enc TEXT NOT NULL,            -- encrypted JSON: { magnet } | { torrentB64 }
  total_size INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','downloading','downloaded','error','removed')),
  progress REAL NOT NULL DEFAULT 0,
  dl_speed INTEGER NOT NULL DEFAULT 0,
  save_path TEXT,
  error TEXT,
  added_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  torrent_id INTEGER NOT NULL REFERENCES torrents(id),
  destination_id INTEGER NOT NULL REFERENCES destinations(id),
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','downloading','uploading','completed','failed','cancelled')),
  upload_progress REAL NOT NULL DEFAULT 0,
  upload_speed INTEGER NOT NULL DEFAULT 0,
  remote_path TEXT,
  folder_url TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX jobs_user ON jobs(user_id, created_at DESC);
CREATE INDEX jobs_state ON jobs(state);
CREATE INDEX jobs_torrent ON jobs(torrent_id);
CREATE TABLE job_files (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  size INTEGER NOT NULL
);
CREATE INDEX job_files_job ON job_files(job_id);
CREATE TABLE vpn_configs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  config_enc TEXT NOT NULL,
  endpoint_host TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_used_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
