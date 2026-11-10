/** Worker entrypoint: `node dist/worker.js`. */
import { join } from 'node:path';
import pino from 'pino';
import { QbittorrentDownloader } from './downloaders/qbittorrent.js';
import { loadConfig } from './lib/config.js';
import { openDb } from './lib/db.js';
import { vpnClient } from './lib/vpn.js';
import { Worker } from './worker/loop.js';

const config = loadConfig();
const log = pino({
  level: config.logLevel,
  redact: ['config.appSecret', 'config.gatewaySecret', 'config.vpnControlToken'],
});
const db = openDb(join(config.dataDir, 'seedbox.db'));
const worker = new Worker({
  db, config, log,
  downloader: new QbittorrentDownloader({
    baseUrl: config.qbtUrl,
    username: process.env.QBT_USERNAME,
    password: process.env.QBT_PASSWORD,
  }),
  vpn: vpnClient(config),
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  try { await worker.stop(); } finally { db.close(); }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

log.info({ qbt: config.qbtUrl }, 'worker started');
worker.start();
