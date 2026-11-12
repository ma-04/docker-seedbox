# 1. Torrent search: Jackett in the VPN namespace, behind a backend seam

Status: accepted (2026-11)

## Context

Users want to search for torrents from the web UI instead of pasting magnet links. Searching means querying tracker
sites, and those queries reveal what is searched and from where: they must not leave the server outside the VPN, just
like qBittorrent's own traffic. Each tracker site needs its own scraping logic, credentials and Cloudflare workarounds,
which the app should not reimplement. Search is optional: the app must work unchanged without it.

## Decision

- **Backend: Jackett** (upstream `linuxserver/jackett`, pinned by digest, no image of our own), optional, compose
  profile `search`, enabled with `./setup.sh --search`. Its Torznab API is the only protocol the app speaks.
- **Containment:** Jackett runs with `network_mode: service:vpn`, like qBittorrent, so every tracker-site request goes
  through the tunnel or, while the kill switch holds, nowhere. The sidecar firewall accepts new connections to Jackett's
  port from the api container only (`SEARCH_TRUSTED_IPS`), never via the tunnel, and keeps FlareSolverr's port
  loopback-only (`LOCAL_ONLY_PORTS`).
- **One caller:** only the API talks to Jackett. Admins reach Jackett's own UI (indexer management) at
  `https://APP_HOST/jackett/` through an admin-only passthrough in the API, so the firewall allow-list stays a single
  address and the admin check is the same in every auth mode and hosts layout.
- **Seam:** routes, tokens and the add path depend on a `SearchBackend` interface (`apps/api/src/lib/search/backend.ts`:
  `search`, `indexers`, `download`). `JackettBackend` is the only implementation. Another Torznab aggregator (e.g.
  Prowlarr) would be a second implementation selected by `SEARCH_BACKEND`, plus its own compose profile.
- **Adding a result reuses the existing add path** (`createJob()`, `parseMagnet`, `parseTorrentFile`): the same
  canonicalisation, strict bencode validation, limits and deduplication as a pasted magnet or an uploaded file.
- **FlareSolverr** is a separate, off-by-default profile (`search-flaresolverr`) in the same namespace.

## Consequences

- One more long-running container (about 150 MB RAM idle; FlareSolverr adds up to 1 GB) only for those who enable it.
- The API container is outside the VPN, so it must never fetch a tracker URL itself. A download link is fetched only
  from Jackett's own `/dl/` endpoint at the configured origin (the one narrow SSRF exemption); a redirect to anything
  else than a magnet or another Jackett `/dl/` URL is checked with the SSRF guard and refused, never fetched.
- Jackett's UI is same-origin with the SPA (under `/jackett/`). It is admin-only; writes must be same-origin.
- Rejected: a Jackett-like scraper in the app (unmaintainable), exposing Jackett through the gateway directly (a second
  address in the firewall allow-list and a gateway-side admin check per auth mode), Prowlarr first (heavier, its own DB;
  the seam keeps it possible).
