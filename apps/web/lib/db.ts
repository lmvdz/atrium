import 'server-only';
import { createDatabase, type Database } from '@atrium/db';
import { databaseUrl } from './env';

/**
 * One Postgres pool per Node process, kept on `globalThis` so the dev server's
 * hot reload does not open a new pool on every edit until the database refuses
 * connections. Standard Next.js practice, and the reason it is standard.
 */
const key = Symbol.for('atrium.web.database');

interface Holder {
  [key]?: ReturnType<typeof createDatabase>;
}

function handle() {
  const holder = globalThis as unknown as Holder;
  // Small pool on purpose: init.md budgets one app server and one worker.
  holder[key] ??= createDatabase({ url: databaseUrl(), max: 5 });
  return holder[key];
}

export function db(): Database {
  return handle().db;
}
