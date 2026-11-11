-- Fetched BitTorrent tracker lists (docs/architecture.md § Tracker lists). Written by the worker only; read by the API.
-- One row per configured list URL. A failed refresh keeps the last good list (trackers_json, fetched_at, tracker_count)
-- and only records the error (a short, safe message: never a response body).
CREATE TABLE tracker_lists (
  url           TEXT PRIMARY KEY,
  fetched_at    INTEGER,                    -- last SUCCESSFUL fetch (unix s); NULL = never succeeded
  attempted_at  INTEGER NOT NULL DEFAULT 0, -- last attempt, successful or not
  ok            INTEGER NOT NULL DEFAULT 0, -- 1 = the last attempt succeeded
  error         TEXT,
  tracker_count INTEGER NOT NULL DEFAULT 0,
  body_sha256   TEXT,
  trackers_json TEXT NOT NULL DEFAULT '[]'
);
