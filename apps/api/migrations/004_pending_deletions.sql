-- Files of deleted jobs / deleted destinations that the worker still has to remove (docs/architecture.md § Deleting jobs).
-- Written by the API in the SAME transaction as the job/destination delete; consumed (with retries) by the worker.
-- `destination_id` has no foreign key: the destination row may already be gone.
CREATE TABLE pending_deletions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  destination_id INTEGER NOT NULL,
  remote_path    TEXT    NOT NULL,                 -- jobs.remote_path of the deleted job (<userDir>/<jobDir> or <jobDir>)
  torrent_id     INTEGER,                          -- the deleted job's torrent: files are kept while an active job for it targets the same destination
  kind           TEXT    NOT NULL DEFAULT 'local', -- 'local' = delete library files, 's3' = rclone purge of the job dir
  full_path      TEXT    NOT NULL,                 -- local: path relative to the library root (subdir + remote_path)
  config_enc     TEXT,                             -- s3 only: snapshot of destinations.config_enc (the row may be deleted)
  user_owned     INTEGER NOT NULL DEFAULT 0,       -- s3 only: owner_user_id IS NOT NULL (egress proxy applies)
  attempts       INTEGER NOT NULL DEFAULT 0,
  retry_at       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX pending_deletions_retry ON pending_deletions (retry_at);
