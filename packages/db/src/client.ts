import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema.js';

/** Absolute path to the generated SQL migrations shipped with this package. */
export const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

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
