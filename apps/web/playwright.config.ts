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

/**
 * The width the shell declares as its floor, and the height the vertical
 * workspace split needs before the conversation pane can overflow at all.
 * `MINIMUM_WIDTH` in `src/components/frame/AppFrame.tsx` is the authority for
 * the width; this file cannot import it (that module is TSX in the app graph),
 * so `test/viewport.test.tsx` reads both and asserts they are one number.
 */
const FRAME_FLOOR = { width: 1280, height: 900 } as const;

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
    /**
     * THE RUNNER SITS AT THE PRODUCT'S FLOOR, DELIBERATELY.
     *
     * `devices['Desktop Chrome']` is 1280×720 and this file used to accept that
     * default. When the v8 batch raised the shell's `min-width` to 1340, every
     * spec that sets no viewport of its own began running BELOW the floor the
     * product declares for itself — the below-minimum notice instead of the
     * product — and 76 of 177 browser tests went red at once. `viewport.test.tsx`
     * did not catch it: it compares the constant to the stylesheet, and both
     * moved together. Nothing related either to the runner.
     *
     * So the default is stated here rather than inherited, and it is the floor
     * itself: the width most likely to break is the one the gate runs at. Height
     * is 900 rather than 720 because the workspace splits vertically and a 720
     * window leaves the conversation pane too short to scroll, which is a
     * different test from the one most specs mean to be running.
     *
     * If `MINIMUM_WIDTH` in `src/components/frame/AppFrame.tsx` moves again,
     * this moves with it.
     */
    viewport: FRAME_FLOOR,
  },
  /* Each device descriptor carries its own 1280×720 viewport, and a project's
     `use` outranks the top-level one — so the floor has to be restated after
     every spread or the spread silently puts the height back to 720. */
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: FRAME_FLOOR } },
    {
      name: 'firefox-conversation-follow',
      testMatch: /(?:conversation-follow|live-conversation-follow)\.spec\.ts/,
      use: { ...devices['Desktop Firefox'], viewport: FRAME_FLOOR },
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
