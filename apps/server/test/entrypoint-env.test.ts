import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The `.env` question, asked of the real thing.
 *
 * `env.test.ts` hands `loadEnv` an explicit source object, which is the right
 * way to test the schema and the wrong way to test the *file*: no `.env` is
 * ever read, so the one path that matters here — a file on disk deciding what
 * environment this process thinks it is in — is not exercised at all. That is
 * how r3 shipped a `loadEnv` whose dotenv step could flip an externally-unset
 * `NODE_ENV` to `development` and re-arm the published credentials.
 *
 * So these tests spawn `apps/server/src/index.ts` — the actual entrypoint the
 * container runs, no copied logic — in a scratch directory with a planted
 * `.env`, and control the process environment on the way in. What the process
 * says about itself on the way out is the assertion.
 */

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const SERVER_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(SERVER_ROOT, '../..');
const ENTRYPOINT = join(SERVER_ROOT, 'src/index.ts');
const TSX = join(SERVER_ROOT, 'node_modules/.bin/tsx');

/** Never contacted: every case here is decided before the first query. */
const DB_URL = 'postgres://atrium:atrium@127.0.0.1:5432/atrium';

/**
 * The entrypoint imports `@atrium/db`, which resolves to its build output. The
 * root `typecheck` and `build` scripts produce it; a bare `vitest run` in this
 * package might not have, so make sure rather than skipping — a test that
 * silently opts out of the thing it is named after is worse than no test.
 */
beforeAll(() => {
  const built = ['packages/core/dist/index.js', 'packages/db/dist/index.js'].every((path) =>
    existsSync(join(REPO_ROOT, path)),
  );
  if (built) return;
  execFileSync('pnpm', ['--filter', './packages/*', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    timeout: 180_000,
  });
}, 190_000);

interface BootResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Boot the real entrypoint in a scratch cwd holding `dotenv`, with exactly the
 * environment in `env` — nothing inherited but `PATH` and `HOME`, so a
 * developer's own shell cannot make a failing case pass.
 *
 * Resolves when the process exits, or as soon as `until` appears on stdout (at
 * which point it is killed — the assertion has what it needs and nobody wants a
 * server left listening).
 */
function boot(options: {
  dotenv: string;
  env: Record<string, string>;
  until?: string;
}): Promise<BootResult> {
  // Nested, so `../.env` and `../../.env` — the other candidates `loadDotEnv`
  // walks — resolve inside a directory this test owns and left empty.
  const root = mkdtempSync(join(tmpdir(), 'atrium-env-'));
  const cwd = join(root, 'a', 'b');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, '.env'), options.dotenv, 'utf8');

  const child = spawn(TSX, [ENTRYPOINT], {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise<BootResult>((resolvePromise, rejectPromise) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      child.kill('SIGKILL');
      resolvePromise({ code, stdout, stderr });
    };

    const deadline = setTimeout(() => {
      finish(null);
    }, 25_000);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (options.until && stdout.includes(options.until)) finish(null);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      rejectPromise(error);
    });
    child.on('exit', (code) => {
      finish(code);
    });
  });
}

const DEV_ENV_FILE = [
  'NODE_ENV=development',
  `DATABASE_URL=${DB_URL}`,
  'LOG_LEVEL=info',
  'SERVER_PORT=45871',
  '',
].join('\n');

describe('the entrypoint, booted with a planted .env', () => {
  it('does not let the file downgrade an unset NODE_ENV — it boots as production', async () => {
    const result = await boot({
      // The file says development *and* supplies real credentials (including
      // the ones only production demands), so the process starts either way.
      // What it prints is which environment it decided it was in, and a file
      // does not get to decide that.
      dotenv:
        `${DEV_ENV_FILE}S3_ACCESS_KEY_ID=AKIAREAL\nS3_SECRET_ACCESS_KEY=a-real-secret\n` +
        'APP_URL=https://atrium.example\nATRIUM_TRUSTED_PROXY_HOPS=0\n',
      env: {},
      until: 'atrium server starting',
    });

    expect(result.stdout).toContain('atrium server starting');
    expect(result.stdout).toContain('"env":"production"');
    expect(result.stdout).not.toContain('"env":"development"');
  }, 30_000);

  it('fails closed when the file is the only thing claiming development', async () => {
    // The r3 hole, exactly: no NODE_ENV in the environment, a `.env` that says
    // development, and no credentials. Before the fix this booted on the
    // published dev secret; now it refuses and says why.
    const result = await boot({ dotenv: DEV_ENV_FILE, env: {} });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('invalid environment');
    expect(result.stderr).toContain('S3_ACCESS_KEY_ID');
    expect(result.stderr).toContain('an unset NODE_ENV is treated as production');
    // And it got as far as the credential check, which means the file *was*
    // read — DATABASE_URL came from nowhere else.
    expect(result.stderr).not.toContain('DATABASE_URL');
  }, 30_000);

  it('does not let the file downgrade an explicit production either', async () => {
    const result = await boot({ dotenv: DEV_ENV_FILE, env: { NODE_ENV: 'production' } });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('S3_ACCESS_KEY_ID is required when NODE_ENV=production');
  }, 30_000);

  it('still honours development when the *process* environment opts in', async () => {
    // The laptop path, unchanged: `pnpm dev` sets NODE_ENV in the script, the
    // fallback credentials apply, and the `.env` still supplies DATABASE_URL.
    const result = await boot({
      dotenv: DEV_ENV_FILE,
      env: { NODE_ENV: 'development' },
      until: 'atrium server starting',
    });

    expect(result.stdout).toContain('"env":"development"');
    expect(result.stderr).not.toContain('invalid environment');
  }, 30_000);

  it('reads the rest of the file — a .env is still how a laptop is configured', async () => {
    // Nothing but the file supplies DATABASE_URL here, and the process gets
    // far enough to bind its port. Proof the fix narrowed dotenv to NODE_ENV
    // rather than switching it off.
    const result = await boot({
      dotenv: DEV_ENV_FILE,
      env: { NODE_ENV: 'development' },
      until: 'realtime server listening',
    });

    expect(result.stdout).toContain('45871');
  }, 30_000);
});
