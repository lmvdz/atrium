import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3100);
// `localhost`, not `127.0.0.1`: Next's dev server only serves client assets to
// allowed dev origins, and a mismatched host silently breaks hydration.
const baseURL = `http://localhost:${PORT}`;

/**
 * E2E lives outside the Vitest workspace on purpose: `pnpm test` must stay fast
 * and browser-free. Run it with `pnpm test:e2e` (needs `pnpm exec playwright
 * install chromium` once).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec next dev --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
