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

export const objectStore = {
  name: process.env.E2E_S3_CONTAINER ?? 'atrium-e2e-minio',
  port: Number(process.env.E2E_S3_PORT ?? 59000),
  image: 'minio/minio:latest',
  accessKeyId: 'atrium-e2e',
  secretAccessKey: 'atrium-e2e-secret',
  bucket: 'atrium-e2e-attachments',
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
    // The injected Next development control sits over WIRE's bottom-left
    // workspace strip. It is framework chrome, absent from production, and
    // must not intercept product controls during browser acceptance.
    ATRIUM_E2E: '1',
    DATABASE_URL: databaseUrl,
    BETTER_AUTH_SECRET: authSecret,
    APP_URL: appUrl,
    ATRIUM_MAIL_OUTBOX: mailOutbox,
    // Runtime configuration, not a value baked into the client bundle. Mutating
    // this back to NEXT_PUBLIC_WS_URL strands the live frame on same-origin
    // `/ws`, where the Next process has no WebSocket server.
    ATRIUM_WS_URL: `ws://localhost:${serverPort}/ws`,
    ATRIUM_SERVER_HTTP_URL: `http://localhost:${serverPort}`,
    S3_ENDPOINT: `http://localhost:${objectStore.port}`,
    S3_PUBLIC_ENDPOINT: `http://localhost:${objectStore.port}`,
    S3_BUCKET: objectStore.bucket,
    S3_ACCESS_KEY_ID: objectStore.accessKeyId,
    S3_SECRET_ACCESS_KEY: objectStore.secretAccessKey,
    S3_FORCE_PATH_STYLE: 'true',
    SERVER_PORT: String(serverPort),
    SERVER_HOST: '127.0.0.1',
    LOG_LEVEL: 'warn',
    // The Phase 2 simulation exercises the real worker without a network or a
    // paid model. This provider is double-opted-in and refuses to boot if a
    // gateway key is present; ordinary E2E prose produces an empty reading.
    INTERPRET_PROVIDER: 'acceptance-deterministic',
    ATRIUM_ACCEPTANCE_MODE: 'enabled',
    INTERPRET_MODEL_DEFAULT: 'acceptance/deterministic-v1',
    INTERPRET_MODEL_ESCALATION: 'acceptance/deterministic-v1',
    INTERPRET_COALESCE_SECONDS: '1',
    INTERPRET_WORKER_CONCURRENCY: '4',
    /**
     * One hop, so the throttle's IP dimension is genuinely live during the
     * suite rather than silently inert — a rate limiter nobody has ever seen
     * count is a rate limiter nobody has tested.
     *
     * Precisely why it works here, since round 2's comment overstated it: Next
     * fills `x-forwarded-for` from the socket's peer address **only when the
     * client sent none** (`??=` in `base-server.js`), and nothing in this suite
     * sends one — so the single-entry chain is the peer address and `hops=1`
     * reads it. In a real deployment `hops=1` is a claim that a reverse proxy
     * *appends*, and it is only as true as that proxy; with nothing in front,
     * `0` is the honest value and `docker-compose.yml` uses it.
     */
    ATRIUM_TRUSTED_PROXY_HOPS: '1',
    /**
     * A removed member's socket has to lose authority *within* this window, and
     * the suite should not have to wait five seconds to watch it happen.
     * Membership is re-read per command regardless; this bounds the session
     * half of the same question.
     */
    WS_REVALIDATE_TTL_MS: '1000',
    /**
     * And this bounds the half a command never reaches: a socket that only
     * listens is checked by the sweep or by nothing at all.
     */
    WS_SWEEP_INTERVAL_MS: '1000',
  };
}
