import { defineConfig } from '@playwright/test';
import { env } from './lib/env';

// Two ways to run (see README.md):
//  a) inside the compose network (e2e/run.sh): *.seedbox.test resolves through Docker DNS.
//  b) from a developer machine through `ssh -L`: set E2E_CONNECT=127.0.0.1:<local port>; every *.seedbox.test host is
//     then mapped to it by Chromium (--host-resolver-rules) and by lib/net.ts for plain HTTP calls.
export default defineConfig({
  testDir: './tests',
  outputDir: '.out/results',
  globalSetup: './lib/global-setup.ts',
  fullyParallel: false,
  workers: env.workers,
  retries: 0,
  timeout: 150_000,
  expect: { timeout: 20_000 },
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { outputFolder: '.out/report', open: 'never' }], ['junit', { outputFile: '.out/junit.xml' }]],
  use: {
    baseURL: env.baseURL,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    launchOptions: { args: env.connect ? [`--host-resolver-rules=MAP *.seedbox.test ${env.connect}`] : [] },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
