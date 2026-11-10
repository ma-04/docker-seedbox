import type { Config } from '../lib/config.js';
import type { Db } from '../lib/db.js';
import type { GuardOptions } from '../lib/netguard.js';
import type { EngineClient } from './engine.js';
import type { VpnClient } from '../lib/vpn.js';
import type { RateLimiter } from './ratelimit.js';

export interface Ctx {
  db: Db; config: Config; vpn: VpnClient; engine: EngineClient; fetchImpl: typeof fetch;
  ssePollMs: number; ssePingMs: number; sseMaxPerUser: number; sseMaxTotal: number;
  limiter: RateLimiter;
  /** DNS resolver override for the SSRF guard (tests). */
  lookup?: GuardOptions['lookup'];
}
