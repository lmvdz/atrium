/**
 * Proves the database CI migrated is the database the schema describes —
 * exactly, in both directions.
 *
 * Round 1 asserted a hardcoded list of twelve table names existed. That catches
 * a migration that did not run; it does not catch a thirteenth table nobody
 * meant to create, a table dropped from the schema but still live in the
 * database, or a rename that left the old name behind. And the list itself was
 * a copy of the schema, so it went stale the moment the schema moved.
 *
 * Here the expected set is *derived* from the built schema export — the same
 * artifact the application imports — and compared for set equality against
 * information_schema. Extra fails. Missing fails.
 *
 * Run from packages/db (`pnpm --filter @atrium/db exec node ../../scripts/ci/assert-tables.mjs`)
 * so the drizzle-orm instance doing the reflection is the one the schema was
 * built against.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { importFrom } from './import-from.mjs';

/** Tables the migration tool owns. Drizzle keeps its journal in the `drizzle` schema by default; if a config change ever moves it into `public`, it is infrastructure, not drift. */
const INFRASTRUCTURE = new Set(['__drizzle_migrations']);

const EXPECTED_POSTGRES_MAJOR = process.env.EXPECTED_POSTGRES_MAJOR ?? '16';

const dbDir = process.env.DB_PACKAGE_DIR ?? process.cwd();
const schemaPath = resolve(dbDir, 'dist/schema.js');

export function diffTables(expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set([...actual].filter((name) => !INFRASTRUCTURE.has(name)));
  return {
    missing: [...expectedSet].filter((name) => !actualSet.has(name)).sort(),
    extra: [...actualSet].filter((name) => !expectedSet.has(name)).sort(),
    expected: [...expectedSet].sort(),
  };
}

async function main() {
  if (!existsSync(schemaPath)) {
    console.error(
      `::error::${schemaPath} does not exist — build @atrium/db before asserting its schema against the database.`,
    );
    return 1;
  }
  // Resolved from packages/db, not from wherever this script happens to live:
  // the reflection must use the same drizzle instance that produced
  // dist/schema.js.
  const { getTableName, is, Table } = await importFrom(dbDir, 'drizzle-orm');
  const postgres = (await importFrom(dbDir, 'postgres')).default;

  const schema = await import(pathToFileURL(schemaPath).href);
  const expected = Object.values(schema)
    .filter((value) => is(value, Table))
    .map((table) => getTableName(table));

  if (expected.length === 0) {
    console.error(
      '::error::The built schema exports no Drizzle tables. Deriving an empty expectation would make this gate assert nothing.',
    );
    return 1;
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('::error::DATABASE_URL is not set; this gate refuses to guess a database.');
    return 1;
  }

  const sql = postgres(url, { max: 1 });
  let rows;
  let version;
  try {
    rows = await sql`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
    `;
    [version] = await sql`show server_version`;
  } finally {
    await sql.end();
  }

  const problems = [];
  const serverVersion = String(version?.server_version ?? '');
  if (serverVersion.split('.')[0] !== EXPECTED_POSTGRES_MAJOR) {
    problems.push(
      `the service container is Postgres ${serverVersion || '(unknown)'}, expected major ${EXPECTED_POSTGRES_MAJOR}. The pinned image digest is not the image we think it is.`,
    );
  }

  const {
    missing,
    extra,
    expected: expectedSorted,
  } = diffTables(
    expected,
    rows.map((row) => row.table_name),
  );
  if (missing.length > 0)
    problems.push(`the schema declares tables the database does not have: ${missing.join(', ')}`);
  if (extra.length > 0) {
    problems.push(
      `the database has tables the schema does not declare: ${extra.join(', ')} (a stale migration, a manual edit, or a rename that left its old name behind)`,
    );
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::Schema gate: ${problem}`);
    return 1;
  }

  console.info(
    `Schema gate passed: Postgres ${serverVersion}, ${expectedSorted.length} tables, set-equal to the built schema export (${expectedSorted.join(', ')}).`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main());
}
