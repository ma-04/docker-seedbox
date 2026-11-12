import type { Config } from '../lib/config.js';
import type { Db } from '../lib/db.js';
import type { GuardOptions } from '../lib/netguard.js';
import type { EngineClient } from './engine.js';
import type { VpnClient } from '../lib/vpn.js';
import type { RateLimiter } from './ratelimit.js';
import type { SearchService } from '../lib/search/service.js';

export interface Ctx {
  db: Db; config: Config; vpn: VpnClient; engine: EngineClient; fetchImpl: typeof fetch;
  ssePollMs: number; ssePingMs: number; sseMaxPerUser: number; sseMaxTotal: number;
  limiter: RateLimiter;
  /** How long POST /admin/vpn/rotate waits for the worker's VPN lock before answering 409. */
  vpnLockWaitMs: number;
  /** DNS resolver override for the SSRF guard (tests). */
  lookup?: GuardOptions['lookup'];
  /** Torrent search; null = switched off (no SEARCH_BACKEND). */
  search: SearchService | null;
}
