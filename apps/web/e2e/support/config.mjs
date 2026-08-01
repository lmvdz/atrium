import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * One place that decides what the end-to-end run talks to.
 *
 * Both `ensure-database.mjs` (which runs before Playwright) and
 * `playwright.config.ts` (which starts the servers) import this, so the web app,
 * the realtime server and the migration step cannot end up pointed at three
 * different databases.
 */

export const webPort = Number(process.env.E2E_PORT ?? 3100);
export const serverPort = Number(process.env.E2E_SERVER_PORT ?? 4100);

/** Postgres for the suite. Its own database, never the one `pnpm dev` uses. */
export const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  `postgres://atrium:atrium@127.0.0.1:${process.env.E2E_PG_PORT ?? 55432}/atrium_e2e`;

/** Container name and port for the throwaway Postgres, if we have to start one. */
export const container = {
  name: process.env.E2E_PG_CONTAINER ?? 'atrium-e2e-postgres',
  port: Number(process.env.E2E_PG_PORT ?? 55432),
  image: 'postgres:16-alpine',
  user: 'atrium',
  password: 'atrium',
  database: 'atrium_e2e',
};

export const baseURL = `http://localhost:${webPort}`;
export const appUrl = baseURL;

/** Where the dev mailer writes the links the tests need to click. */
export const mailOutbox = process.env.E2E_MAIL_OUTBOX ?? join(tmpdir(), 'atrium-e2e-outbox.jsonl');

/** 32+ chars, and obviously a test value. Shared by both server processes. */
export const authSecret = 'atrium-e2e-secret-not-for-production-0123456789';

export const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
export const serverDir = join(repoRoot, 'apps', 'server');

/** The environment both servers need, so neither can drift from the other. */
export function serverEnvironment() {
  return {
    NODE_ENV: 'development',
    DATABASE_URL: databaseUrl,
    BETTER_AUTH_SECRET: authSecret,
    APP_URL: appUrl,
    ATRIUM_MAIL_OUTBOX: mailOutbox,
    NEXT_PUBLIC_WS_URL: `ws://localhost:${serverPort}/ws`,
    SERVER_PORT: String(serverPort),
    SERVER_HOST: '127.0.0.1',
    LOG_LEVEL: 'warn',
  };
}
