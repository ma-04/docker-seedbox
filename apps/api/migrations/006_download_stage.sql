-- What a download is currently doing / waiting on (docs/architecture.md § Download stage). Written by the worker only.
-- stage: NULL = unknown yet. Pending: waiting-vpn | waiting-disk | waiting-engine | adding.
--        Downloading: metadata | queued | checking | paused | stalled | downloading | moving.
-- seeds/peers: connected right now; seeds_total: seeds the trackers/DHT report for the swarm.
-- progress_at: unix s of the last time progress went up (or the download started); drives "no progress for N min".
ALTER TABLE torrents ADD COLUMN stage TEXT;
ALTER TABLE torrents ADD COLUMN seeds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE torrents ADD COLUMN peers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE torrents ADD COLUMN seeds_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE torrents ADD COLUMN progress_at INTEGER;
