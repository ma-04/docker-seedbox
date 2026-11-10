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

export const env = {
  baseURL: process.env.E2E_BASE_URL ?? 'https://app.seedbox.test',
  /** host:port that every *.seedbox.test name is mapped to (tunnel mode); empty = use DNS. */
  connect: process.env.E2E_CONNECT ?? '',
  filesURL: process.env.E2E_FILES_URL ?? 'https://files.seedbox.test',
  s3URL: process.env.E2E_S3_URL ?? 'https://s3.seedbox.test',
  fixturesURL: process.env.E2E_FIXTURES_URL ?? 'https://fixtures.seedbox.test',
  ctlURL: process.env.E2E_CTL_URL ?? 'https://ctl.seedbox.test',
  ctlToken: need('E2E_CTL_TOKEN'),
  minioUser: process.env.E2E_MINIO_USER ?? 'minioadmin',
  minioPassword: need('E2E_MINIO_PASSWORD'),
  workers: Number(process.env.E2E_WORKERS ?? 1),
  passwords: {
    admin: need('E2E_ADMIN_PASSWORD'),
    alice: need('E2E_ALICE_PASSWORD'),
    bob: need('E2E_BOB_PASSWORD'),
    carol: need('E2E_CAROL_PASSWORD'),
  },
};
export type UserName = keyof typeof env.passwords;
