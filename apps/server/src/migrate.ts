import { createDatabase, migrationsFolder, runMigrations } from '@atrium/db';
import { loadMigrationEnv } from './env.js';
import { createLogger } from './logger.js';

/**
 * One-shot migration entrypoint. Compose runs this to completion before the
 * server starts, so the app never races an unmigrated database.
 *
 * Reads the narrow migration environment, not the server's: this process only
 * ever opens a database connection.
 */
const env = loadMigrationEnv();
const logger = createLogger(env.LOG_LEVEL);
const database = createDatabase({ url: env.DATABASE_URL, max: 1 });

const folder = migrationsFolder();

try {
  logger.info('applying migrations', { folder });
  await runMigrations(database, folder);
  logger.info('migrations up to date');
} catch (error) {
  /**
   * The exit code is set first, and this is the site where that ordering has
   * teeth. Compose runs this to completion and starts the server only if it
   * succeeds — so a failed migration that exits **0** boots the app against a
   * database it has not migrated. Round 8 read `(error as Error).message`
   * before setting the code, which meant a driver rejecting with a hostile
   * `message` getter produced exactly that: the assignment below never ran, the
   * `finally` closed the pool, and the process reported success.
   *
   * Fixed by ordering rather than by `describeUnknown`, deliberately: this
   * entrypoint's whole claim is that it loads the *narrow* migration
   * environment and opens nothing but a database connection, and importing
   * `@atrium/auth` for one string would pull Better Auth into the migration
   * container to contradict it. Ordering is sufficient for the property that
   * matters — a formatting throw here leaves `exitCode` already 1 and dies
   * loudly on the way out, so there is no path to a green failed migration.
   */
  process.exitCode = 1;
  logger.error('migration failed', { error: (error as Error).message });
} finally {
  await database.close();
}
