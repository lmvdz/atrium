import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { serverDir, serverEnvironment } from './e2e/support/config.mjs';
import { ELECTRIC_SECRET, ELECTRIC_URL } from './e2e/support/electric-stack.mjs';

/**
 * THE TWO-REAL-BROWSER COVENANT ACCEPTANCE RUN (T5, #219) — production posture,
 * PLUS a live Electric sync fabric.
 *
 * This is `playwright.destination.config.ts` with one thing added: the app boots
 * with `ELECTRIC_URL` / `ELECTRIC_SECRET` set, so the shape proxy
 * (`app/electric/v1/shape/route.ts`) reaches a real running Electric and the
 * `conversation_substrate='yjs'` surface (`YjsRoomSession` → `LiveConversationDoc`)
 * mounts a LIVE client `Y.Doc` over Electric Durable Streams. The Electric stack
 * itself is stood up out-of-band by `e2e/support/electric-stack.mjs` under its own
 * compose project on unique ports (see that file); this config only points the app
 * at it. The app's DATABASE_URL is the same T5 postgres Electric replicates from —
 * carried in through `E2E_DATABASE_URL`, which the runner exports before this
 * config is imported so `config.mjs`'s `databaseUrl` resolves to it.
 *
 * Distinct app ports from the plain destination run (3210/3211/4211 vs
 * 3200/3201/4201) so a stray destination server never collides with this one.
 *
 * Everything else — the TLS terminator, the production `next build && next start`,
 * `assertSecureTransport` ACTIVE and SATISFIED, the mailer gate configured — is the
 * destination posture, unchanged. See `playwright.destination.config.ts` for the
 * full rationale of why production posture is stood UP rather than around.
 */

const NEXT_PORT = 3211;
const WS_PORT = 4211;
const TLS_PORT = 3210;
const baseURL = `https://localhost:${TLS_PORT}`;

// Prove the run had a browser rather than skipping to an unearned green — read
// from THIS (the test-runner) process by `requireBrowser`.
process.env.ATRIUM_E2E_BROWSER_REQUIRED = '1';

/** Production posture + the Electric wiring the yjs surface needs. */
const environment = {
  ...serverEnvironment(),
  NODE_ENV: 'production' as const,
  APP_URL: baseURL,
  ATRIUM_WS_URL: `wss://localhost:${TLS_PORT}/ws`,
  ATRIUM_SERVER_HTTP_URL: `http://127.0.0.1:${WS_PORT}`,
  SERVER_PORT: String(WS_PORT),
  SERVER_HOST: '127.0.0.1',
  ATRIUM_MAIL_TRANSPORT: 'smtp',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1025',
  SMTP_REQUIRE_TLS: 'false',
  ATRIUM_MAIL_FROM: 'atrium@atrium.invalid',
  // THE ADDITION: the app's shape proxy forwards to this Electric, with this
  // secret. `electricUrl()` accepts a loopback http URL; `assertSecureTransport`
  // gates only APP_URL / the realtime origin, not ELECTRIC_URL.
  ELECTRIC_URL,
  ELECTRIC_SECRET,
};

const FRAME_FLOOR = { width: 1280, height: 900 } as const;

export default defineConfig({
  testDir: './e2e',
  testMatch: /two-browser-acceptance\.spec\.ts/,
  fullyParallel: false,
  // One serial two-browser test; a single worker keeps the box uncontended and the
  // convergence timing honest (no oversubscription artefacts).
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 240_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL,
    ignoreHTTPSErrors: true,
    actionTimeout: 25_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    extraHTTPHeaders: { 'x-forwarded-for': `203.0.113.${1 + Math.floor(Math.random() * 254)}` },
    viewport: FRAME_FLOOR,
  },
  projects: [
    {
      name: 'two-browser-electric',
      use: { ...devices['Desktop Chrome'], viewport: FRAME_FLOOR, ignoreHTTPSErrors: true },
    },
  ],
  webServer: [
    {
      command: `pnpm exec next build && pnpm exec next start --port ${NEXT_PORT} --hostname 127.0.0.1`,
      url: `http://127.0.0.1:${NEXT_PORT}/sign-in`,
      reuseExistingServer: false,
      timeout: 300_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: environment,
    },
    {
      command: 'pnpm exec tsx src/index.ts',
      cwd: serverDir,
      url: `http://127.0.0.1:${WS_PORT}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: environment,
    },
    {
      command: 'node e2e/support/destination-tls.mjs',
      cwd: join(serverDir, '..', 'web'),
      url: baseURL,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        TLS_PORT: String(TLS_PORT),
        NEXT_PORT: String(NEXT_PORT),
        WS_PORT: String(WS_PORT),
      },
    },
  ],
});
