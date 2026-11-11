-- Worker bookkeeping on torrents (see docs/architecture.md § Worker loop).
ALTER TABLE torrents ADD COLUMN library_path TEXT;
ALTER TABLE torrents ADD COLUMN cleanup_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE torrents ADD COLUMN started_at INTEGER;
