/**
 * Apply the shipped drizzle migrations to whatever `ATRIUM_TEST_DATABASE_URL`
 * (or `DATABASE_URL`) points at. Same entrypoint the integration suite's global
 * setup uses — this one is for a human at a terminal checking a migration by
 * hand before the suite runs.
 *
 *   ATRIUM_TEST_DATABASE_URL=postgres://… node scripts/dev-migrate.mjs
 */
import { createDatabase, migrationsFolder, runMigrations } from '../packages/db/dist/index.js';

const url = process.env.ATRIUM_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('set ATRIUM_TEST_DATABASE_URL or DATABASE_URL');
  process.exit(1);
}

const handle = createDatabase({ url, max: 1 });
try {
  await runMigrations(handle, migrationsFolder);
  console.log(`migrations applied from ${migrationsFolder}`);
} finally {
  await handle.close();
}
