import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { z } from 'zod';

/**
 * Config comes from the environment, nowhere else. In development we load the
 * repo-root `.env` (Node 22's built-in loader — no dotenv dependency); in
 * Docker the values arrive as real environment variables and no file exists.
 */
function loadDotEnv(): void {
  for (const candidate of ['.env', '../.env', '../../.env']) {
    const path = resolve(process.cwd(), candidate);
    if (existsSync(path)) {
      loadEnvFile(path);
      return;
    }
  }
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required — copy .env.example to .env'),

  /**
   * Signing secret, shared with the web app. Not validated here: `@atrium/auth`
   * owns that rule, so both processes fail the same way for the same reason.
   */
  BETTER_AUTH_SECRET: z.string().optional(),
  /**
   * The web app's public origin. Better Auth derives cookie names and the
   * `secure` flag from it, so this must match what the browser actually used or
   * every upgrade reads as unauthenticated — and the WebSocket upgrade checks
   * the browser's `Origin` header against it. A localhost default in production
   * would therefore refuse every real client while looking configured, which is
   * why `assertProductionSafe` below takes it away there.
   */
  APP_URL: z.url().default('http://localhost:3000'),

  SERVER_HOST: z.string().default('0.0.0.0'),
  SERVER_PORT: z.coerce.number().int().positive().default(4000),

  WS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  /**
   * How long an open socket's session is trusted between re-validations. The
   * window in which a revoked session still has authority is at most this long.
   */
  WS_REVALIDATE_TTL_MS: z.coerce.number().int().nonnegative().max(60_000).default(5_000),
  /**
   * Whether a client that sends no `Origin` header may open a socket.
   *
   * Browsers always send one, so `false` — the default — is right for a
   * browser-facing deployment and is what makes the origin check meaningful:
   * an attacker who could simply omit the header would face no check at all.
   * Set it only for a deployment with genuine non-browser clients (a load
   * prober, a CLI), and know that doing so means any process that can reach the
   * port and hold a cookie can open an authenticated socket.
   */
  WS_ALLOW_ORIGINLESS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  INTERPRET_WORKER_CONCURRENCY: z.coerce.number().int().positive().max(50).default(2),

  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_BUCKET: z.string().default('atrium-attachments'),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Values whose development defaults are wrong in production, listed once.
 *
 * A default that is merely inconvenient in development is a silent
 * misconfiguration in production: a server that starts, reports healthy, and
 * signs nobody in. `apps/web/lib/env.ts` applies the same rule to the same
 * variables, deliberately.
 */
const productionRequired = ['APP_URL'] as const;

export function assertProductionSafe(source: NodeJS.ProcessEnv, env: Env): void {
  if (env.NODE_ENV !== 'production') return;
  const missing = productionRequired.filter((name) => !source[name]?.trim());
  if (missing.length === 0) return;
  throw new Error(
    `invalid environment:\n${missing
      .map(
        (name) =>
          `  ${name}: required in production — the development default is not a` +
          ' safe fallback for a process serving real traffic',
      )
      .join('\n')}`,
  );
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  loadDotEnv();
  // `loadDotEnv` may have populated `process.env`; re-read it so a `.env` file
  // counts as "configured" for the production check below.
  const merged = source === process.env ? { ...process.env } : { ...source };
  const parsed = EnvSchema.safeParse(merged);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`invalid environment:\n${details}`);
  }
  assertProductionSafe(merged, parsed.data);
  return parsed.data;
}
