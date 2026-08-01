/**
 * The composed stack's database is the schema the migrations describe.
 *
 * ## Why an exit code was not enough
 *
 * #40's round-2 gauntlet: "migration success means only exit code 0, with no
 * composed-stack schema assertion and no ledger case." That is the same defect
 * this whole ticket is about, one layer down. `migrate` is a one-shot whose
 * `service_completed_successfully` is the only thing the stack checks, and
 * `apps/server/src/migrate.ts` sets `process.exitCode = 1` on a *thrown*
 * migration — which leaves every way of finishing successfully while doing less
 * than the schema says: a migration folder that did not ship in the image, a
 * journal the image has and this tree does not, a table dropped out from under
 * the stack afterwards. `verify` asserts set equality against the built schema
 * export on a runner-provided Postgres; nothing asserted anything at all about
 * the database the *deployment* runs on.
 *
 * ## What it compares, and against what
 *
 * The running stack's `public` schema — read out of the `postgres` container
 * with the container's own credentials, never through the app — against
 * `packages/db/drizzle/meta/<latest>_snapshot.json`, which is the state drizzle
 * itself says the migrations arrive at. Three claims:
 *
 *  1. **Table set equality.** A missing table and an unexpected extra one both
 *     fail. One-directional containment would pass a database somebody added a
 *     table to by hand, which is how a deployment and its migrations drift apart
 *     without anybody choosing to.
 *  2. **Column set equality, per table.** A migration that created a table and
 *     stopped halfway, or an image carrying an older migration folder, produces
 *     exactly the right table names and the wrong columns.
 *  3. **Every journal entry is recorded as applied.** `drizzle.__drizzle_migrations`
 *     is drizzle's own ledger; its row count must equal the number of entries in
 *     `_journal.json`. This is the one that notices a migration folder that
 *     never made it into the image: applying zero migrations to an already-
 *     migrated volume is silent, and this is not.
 *
 * Deliberately **not** derived from `dist/schema.js` the way `assert-tables.mjs`
 * is: this job installs no dependencies and builds no packages, and a second
 * independent expression of the same truth is worth more here than a shared one.
 * If the two ever disagree, one of them is wrong and both are checked.
 *
 * ## What "matches" means here, exactly
 *
 * **Names.** Table names, column names per table, and a count. Column *types*,
 * nullability, defaults, indexes, constraints and enum values are not compared,
 * so a migration that only widens a column or drops a `not null` is invisible to
 * this file. That was pointed out by a blind review of the first version, whose
 * header said "the schema the migrations describe" and measured less than that.
 * Two honest reasons for the boundary, rather than one excuse: the snapshot's
 * type spellings and `information_schema`'s are different vocabularies
 * (`varchar(80)` against `character varying`, enum names against `USER-DEFINED`),
 * so comparing them means a translation table that would be its own source of
 * false reds; and the failure this step exists for — a migration that reported
 * success over a schema that is not there — is a *presence* failure. The type
 * comparison belongs to `verify`'s `assert-tables.mjs`, which has the built
 * schema export to compare against.
 *
 * The migration count is likewise a count: N rows in drizzle's ledger against N
 * entries in the journal. A volume already holding N *different* migrations
 * satisfies it. What it catches is the case it was written for — a migration
 * folder that never reached the image, so nothing was applied at all.
 *
 * ## Mutations it catches
 *
 * - a table dropped out of the composed stack after a green migration (ledger
 *   case `schema-short-of-the-migrations`). Every container stays healthy, the
 *   pages serve, signup works — the app never touches that table on those paths
 *   — and nothing else in the job looks at the schema at all.
 * - a `migrate` that exits 0 having applied nothing: the journal count is zero
 *   against a non-empty journal.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { queryDatabase } from './compose.mjs';
import { check, report } from './stack-client.mjs';

const META = 'packages/db/drizzle/meta';

/** The migrations this tree ships, and the state they arrive at. */
export function expectedSchema(metaDir = META) {
  const journal = JSON.parse(readFileSync(join(metaDir, '_journal.json'), 'utf8'));
  const entries = journal.entries ?? [];
  if (entries.length === 0) {
    throw new Error(
      `${metaDir}/_journal.json lists no migrations, so this check would assert an empty database is correct`,
    );
  }
  // The snapshot for the last journal entry. Named `<idx zero-padded>_<tag>` in
  // older drizzle and `<idx>_snapshot.json` in current ones, so it is found by
  // index rather than by guessing the spelling.
  const last = entries.at(-1);
  const prefix = String(last.idx).padStart(4, '0');
  const file = readdirSync(metaDir).find(
    (name) => name.startsWith(prefix) && name.endsWith('_snapshot.json'),
  );
  if (!file) {
    throw new Error(
      `${metaDir} has no snapshot for journal entry ${last.idx} (${last.tag}); without it there is nothing to compare the deployed database against`,
    );
  }
  const snapshot = JSON.parse(readFileSync(join(metaDir, file), 'utf8'));
  const columns = new Map();
  for (const table of Object.values(snapshot.tables ?? {})) {
    // Only the default schema: drizzle-kit owns `public`, and pg-boss
    // self-manages `pgboss` (see packages/db/drizzle.config.ts).
    if (table.schema && table.schema !== 'public') continue;
    columns.set(table.name, new Set(Object.keys(table.columns ?? {})));
  }
  return { migrations: entries.length, tables: columns, snapshot: file };
}

