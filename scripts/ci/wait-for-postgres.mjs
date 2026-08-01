/**
 * Waits for the Postgres service container, using the workspace's own client
 * rather than `pg_isready`, so readiness never depends on what the runner image
 * happens to ship. A deadline, not a retry-forever loop: a database that never
 * arrives must fail the job, not hang it until the job timeout.
 *
 * Run from packages/db:
 *   pnpm --filter @atrium/db exec node ../../scripts/ci/wait-for-postgres.mjs
 */

import { importFrom } from './import-from.mjs';

const DEADLINE_MS = Number(process.env.POSTGRES_WAIT_MS ?? 60_000);
const dbDir = process.env.DB_PACKAGE_DIR ?? process.cwd();

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('::error::DATABASE_URL is not set; this step refuses to guess a database.');
    return 1;
  }

  const postgres = (await importFrom(dbDir, 'postgres')).default;
  const deadline = Date.now() + DEADLINE_MS;
  let lastError = 'none';

  for (;;) {
    try {
      const sql = postgres(url, { max: 1, connect_timeout: 5 });
      const [row] = await sql.unsafe('select 1 as ok');
      await sql.end();
      if (row?.ok !== 1)
        throw new Error('the server answered, but not with the answer to `select 1`');
      console.info('Postgres is accepting connections.');
      return 0;
    } catch (error) {
      lastError = error.message;
      if (Date.now() > deadline) {
        console.error(
          `::error::Postgres service container never became ready within ${DEADLINE_MS}ms: ${lastError}`,
        );
        return 1;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
    }
  }
}

process.exit(await main());
