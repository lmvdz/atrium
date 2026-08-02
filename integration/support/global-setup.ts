import { createDatabase, migrationsFolder, runMigrations } from '@atrium/db';
import { databaseUrl } from './env.js';

/**
 * Apply the real migrations once, before any test file runs.
 *
 * `migrationsFolder()` is the same path `apps/server/src/migrate.ts` ships to
 * production, so what these tests assert about constraints is what a deployed
 * database actually has. A test schema built by hand would drift the first time
 * someone edited one and not the other, and would then keep passing.
 */
export default async function setup(): Promise<void> {
  const database = createDatabase({ url: databaseUrl(), max: 1 });
  try {
    await runMigrations(database, migrationsFolder());
  } finally {
    await database.close();
  }
}
