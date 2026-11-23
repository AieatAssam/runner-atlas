import { defineConfig, devices } from '@playwright/test';

// Two fixtures, two ports (scripts/fixtures.ts): the committed Day-0 rollups, and a synthetic Day-90 survey.
// Each webServer builds its fixture first, so the timeout covers a cold build.
const DAY_0 = 'http://127.0.0.1:4173/';
const DAY_90 = 'http://127.0.0.1:4174/';
const serve = (fixture: string, port: number) => ({
  command: `node scripts/fixtures.ts serve ${fixture} ${port}`,
  url: `http://127.0.0.1:${port}/`,
  reuseExistingServer: false,
  timeout: 180_000,
});

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: { trace: 'retain-on-failure', launchOptions: { args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] } },
  projects: [
    {
      name: 'day-0',
      testMatch: /atlas\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: DAY_0 },
    },
    {
      name: 'day-90',
      testMatch: /atlas\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: DAY_90 },
    },
  ],
  webServer: [serve('day-0', 4173), serve('day-90', 4174)],
});
