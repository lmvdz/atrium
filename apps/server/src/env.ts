import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { z } from 'zod';

/**
 * `NODE_ENV` exactly as this process was started with, captured at import time
 * — before anything here can load a file.
 *
 * `NODE_ENV` is not configuration like the others. It decides whether the
 * published development credentials below are allowed to apply at all, so it
 * must come from whoever *started the process* and from nowhere else. A `.env`
 * is a file lying on a disk: it ships in a repo, it gets copied into an image
 * by an over-eager `COPY .`, it survives a `docker run` that meant to override
 * it. If a file can say `NODE_ENV=development`, then a file can turn the
 * credential fallback back on, and the fail-closed default is decoration.
 */
const PROCESS_NODE_ENV = process.env.NODE_ENV;

/**
 * Config comes from the environment, nowhere else. On a laptop we fill in the
 * gaps from the repo-root `.env` (Node 22's built-in loader — no dotenv
 * dependency); in Docker the values arrive as real environment variables and no
 * file exists.
 *
 * Note what this may and may not do: it may *supply* a value nobody set, and it
 * may never *change* `NODE_ENV`. `loadEnvFile` writes straight into
 * `process.env`, and it writes `NODE_ENV` along with everything else, so the
 * captured value is put back immediately afterwards — including deleting the
 * key again when the process genuinely had none. Anything else in the process
 * that reads `process.env.NODE_ENV` later then sees the truth too, not just the
 * schema below.
 */
function loadDotEnv(): void {
  for (const candidate of ['.env', '../.env', '../../.env']) {
    const path = resolve(process.cwd(), candidate);
    if (existsSync(path)) {
      loadEnvFile(path);
      restoreNodeEnv();
      return;
    }
  }
}

function restoreNodeEnv(): void {
  if (PROCESS_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = PROCESS_NODE_ENV;
}

/**
 * The MinIO credentials `docker-compose.yml` and `.env.example` ship with.
 * They exist so `pnpm infra:up && pnpm dev` works on a laptop with no setup —
 * and for no other reason. They are applied only when `NODE_ENV` is *explicitly*
 * `development`; anywhere else — including an environment where nobody set
 * `NODE_ENV` at all — the real values must be supplied or the process refuses
 * to start. A published Atrium that boots on `atrium-dev-secret` is a public
 * object store.
 */
const DEV_S3_ACCESS_KEY_ID = 'atrium';
const DEV_S3_SECRET_ACCESS_KEY = 'atrium-dev-secret';

/**
 * What every entrypoint in this app needs. The migration runner needs exactly
 * this and nothing more — see `loadMigrationEnv`.
 *
 * `NODE_ENV` defaults to `production`, not `development`. An unset `NODE_ENV`
 * means nobody said, and "nobody said" on a bare host is a host on the
 * internet. The safe default is the strict one: the development credential
 * fallback below requires someone to have opted into development out loud, in
 * the process environment — see `PROCESS_NODE_ENV`.
 */
const BaseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required — copy .env.example to .env'),
});

const RawEnvSchema = BaseEnvSchema.extend({
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

  SERVER_HOST: z.string().min(1).default('0.0.0.0'),
  SERVER_PORT: z.coerce.number().int().positive().default(4000),

  WS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  /**
   * How long an open socket's session is trusted between re-validations. The
   * window in which a revoked session still has authority is at most this long.
   */
  WS_REVALIDATE_TTL_MS: z.coerce.number().int().nonnegative().max(60_000).default(5_000),
  /**
   * How often every open socket is swept — session re-checked, room
   * memberships re-checked — whether or not it has sent anything.
   *
   * A socket that only listens sends no commands, so a per-command check never
   * runs for it; this is what bounds how long a removed member goes on
   * *receiving* a room's broadcasts. Deliberately has no "off" value: the
   * minimum is one second and the maximum five minutes, because a sweep nobody
   * runs is the round 2 behaviour this closes.
   */
  WS_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(15_000),
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

  S3_ENDPOINT: z.string().min(1).default('http://localhost:9000'),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(1).default('atrium-attachments'),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /**
   * No default at the field level on purpose — a development-only fallback is
   * applied below, so an unset credential outside development is a hard error
   * rather than a silent `undefined` handed to the S3 client. Values arrive
   * trimmed (see `trimmed`), so a key that is nothing but whitespace fails
   * `min(1)` instead of being handed to the S3 client as a real credential.
   */
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
});

const EnvSchema = RawEnvSchema.transform((raw, ctx) => {
  // Explicit opt-in only. `raw.NODE_ENV` is already `production` when nobody
  // set it, so this is false for an unset environment — which is the point.
  const development = raw.NODE_ENV === 'development';

  const required = (key: string, value: string | undefined, devFallback: string): string => {
    if (value) return value;
    if (development) return devFallback;
    ctx.addIssue({
      code: 'custom',
      path: [key],
      message: `${key} is required when NODE_ENV=${raw.NODE_ENV} (an unset NODE_ENV is treated as production) — the compose/.env.example value is a development credential and is never applied outside development`,
    });
    return '';
  };

  return {
    ...raw,
    S3_ACCESS_KEY_ID: required('S3_ACCESS_KEY_ID', raw.S3_ACCESS_KEY_ID, DEV_S3_ACCESS_KEY_ID),
    S3_SECRET_ACCESS_KEY: required(
      'S3_SECRET_ACCESS_KEY',
      raw.S3_SECRET_ACCESS_KEY,
      DEV_S3_SECRET_ACCESS_KEY,
    ),
  };
});

