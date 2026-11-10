import { buildApp } from './api/app.js';
import { loadConfig } from './lib/config.js';
import { openDb } from './lib/db.js';

const config = loadConfig();
const db = openDb(`${config.dataDir}/seedbox.db`);
const app = buildApp({ db, config, logger: { level: config.logLevel } });

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  try { await app.close(); } finally { db.close(); }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ host: '0.0.0.0', port: config.port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
