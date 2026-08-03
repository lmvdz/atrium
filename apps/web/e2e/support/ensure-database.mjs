import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import postgres from 'postgres';
import { container, databaseUrl, mailOutbox } from './config.mjs';

/**
 * Gets a Postgres ready for `pnpm test:e2e`, then migrates and empties it.
 *
 * This runs *before* Playwright, not inside `globalSetup`, because Playwright
 * starts its `webServer` processes before global setup runs — by the time a
 * global setup could migrate, the servers would already have tried to query
 * tables that do not exist.
 *
 * The order is: use `E2E_DATABASE_URL` if it answers; otherwise start a
 * throwaway container; otherwise fail with a sentence that says what to do. It
 * never silently skips — a green suite that tested nothing is worse than a red
 * one that says why.
 */

const RESET = process.env.E2E_KEEP_DATA !== '1';

async function main() {
  if (!(await reachable(databaseUrl))) {
    await startContainer();
  }

  await migrate();
  if (RESET) await truncate();
  seedReplay();

  // A stale outbox would let a test read a link from a previous run.
  rmSync(mailOutbox, { force: true });

  console.info(`[e2e] database ready at ${redact(databaseUrl)}`);
}

/**
 * #25's browser proof reads the same deterministic 454-message room a person
 * can seed locally. The provider is precomputed and reports zero API spend,
 * but every interpretation and proposal still traverses the production worker.
 */
function seedReplay() {
  try {
    execFileSync(
      'pnpm',
      ['--filter', '@atrium/server', 'exec', 'tsx', '../../scripts/seed-replay.ts'],
      {
        cwd: new URL('../../../../', import.meta.url),
        encoding: 'utf8',
        env: { ...process.env, ATRIUM_REPLAY_DATABASE_URL: databaseUrl },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    fail(`could not seed the persisted replay: ${error.stderr || error.message}`);
  }
}

async function reachable(url) {
  const sql = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

async function startContainer() {
  if (!hasDocker()) {
    fail(
      `no Postgres at ${redact(databaseUrl)} and docker is not available.\n` +
        '  Start one and re-run, or point E2E_DATABASE_URL at an existing database:\n' +
        `  E2E_DATABASE_URL=postgres://user:pass@host:5432/db pnpm test:e2e`,
    );
  }

  console.info(`[e2e] starting ${container.image} as ${container.name} on :${container.port}`);
  try {
    // `docker start` on an existing container, `docker run` on a fresh one.
    // Either way the port and credentials come from config.mjs.
    const existing = docker(['ps', '-aq', '-f', `name=^${container.name}$`]).trim();
    if (existing) {
      docker(['start', container.name]);
    } else {
      docker([
        'run',
        '-d',
        '--name',
        container.name,
        '-e',
        `POSTGRES_USER=${container.user}`,
        '-e',
        `POSTGRES_PASSWORD=${container.password}`,
        '-e',
        `POSTGRES_DB=${container.database}`,
        '-p',
        `${container.port}:5432`,
        container.image,
      ]);
    }
  } catch (error) {
    fail(`could not start the test database container: ${error.message}`);
  }

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await reachable(databaseUrl)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail(`the test database container never became reachable at ${redact(databaseUrl)}`);
}

async function migrate() {
  // Imported lazily: the packages must be built first, and saying so plainly
  // beats a module-resolution stack trace.
  let db;
  try {
    db = await import('@atrium/db');
  } catch (error) {
    fail(
      `could not load @atrium/db (${error.message}).\n` +
        '  Build the workspace packages first: pnpm --filter "./packages/*" build',
    );
  }

  const handle = db.createDatabase({ url: databaseUrl, max: 1 });
  try {
    await db.runMigrations(handle, db.migrationsFolder());
  } finally {
    await handle.close();
  }
}

/**
 * Empties every application table between runs. `TRUNCATE ... CASCADE` over the
 * public schema keeps this correct as the schema grows, instead of a list that
 * silently stops covering new tables. pg-boss lives in its own schema and is
 * left alone.
 */
async function truncate() {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const tables = await sql`
      select tablename from pg_tables
      where schemaname = 'public' and tablename <> '__drizzle_migrations'
    `;
    if (tables.length === 0) return;
    const list = tables.map((row) => `"public"."${row.tablename}"`).join(', ');
    await sql.unsafe(`truncate table ${list} restart identity cascade`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function hasDocker() {
  try {
    docker(['version', '--format', '{{.Server.Version}}']);
    return true;
  } catch {
    return false;
  }
}

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function redact(url) {
  return url.replace(/\/\/[^@]*@/, '//***@');
}

function fail(message) {
  console.error(`[e2e] ${message}`);
  process.exit(1);
}

await main();
