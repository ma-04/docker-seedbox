import { defineConfig } from '@playwright/test';
import { live } from './live/env';

// Opt-in suite against a REAL deployment (real DNS, Let's Encrypt, VPN, cloud storage). See README.md, "Live suite".
// Nothing here is hermetic and nothing is committed: every host, key and id comes from the gitignored env file.
export default defineConfig({
  testDir: './live',
  testMatch: /\d\d-.*\.spec\.ts/,
  outputDir: '.out/live-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [['list'], ['html', { outputFolder: '.out/live-report', open: 'never' }]],
  use: {
    baseURL: live.baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
