import fs from 'node:fs';
import path from 'node:path';

// LIVE_ENV_FILE (default ../credentials/deploy.env, i.e. a git-ignored file) supplies everything. See README.md.
const file = process.env.LIVE_ENV_FILE ?? path.resolve('../credentials/deploy.env');
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.trim();
  }
}
const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set (see e2e/README.md, "Live suite")`);
  return v;
};
const opt = (k: string, d = ''): string => process.env[k] ?? d;
const lines = (k: string): string[] => opt(k).split(',').map((s) => s.trim()).filter(Boolean);

const domain = opt('LIVE_DOMAIN', 'seedbox.invalid');
// Hosts layout of the deployment under test. Unset: the three-host layout (auth.<domain>, files.<domain>). Set to an
// empty value (or to LIVE_DOMAIN): served on the app host, i.e. the portal at <domain>/auth/ and downloads at /dl/.
const sep = (k: string, d: string): string | null => { const v = opt(k, d).trim().toLowerCase(); return v && v !== domain ? v : null; };
const authHost = sep('LIVE_AUTH_HOST', `auth.${domain}`);
const filesHost = sep('LIVE_FILES_HOST', `files.${domain}`);
export const live = {
  domain,
  baseURL: `https://${domain}`,
  /** Base URL of the Authelia portal, no trailing slash. */
  authURL: authHost ? `https://${authHost}` : `https://${domain}/auth`,
  filesURL: `https://${filesHost ?? domain}`,
  /** The public hostnames of the deployment (TLS/DNS checks). */
  get hosts(): string[] { return [...new Set([domain, authHost ?? domain, filesHost ?? domain])]; },
  admin: { user: opt('LIVE_ADMIN_USER', 'admin'), get password() { return need('LIVE_ADMIN_PASSWORD'); } },
  user: { user: opt('LIVE_USER', 'tester'), get password() { return need('LIVE_USER_PASSWORD'); } },
  /** a second normal user: lets the same torrent be added once more (one job per user and torrent) */
  user2: { user: opt('LIVE_USER2', 'tester2'), get password() { return need('LIVE_USER2_PASSWORD'); } },
  /** ssh target of the Docker host, used for out-of-band checks (what the VPN namespace sees) and restarts. */
  ssh: { target: () => need('LIVE_SSH_TARGET'), key: () => need('LIVE_SSH_KEY'), dir: opt('LIVE_REMOTE_DIR', 'docker-seedbox') },
  wgConfigs: () => lines('LIVE_WG_CONFIGS'),
  rcloneConf: () => need('LIVE_RCLONE_CONF'),
  gdriveRemote: () => need('LIVE_GDRIVE_REMOTE'),
  driveRootFolderId: () => need('LIVE_DRIVE_ROOT_FOLDER_ID'),
  proxyUrl: () => need('LIVE_PROXY_URL'),
  proxyEnvFile: () => need('LIVE_PROXY_ENV'),
  b2Remote: () => need('LIVE_B2_REMOTE'),
  s3: { endpoint: () => need('LIVE_S3_ENDPOINT'), region: () => need('LIVE_S3_REGION'), bucket: () => need('LIVE_S3_BUCKET'), prefixBase: () => need('LIVE_S3_PREFIX_BASE') },
};
