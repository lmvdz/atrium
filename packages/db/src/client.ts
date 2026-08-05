import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as authSchema from './auth-schema.js';
import * as appSchema from './schema.js';

/** Every table in one object — application tables and Better Auth's alike. */
const schema = { ...appSchema, ...authSchema };

/**
 * Absolute path to the generated SQL migrations shipped with this package.
 *
 * A function, and built with `join` rather than `new URL('../drizzle',
 * import.meta.url)`, because bundlers read the latter as a static asset
 * reference and try to resolve a directory that only exists on disk. The web app
 * imports this module for its database client and must not drag the migration
 * folder into its build.
 */
export function migrationsFolder(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
}

export interface DatabaseOptions {
  /** Postgres connection string, e.g. `process.env.DATABASE_URL`. */
  url: string;
  /** Pool size. Keep small: one app server, one worker process (init.md). */
  max?: number;
  /** Log every statement — handy in tests, noisy in production. */
  debug?: boolean;
}

export interface DatabaseHandle {
  db: ReturnType<typeof drizzle<typeof schema>>;
  /** Raw postgres-js client, for LISTEN/NOTIFY and anything Drizzle can't express. */
  sql: postgres.Sql;
  close: () => Promise<void>;
}

/**
 * Creates the app's Postgres handle. The caller owns the lifetime and must
 * `close()` on shutdown — apps/server wires this into its signal handlers.
 */
export function createDatabase({ url, max = 10, debug = false }: DatabaseOptions): DatabaseHandle {
  const sql = postgres(url, { max, onnotice: debug ? undefined : () => {} });
  const db = drizzle(sql, { schema, logger: debug });
  return {
    db,
    sql,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

/** Applies every pending drizzle migration. Safe to run on every boot. */
export async function runMigrations(handle: DatabaseHandle, migrationsFolder: string) {
  await migrate(handle.db, { migrationsFolder });
}

export type Database = DatabaseHandle['db'];
