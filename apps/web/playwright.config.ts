import { defineConfig, devices } from '@playwright/test';
import {
  baseURL,
  serverDir,
  serverEnvironment,
  serverPort,
  webPort,
} from './e2e/support/config.mjs';

/**
 * E2E lives outside the Vitest workspace on purpose: `pnpm test` must stay fast
 * and browser-free. Run it with `pnpm test:e2e` (needs `pnpm exec playwright
 * install chromium` once).
 *
 * Two servers, because the auth story spans both: Next serves the pages and the
 * Server Actions, `apps/server` terminates the WebSocket and enforces the
 * upgrade. `pnpm test:e2e` runs `e2e/support/ensure-database.mjs` first — the
 * database has to exist and be migrated before either process starts, and
 * Playwright launches `webServer` before `globalSetup` would get the chance.
 */
const environment = serverEnvironment();

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  // Signup → verify → invite → accept crosses two processes and a database.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: 'on-first-retry',
    /**
     * An address for the default `page` fixture, distinct per worker process.
     *
     * The sign-up throttle allows 20 accounts per hour per IP, and this suite
     * creates dozens — so without this the suite eventually throttles itself and
     * a test fails at "check your email" for a reason unrelated to what it was
     * testing. Tests that build their own contexts use `newCallerContext` in
     * `e2e/support/flows.ts`, which does the same thing per context and explains
     * why the address is believed (`ATRIUM_TRUSTED_PROXY_HOPS=1`).
     *
     * Re-randomised on every worker start, so re-running the suite inside the
     * hour does not accumulate against a counter the dev server keeps in memory.
     */
    extraHTTPHeaders: { 'x-forwarded-for': `203.0.113.${1 + Math.floor(Math.random() * 254)}` },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'firefox-conversation-follow',
      testMatch: /(?:conversation-follow|live-conversation-follow)\.spec\.ts/,
      use: { ...devices['Desktop Firefox'] },
    },
  ],
  webServer: [
    {
      // `localhost`, not `127.0.0.1`: Next's dev server only serves client
      // assets to allowed dev origins, and a mismatched host silently breaks
      // hydration.
      command: `pnpm exec next dev --port ${webPort}`,
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: environment,
    },
    {
      command: 'pnpm exec tsx src/index.ts',
      cwd: serverDir,
      url: `http://127.0.0.1:${serverPort}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: environment,
    },
  ],
});
