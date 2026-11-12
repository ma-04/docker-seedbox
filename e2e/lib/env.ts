import fs from 'node:fs';

// Optional: E2E_ENV_FILE=/path/to/e2e.env (the file written by e2e/run.sh) supplies the generated passwords/tokens.
const file = process.env.E2E_ENV_FILE;
if (file && fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.trim();
  }
}
const need = (k: string): string => process.env[k] ?? '';

/**
 * Hosts layout of the stack under test (e2e/run.sh --layout):
 *   single       app, Authelia (/auth/) and downloads (/dl/) on app.seedbox.test (the default)
 *   split-files  app + Authelia on app.seedbox.test, downloads on files.seedbox.test
 *   multi        app., auth. and files.seedbox.test
 */
export type Layout = 'single' | 'split-files' | 'multi';
const layout = (process.env.E2E_LAYOUT ?? 'single') as Layout;
if (!['single', 'split-files', 'multi'].includes(layout)) throw new Error(`E2E_LAYOUT must be single, split-files or multi (got ${layout})`);
const baseURL = process.env.E2E_BASE_URL ?? 'https://app.seedbox.test';

export const env = {
  baseURL,
  layout,
  /** Base URL of the Authelia portal, no trailing slash. */
  authURL: process.env.E2E_AUTH_URL ?? (layout === 'multi' ? 'https://auth.seedbox.test' : `${baseURL}/auth`),
  /** Origin that serves the signed /dl/ links. */
  filesURL: process.env.E2E_FILES_URL ?? (layout === 'single' ? baseURL : 'https://files.seedbox.test'),
  /** host:port that every *.seedbox.test name is mapped to (tunnel mode); empty = use DNS. */
  connect: process.env.E2E_CONNECT ?? '',
  s3URL: process.env.E2E_S3_URL ?? 'https://s3.seedbox.test',
  fixturesURL: process.env.E2E_FIXTURES_URL ?? 'https://fixtures.seedbox.test',
  ctlURL: process.env.E2E_CTL_URL ?? 'https://ctl.seedbox.test',
  ctlToken: need('E2E_CTL_TOKEN'),
  minioUser: process.env.E2E_MINIO_USER ?? 'minioadmin',
  minioPassword: need('E2E_MINIO_PASSWORD'),
  workers: Number(process.env.E2E_WORKERS ?? 1),
  /** Torrent search is on in the stack under test (e2e/run.sh --search on): tests/16 run, tests/17 skip; off: the reverse. */
  search: !!process.env.E2E_SEARCH,
  /** The mock indexer's own HTTP port, for the suite only (the vpn namespace reaches it at 203.0.113.40 through a WG server). */
  indexerURL: process.env.E2E_INDEXER_URL ?? 'http://indexer:8080',
  passwords: {
    admin: need('E2E_ADMIN_PASSWORD'),
    alice: need('E2E_ALICE_PASSWORD'),
    bob: need('E2E_BOB_PASSWORD'),
    carol: need('E2E_CAROL_PASSWORD'),
  },
};
export type UserName = keyof typeof env.passwords;