export type Env = z.infer<typeof EnvSchema>;
export type MigrationEnv = z.infer<typeof BaseEnvSchema>;

/**
 * Values whose development defaults are wrong in production, listed once.
 *
 * A default that is merely inconvenient in development is a silent
 * misconfiguration in production: a server that starts, reports healthy, and
 * signs nobody in. `apps/web/lib/env.ts` applies the same rule to the same
 * variables, deliberately.
 *
 * `ATRIUM_TRUSTED_PROXY_HOPS` is here for the same reason and a sharper one.
 * This process binds a port, so it *has* a peer address for every caller — but
 * only a deployment can say whether that address is the caller or a proxy's.
 * Unset, `clientIp` believes nothing and the rate limiter's IP dimension is
 * inert while looking configured, which is exactly what round 2 shipped into
 * compose. `0` is a perfectly good answer ("nothing is in front of me", which is
 * true of a published port on a single-node VPS); what is not acceptable is
 * nobody having answered. See `packages/auth/src/client-ip.ts`.
 */
const productionRequired = ['APP_URL', 'ATRIUM_TRUSTED_PROXY_HOPS'] as const;

/** Why each of them, in the words the operator needs rather than a generic line. */
const productionReason: Record<(typeof productionRequired)[number], string> = {
  APP_URL:
    'required in production — the development default is not a safe fallback for a' +
    ' process serving real traffic',
  ATRIUM_TRUSTED_PROXY_HOPS:
    'required in production — say what is in front of this process: 0 for a directly' +
    ' published port, or the number of reverse proxies that append to X-Forwarded-For.' +
    ' Unset is not 0; it silently disables the rate limiter’s IP dimension',
};

export function assertProductionSafe(source: NodeJS.ProcessEnv, env: Env): void {
  if (env.NODE_ENV !== 'production') return;
  const missing = productionRequired.filter((name) => !source[name]?.trim());
  if (missing.length === 0) return;
  throw new Error(
    `invalid environment:\n${missing.map((name) => `  ${name}: ${productionReason[name]}`).join('\n')}`,
  );
}

/**
 * Every value, trimmed before anything looks at it.
 *
 * A secret pasted into a `.env` or a deployment console arrives with the
 * newline or the trailing space that came with it far more often than anyone
 * admits, and `"atrium-dev-secret\n"` authenticates against nothing. Trimming
 * first also means a value that is *only* whitespace collapses to `""` and
 * fails its own `min(1)` — it can never read as "set" to the checks below.
 * Nothing in this config has meaningful leading or trailing whitespace.
 */
function trimmed(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    out[key] = typeof value === 'string' ? value.trim() : value;
  }
  return out;
}

/**
 * Parse a source into a schema, with `NODE_ENV` pinned to what the process was
 * started with.
 *
 * Two rules, both about the same thing:
 *  - the `.env` is only consulted when the source *is* the process environment.
 *    Hand this an explicit object and that object is the environment — a file
 *    on disk must not be able to reach into a caller's own config.
 *  - `NODE_ENV` is taken from the captured process value (or, for an explicit
 *    source, from that source), never from what `loadEnvFile` left behind.
 *    Setting it to `undefined` is what the schema's `production` default is
 *    for: an environment nobody declared is the strict one.
 */
function parseOrThrow<T extends z.ZodType>(schema: T, source: NodeJS.ProcessEnv): z.infer<T> {
  const fromProcess = source === process.env;
  const declared = fromProcess ? PROCESS_NODE_ENV : source.NODE_ENV;
  if (fromProcess) loadDotEnv();
  const parsed = schema.safeParse({ ...trimmed(source), NODE_ENV: declared?.trim() });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`invalid environment:\n${details}`);
  }
  return parsed.data;
}

/** The full server environment — realtime, workers, and object storage. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const env = parseOrThrow(EnvSchema, source);
  // `parseOrThrow` may have populated `process.env` from a `.env` file; re-read
  // it so a value that arrived that way counts as "configured" below.
  assertProductionSafe(source === process.env ? process.env : source, env);
  return env;
}

/**
 * The migration runner's environment: a connection string and a log level.
 *
 * Deliberately narrower than `loadEnv`. `migrate.js` never touches S3, and it
 * runs from the same production image as the server — demanding object-store
 * credentials it cannot use would train whoever deploys this to paste dummy
 * values into the one place the real check lives.
 */
export function loadMigrationEnv(source: NodeJS.ProcessEnv = process.env): MigrationEnv {
  return parseOrThrow(BaseEnvSchema, source);
}
