import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

/* ═══════════════════════════════════════════════════════════════════════════
 * THE T5 TWO-BROWSER ACCEPTANCE ELECTRIC STACK (#219).
 *
 * A DEDICATED postgres(wal_level=logical) + electric-init + electric stack, stood
 * up under its OWN compose project (`atrium-t5electric`) on UNIQUE loopback ports,
 * so the two-real-browser acceptance run (playwright.destination-electric.config.ts)
 * has a live Electric sync fabric WITHOUT touching:
 *   - the default `atrium-*` compose project (atrium-postgres-1 / atrium-minio-1),
 *   - the shared `atrium-e2e-postgres` / `atrium-e2e-minio` the destination run uses,
 *   - or any `dagon-*` tenant.
 *
 * It reuses the REAL production services from `docker-compose.yml` +
 * `docker-compose.electric-dev.yml` (the T0 #214 bring-up), so the posture is the
 * production one — postgres logical, the least-privilege `atrium_electric` role
 * from `deploy/electric-role.sql`, the manual-publishing electric service — not a
 * bespoke facsimile. Only the project name and the published ports differ, and a
 * fresh set of named volumes is created and destroyed with the stack.
 *
 * Bring-up order MATTERS and mirrors `pnpm infra:up:electric`:
 *   1. postgres up (its own logical volume)          → wait healthy
 *   2. migrations from the HOST                       → creates the Electric
 *      publication (0053) + covenant_status (0056) + the yjs substrate flag (0057)
 *   3. electric-init                                  → the replication role/grants
 *   4. electric up                                    → wait /v1/health active
 *
 * `--no-deps` skips the heavy docker `migrate` image build; migrations run from the
 * host exactly as the everyday dev loop and `infra:up:electric` do.
 *
 * Teardown is `down -v`: the containers AND the T5-only named volumes go, so a
 * re-run starts clean and nothing is left on the box.
 * ═════════════════════════════════════════════════════════════════════════ */

/** Its own compose project — never the default `atrium` one, never `dagon-*`. */
export const PROJECT = 'atrium-t5electric';

/** Unique loopback ports. 55433 (pg) and 3110 (electric) avoid 5432/5433 (default),
 *  55432 (e2e pg), 5434 (dagon pg), and 3100 (the dev electric override). */
export const PG_PORT = 55433;
export const ELECTRIC_PORT = 3110;

/** Test credentials — obviously not production values. */
const POSTGRES_USER = 'atrium';
const POSTGRES_PASSWORD = 'atrium';
const POSTGRES_DB = 'atrium';
export const ELECTRIC_SECRET = 'atrium-t5-two-browser-electric-secret';
const ELECTRIC_DATABASE_PASSWORD = 'atrium-t5-two-browser-electric-db-pw';

/** The app + harness + migrations all point here. Database `atrium` matches the
 *  compose POSTGRES_DB, so migrate, electric-init and electric all agree on it. */
export const DATABASE_URL = `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${PG_PORT}/${POSTGRES_DB}`;

/** What the app's shape proxy forwards to (host loopback, the published port). */
export const ELECTRIC_URL = `http://127.0.0.1:${ELECTRIC_PORT}`;

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/** Every `${VAR:?…}` the two compose files reference must resolve at parse time,
 *  even for services this stack never starts (minio, app, server, proxy). Test
 *  values for the unused ones; the real ones for postgres/electric-init/electric. */
function composeEnv() {
  return {
    ...process.env,
    COMPOSE_PROJECT_NAME: PROJECT,
    POSTGRES_USER,
    POSTGRES_PASSWORD,
    POSTGRES_DB,
    POSTGRES_PORT: String(PG_PORT),
    ELECTRIC_PORT: String(ELECTRIC_PORT),
    ELECTRIC_SECRET,
    ELECTRIC_DATABASE_PASSWORD,
    // Referenced by minio / minio-init / app / server / proxy at parse time; those
    // services are never started here, but compose evaluates interpolation across
    // the WHOLE file, so every `${VAR:?}` (strictly-required) var must resolve.
    S3_ACCESS_KEY_ID: 'atrium-t5-unused',
    S3_SECRET_ACCESS_KEY: 'atrium-t5-unused-secret',
    MINIO_PORT: '59900',
    MINIO_CONSOLE_PORT: '59901',
    ATRIUM_DOMAIN: 'localhost',
    ATRIUM_MAIL_TRANSPORT: 'smtp',
    BETTER_AUTH_SECRET: 'atrium-t5-unused-auth-secret-0123456789abcdef',
  };
}

function compose(args, opts = {}) {
  return execFileSync(
    'docker',
    [
      'compose',
      '-p',
      PROJECT,
      '-f',
      'docker-compose.yml',
      '-f',
      'docker-compose.electric-dev.yml',
      '-f',
      'apps/web/e2e/support/t5-electric-net.yml',
      ...args,
    ],
    {
      cwd: repoRoot,
      env: composeEnv(),
      encoding: 'utf8',
      stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    },
  );
}

async function pgReachable() {
  const sql = postgres(DATABASE_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

async function waitFor(label, check, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`[t5-electric] ${label} did not become ready within ${timeoutMs}ms`);
}

async function electricActive() {
  try {
    const response = await fetch(`${ELECTRIC_URL}/v1/health`);
    if (!response.ok) return false;
    const body = await response.json();
    return body?.status === 'active';
  } catch {
    return false;
  }
}

async function migrate() {
  let dbmod;
  try {
    dbmod = await import('@atrium/db');
  } catch (error) {
    throw new Error(
      `[t5-electric] could not load @atrium/db (${error.message}). Build packages first: pnpm --filter "./packages/*" build`,
    );
  }
  const handle = dbmod.createDatabase({ url: DATABASE_URL, max: 1 });
  try {
    await dbmod.runMigrations(handle, dbmod.migrationsFolder());
  } finally {
    await handle.close();
  }
}

export async function up() {
  console.info(`[t5-electric] bringing up postgres(logical) on 127.0.0.1:${PG_PORT} (project ${PROJECT})`);
  compose(['up', '-d', '--no-deps', 'postgres']);
  await waitFor('postgres', pgReachable);

  console.info('[t5-electric] applying migrations (publication + covenant_status + substrate flag)');
  await migrate();

  console.info('[t5-electric] provisioning the atrium_electric replication role (electric-init)');
  compose(['up', '--no-deps', '--abort-on-container-exit', '--exit-code-from', 'electric-init', 'electric-init']);

  console.info(`[t5-electric] starting electric on 127.0.0.1:${ELECTRIC_PORT}`);
  compose(['up', '-d', '--no-deps', 'electric']);
  await waitFor('electric /v1/health=active', electricActive);
  console.info('[t5-electric] stack ready');
}

export function down() {
  console.info(`[t5-electric] tearing down project ${PROJECT} (down -v --remove-orphans)`);
  try {
    compose(['down', '-v', '--remove-orphans'], { inherit: true });
  } catch (error) {
    console.error(`[t5-electric] teardown reported: ${error.message}`);
  }
}

// CLI: `node electric-stack.mjs up|down`. Imported for its constants elsewhere
// (the guard keeps an import from starting docker).
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const cmd = process.argv[2];
  if (cmd === 'up') {
    await up();
  } else if (cmd === 'down') {
    down();
  } else {
    console.error('usage: node electric-stack.mjs up|down');
    process.exit(2);
  }
}
