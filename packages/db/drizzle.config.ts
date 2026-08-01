import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit owns only the application schema. pg-boss self-manages its own
 * `pgboss` schema and migrations (issue #16) — the two never collide.
 */

/**
 * No localhost fallback. A migration tool that invents a connection string
 * silently targets the wrong database: on a VPS with a local postgres it would
 * happily migrate *that* one instead of failing, and on CI it would produce a
 * connection-refused error a hundred lines from its real cause.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    'DATABASE_URL is not set — drizzle-kit will not guess a database. Copy .env.example to .env, or export DATABASE_URL for this command.',
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
