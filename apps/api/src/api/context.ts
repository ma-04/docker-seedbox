import type { Config } from '../lib/config.js';
import type { Db } from '../lib/db.js';
import type { VpnClient } from '../lib/vpn.js';

export interface Ctx { db: Db; config: Config; vpn: VpnClient; fetchImpl: typeof fetch; ssePollMs: number; ssePingMs: number }
