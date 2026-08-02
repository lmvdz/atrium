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
  SERVER_HOST: z.string().min(1).default('0.0.0.0'),
  SERVER_PORT: z.coerce.number().int().positive().default(4000),

  WS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  /**
   * How often the fan-out set is re-checked against `memberships`, and therefore
   * the longest a revoked member can still be receiving a room's messages (#22
   * r9, D2).
   *
   * `positive()`, so there is no spelling of "off" — an unset value is not "no
   * revalidation", it is "the shipped window". Deliberately `.optional()` rather
   * than carrying its own `.default()`: the number lives in
   * `MEMBERSHIP_REVALIDATE_INTERVAL_MS` beside the timer it drives, and a default
   * here would be a second copy of it, free to drift and invisible when it did.
   * Same arrangement `reconcileIntervalMs` already uses.
   */
  WS_MEMBERSHIP_REVALIDATE_INTERVAL_MS: z.coerce.number().int().positive().optional(),
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
  return parseOrThrow(EnvSchema, source);
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
