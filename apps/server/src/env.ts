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

/**
 * The MinIO credentials `docker-compose.yml` and `.env.example` ship with.
 * They exist so `pnpm infra:up && pnpm dev` works on a laptop with no setup —
 * and for no other reason. They are applied only when `NODE_ENV=development`;
 * anywhere else the real values must be supplied or the process refuses to
 * start. A published Atrium that boots on `atrium-dev-secret` is a public
 * object store.
 */
const DEV_S3_ACCESS_KEY_ID = 'atrium';
const DEV_S3_SECRET_ACCESS_KEY = 'atrium-dev-secret';

const RawEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required — copy .env.example to .env'),

  SERVER_HOST: z.string().default('0.0.0.0'),
  SERVER_PORT: z.coerce.number().int().positive().default(4000),

  WS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  INTERPRET_WORKER_CONCURRENCY: z.coerce.number().int().positive().max(50).default(2),

  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('atrium-attachments'),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /**
   * No default at the field level on purpose — a development-only fallback is
   * applied below, so an unset credential outside development is a hard error
   * rather than a silent `undefined` handed to the S3 client.
   */
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
});

const EnvSchema = RawEnvSchema.transform((raw, ctx) => {
  const development = raw.NODE_ENV === 'development';

  const required = (key: string, value: string | undefined, devFallback: string): string => {
    if (value) return value;
    if (development) return devFallback;
    ctx.addIssue({
      code: 'custom',
      path: [key],
      message: `${key} is required when NODE_ENV=${raw.NODE_ENV} — the compose/.env.example value is a development credential and is never applied outside development`,
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

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  loadDotEnv();
  const parsed = EnvSchema.safeParse({ ...source });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`invalid environment:\n${details}`);
  }
  return parsed.data;
}
