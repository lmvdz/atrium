import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { serverDir, serverEnvironment } from './e2e/support/config.mjs';

/**
 * THE DESTINATION SCENARIO RUNS AGAINST A GENUINE PRODUCTION BUILD, IN PRODUCTION
 * POSTURE. THIS CONFIG IS WHY, AND WHAT IT COST.
 *
 * Map #89's destination says, in the user's own words, "production build, real
 * Postgres, from a test runner". The rest of the e2e suite runs `next dev`
 * (`playwright.config.ts`, NODE_ENV=development) on purpose — dev boots faster and
 * the gate runs it on every spec. #91 contradiction 9 named the gap: dev and prod
 * differ on RSC streaming, caching and hydration. #103 owns closing it.
 *
 * ## What "production" turned out to require (the finding)
 *
 * A straight `next build && next start` over loopback does NOT boot Atrium's
 * authenticated routes, and that is by design, discovered here:
 *
 *  - `next build` INLINES `NODE_ENV=production` into the compiled bundle, and
 *    `@atrium/auth` is compiled into that bundle — so its production gates cannot
 *    be softened by a runtime env var.
 *  - `assertSecureTransport` (`packages/auth/src/transport.ts`) then REFUSES to
 *    start when `APP_URL` / the realtime origin are `http://` / `ws://`, with no
 *    `ATRIUM_ALLOW_INSECURE` escape hatch — a production deployment must serve
 *    over TLS.
 *  - `resolveMailer` (`packages/auth/src/mailer.ts`) REFUSES to boot in
 *    production without a real mail transport; the dev outbox the e2e reads
 *    verification links from is production-disabled on purpose.
 *
 * So this lane stands the real posture UP rather than around it. A single TLS
 * terminator (`e2e/support/destination-tls.mjs`, one self-signed cert, Playwright
 * `ignoreHTTPSErrors`) presents `https://localhost:3200` and `wss://localhost:3200/ws`
 * to the browser and forwards to the production `next start` (plain http, internal
 * :3201) and the realtime server (plain ws, internal :4201). Both server processes
 * boot with `NODE_ENV=production` and `APP_URL=https://localhost:3200`, so
 * `assertSecureTransport` is ACTIVE and SATISFIED — the production behaviour, not a
 * bypass. An SMTP transport is configured so the mailer gate passes; the scenario
 * seats its participants by session-minting (the brief's blessed path) and sends no
 * mail, so the relay is configured-but-unused.
 *
 * Two configs, not one project: Playwright starts every `webServer` in a config
 * before any project runs, so a prod stack in the dev config would build-and-start
 * for every dev spec. `test:e2e` stays on dev and ignores the destination spec;
 * this config runs the destination spec and nothing else.
 */

const NEXT_PORT = 3201;
const WS_PORT = 4201;
const TLS_PORT = 3200;
const baseURL = `https://localhost:${TLS_PORT}`;

/** Production posture: real NODE_ENV=production, TLS-declared origins, a configured relay. */
const environment = {
  ...serverEnvironment(),
  NODE_ENV: 'production' as const,
  APP_URL: baseURL,
  ATRIUM_WS_URL: `wss://localhost:${TLS_PORT}/ws`,
  ATRIUM_SERVER_HTTP_URL: `http://127.0.0.1:${WS_PORT}`,
  SERVER_PORT: String(WS_PORT),
  SERVER_HOST: '127.0.0.1',
  // The mailer gate refuses to boot in production without a transport. This
  // configures one (lazily connected by nodemailer); the scenario sends no mail.
  ATRIUM_MAIL_TRANSPORT: 'smtp',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1025',
  SMTP_REQUIRE_TLS: 'false',
  ATRIUM_MAIL_FROM: 'atrium@atrium.invalid',
};

/** The shell's declared floor — mirrors `playwright.config.ts`. */
const FRAME_FLOOR = { width: 1280, height: 900 } as const;

export default defineConfig({
  testDir: './e2e',
  testMatch: /destination-scenario\.spec\.ts/,
  fullyParallel: true,
  // The map's gate is 4 workers, never 8 (8 oversubscribes this machine and its
  // only-at-8 failures are not product defects — HANDOFF.md). Pinned here so the
  // documented `test:e2e:destination` command reproduces the gated run; a `--workers`
  // flag still overrides it.
  workers: 4,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 240_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    ignoreHTTPSErrors: true,
    actionTimeout: 25_000,
    trace: 'on-first-retry',
    extraHTTPHeaders: { 'x-forwarded-for': `203.0.113.${1 + Math.floor(Math.random() * 254)}` },
    viewport: FRAME_FLOOR,
  },
  projects: [
    {
      name: 'destination-production',
      use: { ...devices['Desktop Chrome'], viewport: FRAME_FLOOR, ignoreHTTPSErrors: true },
    },
  ],
  webServer: [
    {
      // The production build, inline and internal. `next build` writes `.next`;
      // `next start` serves it with the production bundle, RSC and caching.
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
      // TLS termination: the browser's https/wss origin, forwarding to the two
      // plain internal servers above.
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
