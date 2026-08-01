import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit owns only the application schema. pg-boss self-manages its own
 * `pgboss` schema and migrations (issue #16) — the two never collide.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://atrium:atrium@localhost:5432/atrium',
  },
  strict: true,
  verbose: true,
});