/**
 * The comparison, as a pure function, so `gate-selftest.mjs` can put a drifted
 * database through it without a stack.
 *
 * @param {{migrations: number, tables: Map<string, Set<string>>}} expected
 * @param {{migrations: number, tables: Map<string, Set<string>>}} actual
 */
export function checkSchema(expected, actual) {
  const problems = [];
  const expectedNames = [...expected.tables.keys()].sort();
  const actualNames = [...actual.tables.keys()].sort();

  const missing = expectedNames.filter((name) => !actual.tables.has(name));
  const extra = actualNames.filter((name) => !expected.tables.has(name));
  if (missing.length > 0) {
    problems.push(
      `the deployed database is missing ${missing.length} table(s) the migrations create: ${missing.join(', ')}. The migration container exited 0 and the schema is not what it says it is.`,
    );
  }
  if (extra.length > 0) {
    problems.push(
      `the deployed database has ${extra.length} table(s) no migration in this tree creates: ${extra.join(', ')}. Set equality, not containment: a table nobody's migration made is a deployment and a source tree that have drifted apart.`,
    );
  }
  for (const name of expectedNames) {
    const want = expected.tables.get(name);
    const have = actual.tables.get(name);
    if (!have) continue;
    const missingColumns = [...want].filter((column) => !have.has(column)).sort();
    const extraColumns = [...have].filter((column) => !want.has(column)).sort();
    if (missingColumns.length > 0 || extraColumns.length > 0) {
      problems.push(
        `\`${name}\` does not match the migrations: ${
          missingColumns.length > 0 ? `missing ${missingColumns.join(', ')}` : ''
        }${missingColumns.length > 0 && extraColumns.length > 0 ? '; ' : ''}${
          extraColumns.length > 0 ? `unexpected ${extraColumns.join(', ')}` : ''
        }`,
      );
    }
  }
  if (actual.migrations !== expected.migrations) {
    problems.push(
      `drizzle's own ledger records ${actual.migrations} applied migration(s); this tree ships ${expected.migrations}. A migration folder that never reached the image applies nothing to an already-migrated volume and exits 0, which is the quietest possible way for a deployment's schema to be a different tree's.`,
    );
  }
  return problems;
}

/** The `public` schema of the running stack, straight out of its own postgres. */
function deployedSchema() {
  // `.` as the separator: neither a table nor a column name in this schema
  // contains one, and psql's `-tA` output is otherwise unquoted, so anything
  // fancier would be a second thing to get wrong.
  const rows = queryDatabase(
    "select table_name || '.' || column_name from information_schema.columns where table_schema = 'public' order by 1",
  );
  const tables = new Map();
  for (const line of String(rows ?? '')
    .split('\n')
    .filter(Boolean)) {
    const dot = line.indexOf('.');
    const table = dot > 0 ? line.slice(0, dot) : '';
    const column = dot > 0 ? line.slice(dot + 1) : '';
    if (!table || !column) continue;
    if (!tables.has(table)) tables.set(table, new Set());
    tables.get(table).add(column);
  }
  // `to_regclass` is null rather than an error when the table is absent, so a
  // database that was never migrated at all reports 0 instead of throwing.
  const applied = queryDatabase(
    "select case when to_regclass('drizzle.__drizzle_migrations') is null then -1 else (select count(*) from drizzle.__drizzle_migrations) end",
  );
  return { tables, migrations: Number(applied) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const expected = expectedSchema();
  const actual = deployedSchema();
  if (actual.migrations === -1) {
    check(
      false,
      "the deployed database has no `drizzle.__drizzle_migrations` table, so no migration has ever been applied to it. `migrate` exited successfully; that is the gap between 'the container finished' and 'the schema is there'.",
    );
  }
  for (const problem of checkSchema(expected, actual)) check(false, problem);
  if (actual.migrations === expected.migrations && actual.tables.size === expected.tables.size) {
    console.info(
      `The deployed database matches ${expected.snapshot}: ${expected.tables.size} tables, every column, and all ${expected.migrations} migration(s) recorded as applied.`,
    );
  }
  report('assert-stack-schema');
}
