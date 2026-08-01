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

try {
  logger.info('applying migrations', { folder: migrationsFolder });
  await runMigrations(database, migrationsFolder);
  logger.info('migrations up to date');
} catch (error) {
  logger.error('migration failed', { error: (error as Error).message });
  process.exitCode = 1;
} finally {
  await database.close();
}
