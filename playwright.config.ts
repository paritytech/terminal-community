import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // Every test gets its own test host (e2e/host): host state, storage and
  // payments are per page, and no chain is involved, so tests run in parallel.
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  timeout: 120_000, // generous: the first hit on a route waits for next dev to compile it
  expect: {
    timeout: 30_000,
  },
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'npx next dev --port 5199',
    url: 'http://localhost:5199',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000, // Next.js cold compile can be slow in CI
  },
});
