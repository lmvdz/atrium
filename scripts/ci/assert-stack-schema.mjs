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
 * itself says the migrations arrive at. Five claims:
 *
 *  1. **Table set equality.** A missing table and an unexpected extra one both
 *     fail. One-directional containment would pass a database somebody added a
 *     table to by hand, which is how a deployment and its migrations drift apart
 *     without anybody choosing to.
 *  2. **Column set equality, per table.** A migration that created a table and
 *     stopped halfway, or an image carrying an older migration folder, produces
 *     exactly the right table names and the wrong columns.
 *  3. **Each column's type, nullability and default-presence.** A migration that
 *     widens `text` to `jsonb` or drops a `not null` keeps every name and changes
 *     what the application may store.
 *  4. **Each table's keys, check constraints and indexes**, by set equality:
 *     primary key columns, foreign keys with their target and `on delete`
 *     action, check constraint names, and index names with their uniqueness and
 *     columns. A lost `on delete cascade` and a missing unique index are both
 *     rules the database has stopped enforcing while reporting success.
 *  5. **Every journal entry is recorded as applied.** `drizzle.__drizzle_migrations`
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
 * Round 3 compared **names** — table names, column names per table, and a count
 * — while its success line said "every column", and the round-3 gauntlet said so
 * plainly: "the schema claim is names + count, while the success line says every
 * column. Types, nullability, defaults, indexes, constraints and enum values are
 * uncompared, so a widening or nulling migration stays green." The boundary was
 * stated honestly in this header and the copy oversold it, which is the worse of
 * the two ways to be wrong: a reader believes the sentence, not the paragraph.
 *
 * Round 4 moves the check up to the copy rather than the copy down to the check.
 * Compared now, per column: **type**, **nullability**, and **whether it has a
 * default**. Per table: **primary key** columns, **foreign keys** (columns,
 * target table and columns, and the `on delete` action), **check constraint
 * names**, and **indexes** (name, uniqueness and columns). So a migration that
 * widens `text` to `jsonb`, drops a `not null`, loses an `on delete cascade`, or
 * ships without a unique index is no longer invisible here.
 *
 * The vocabularies really are different and that was a real objection, so the
 * translation is explicit and small rather than absent: `pg_catalog`'s
 * `format_type` is used rather than `information_schema` (which reports every
 * enum as `USER-DEFINED` and loses the name — the actual reason the first
 * version gave up), and `TYPE_SPELLINGS` below is the whole table, six entries,
 * each of which is a drizzle spelling and the Postgres one for the same type.
 * An unknown spelling on either side is compared verbatim and therefore fails
 * loudly rather than being waved through.
 *
 * Still **not** compared, and named rather than implied: enum *values* (the
 * labels of the nine enums), default *expressions* (presence is compared, the
 * text is not), and check constraint *expressions* (names are compared, the
 * predicate is not). Each is a place where two spellings mean one thing —
 * `now()` against `CURRENT_TIMESTAMP`, `length(btrim(x)) > 0` against the
 * parenthesisation Postgres round-trips it to — and a translation table for them
 * would be a source of false reds rather than a check. `verify`'s
 * `assert-tables.mjs` owns the comparison against the built schema export.
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

/**
 * Drizzle's spelling of a type against Postgres's, where they differ.
 *
 * Six entries, and each one is a fact about Postgres rather than a convention:
 * the serial pseudo-types *are* an integer column plus a sequence default, and
 * `varchar`/`char`/`decimal` are aliases Postgres stores under their spelled-out
 * names. Anything not in this table — `uuid`, `text`, `jsonb`, `integer`,
 * `boolean`, `real`, `timestamp with time zone`, and every enum name — is the
 * same word on both sides and is compared verbatim, so a spelling nobody has
 * seen fails loudly instead of matching by accident.
 */
const TYPE_SPELLINGS = new Map([
  ['bigserial', 'bigint'],
  ['serial', 'integer'],
  ['smallserial', 'smallint'],
  ['varchar', 'character varying'],
  ['char', 'character'],
  ['decimal', 'numeric'],
]);

/** The serial pseudo-types, which are the one place a default is implied. */
const SERIALS = new Set(['bigserial', 'serial', 'smallserial']);

/**
 * One type name, in the spelling `format_type` would produce.
 *
 * `varchar(80)` → `character varying(80)`: the modifier is kept, because a
 * column widened from 80 to 400 is exactly the drift this comparison exists to
 * see. `public.` is stripped from the Postgres side because `format_type`
 * qualifies a name only when it is not on the search path, which is a fact about
 * the connection rather than about the schema.
 */
export function normalizeType(type) {
  const text = String(type ?? '')
    .trim()
    .replace(/^public\./, '');
  const open = text.indexOf('(');
  const base = open === -1 ? text : text.slice(0, open);
  const modifier = open === -1 ? '' : text.slice(open);
  return (TYPE_SPELLINGS.get(base) ?? base) + modifier;
}

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
  const tables = new Map();
  for (const table of Object.values(snapshot.tables ?? {})) {
    // Only the default schema: drizzle-kit owns `public`, and pg-boss
    // self-manages `pgboss` (see packages/db/drizzle.config.ts).
    if (table.schema && table.schema !== 'public') continue;
    const columns = new Map();
    const primaryKey = [];
    for (const column of Object.values(table.columns ?? {})) {
      const serial = SERIALS.has(column.type);
      columns.set(column.name, {
        type: normalizeType(column.type),
        // A serial is an integer column whose default is the sequence, so
        // drizzle records no `default` and Postgres reports `nextval(…)`. That
        // is one fact spelled two ways, not a drift.
        notNull: column.notNull === true,
        hasDefault: column.default !== undefined || serial,
      });
      if (column.primaryKey === true) primaryKey.push(column.name);
    }
    const constraints = new Set();
    if (primaryKey.length > 0) constraints.add(renderPrimaryKey(primaryKey));
    for (const composite of Object.values(table.compositePrimaryKeys ?? {})) {
      constraints.add(renderPrimaryKey(composite.columns ?? []));
    }
    for (const key of Object.values(table.foreignKeys ?? {})) {
      constraints.add(renderForeignKey(key));
    }
    for (const check of Object.keys(table.checkConstraints ?? {})) {
      constraints.add(`check \`${check}\``);
    }
    for (const unique of Object.values(table.uniqueConstraints ?? {})) {
      constraints.add(`unique (${[...(unique.columns ?? [])].sort().join(', ')})`);
    }
    const indexes = new Set();
    for (const index of Object.values(table.indexes ?? {})) {
      indexes.add(
        renderIndex(
          index.name,
          index.isUnique === true,
          (index.columns ?? []).map((column) => column.expression),
        ),
      );
    }
    tables.set(table.name, { columns, constraints, indexes });
  }
  return { migrations: entries.length, tables, snapshot: file };
}

/** Postgres normalises a key's column order to the index's, so both sides sort. */
function renderPrimaryKey(columns) {
  return `primary key (${[...columns].sort().join(', ')})`;
}

/**
 * One foreign key, in a spelling both sides can produce.
 *
 * `on delete` is included because losing a `cascade` is a schema change with
 * consequences at runtime and no visible symptom until a delete fails. `on
 * update` is not: drizzle emits `no action` for every key in this tree and
 * Postgres stores the same, so it would be a constant on both sides.
 */
function renderForeignKey({ columnsFrom = [], tableTo, columnsTo = [], onDelete }) {
  const action = String(onDelete ?? 'no action').toLowerCase();
  return `foreign key (${[...columnsFrom].join(', ')}) references ${tableTo} (${[...columnsTo].join(
    ', ',
  )}) on delete ${action}`;
}

function renderIndex(name, unique, columns) {
  return `${unique ? 'unique index' : 'index'} \`${name}\` (${columns.join(', ')})`;
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
    const missingColumns = [...want.columns.keys()].filter((column) => !have.columns.has(column));
    const extraColumns = [...have.columns.keys()].filter((column) => !want.columns.has(column));
    if (missingColumns.length > 0 || extraColumns.length > 0) {
      problems.push(
        `\`${name}\` does not match the migrations: ${
          missingColumns.length > 0 ? `missing ${missingColumns.sort().join(', ')}` : ''
        }${missingColumns.length > 0 && extraColumns.length > 0 ? '; ' : ''}${
          extraColumns.length > 0 ? `unexpected ${extraColumns.sort().join(', ')}` : ''
        }`,
      );
    }
    // Only columns both sides have: a column reported missing above would
    // otherwise be reported a second time as a type mismatch against nothing.
    for (const [column, wanted] of want.columns) {
      const held = have.columns.get(column);
      if (!held) continue;
      const differences = [];
      if (held.type !== wanted.type) {
        differences.push(`is \`${held.type}\` and the migrations say \`${wanted.type}\``);
      }
      if (held.notNull !== wanted.notNull) {
        differences.push(held.notNull ? 'is `not null` and should be nullable' : 'is nullable and the migrations say `not null`');
      }
      if (held.hasDefault !== wanted.hasDefault) {
        differences.push(held.hasDefault ? 'has a default the migrations do not give it' : 'has no default and the migrations give it one');
      }
      if (differences.length > 0) {
        problems.push(
          `\`${name}.${column}\` ${differences.join(', and ')}. A migration that widens a type or drops a \`not null\` reports success and changes what the application may store; this is the step that sees it.`,
        );
      }
    }
    for (const [what, key] of [
      ['constraint', 'constraints'],
      ['index', 'indexes'],
    ]) {
      const missing = [...want[key]].filter((entry) => !have[key].has(entry)).sort();
      const extra = [...have[key]].filter((entry) => !want[key].has(entry)).sort();
      if (missing.length > 0) {
        problems.push(
          `\`${name}\` is missing ${missing.length} ${what}(s) the migrations create: ${missing.join('; ')}. A key or a unique index that is not there is a rule the database has stopped enforcing.`,
        );
      }
      if (extra.length > 0) {
        problems.push(
          `\`${name}\` has ${extra.length} ${what}(s) no migration in this tree creates: ${extra.join('; ')}. Set equality, not containment, for the same reason it is used on tables.`,
        );
      }
    }
  }
  if (actual.migrations !== expected.migrations) {
    problems.push(
      `drizzle's own ledger records ${actual.migrations} applied migration(s); this tree ships ${expected.migrations}. A migration folder that never reached the image applies nothing to an already-migrated volume and exits 0, which is the quietest possible way for a deployment's schema to be a different tree's.`,
    );
  }
  return problems;
}

/**
 * The queries, kept apart from the reading so `gate-selftest.mjs` can put
 * recorded rows through the parser without a database.
 *
 * `pg_catalog` rather than `information_schema`, and that is the change that
 * made the type comparison possible at all: `information_schema.columns` reports
 * every one of this schema's nine enums as `USER-DEFINED` with the name in a
 * different column, while `format_type` gives the name and the modifier in the
 * spelling `CREATE TABLE` would take. Only ordinary tables (`relkind = 'r'`) and
 * only dropped-column-free real attributes (`attnum > 0 and not attisdropped`).
 *
 * `|` is the separator: no identifier, type name or action in this schema
 * contains one, and psql's `-tA` output is unquoted.
 */
export const SCHEMA_QUERIES = {
  columns: `select c.relname || '|' || a.attname || '|' || format_type(a.atttypid, a.atttypmod)
      || '|' || case when a.attnotnull then 't' else 'f' end
      || '|' || case when a.atthasdef then 't' else 'f' end
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
    order by 1`,
  constraints: `select c.relname || '|' || k.contype::text || '|' || k.conname
      || '|' || coalesce((select string_agg(att.attname, ',' order by att.attname)
                          from unnest(k.conkey) as key(attnum)
                          join pg_attribute att on att.attrelid = k.conrelid and att.attnum = key.attnum), '')
      || '|' || coalesce(f.relname, '')
      || '|' || coalesce((select string_agg(att.attname, ',' order by att.attname)
                          from unnest(k.confkey) as key(attnum)
                          join pg_attribute att on att.attrelid = k.confrelid and att.attnum = key.attnum), '')
      || '|' || k.confdeltype::text
    from pg_constraint k
    join pg_class c on c.oid = k.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_class f on f.oid = k.confrelid
    where n.nspname = 'public' and k.contype in ('p', 'f', 'u', 'c')
    order by 1`,
  indexes: `select c.relname || '|' || i.relname || '|' || case when x.indisunique then 't' else 'f' end
      || '|' || coalesce((select string_agg(att.attname, ',' order by k.ordinality)
                          from unnest(x.indkey::int[]) with ordinality as k(attnum, ordinality)
                          join pg_attribute att on att.attrelid = x.indrelid and att.attnum = k.attnum), '')
    from pg_index x
    join pg_class c on c.oid = x.indrelid
    join pg_class i on i.oid = x.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not x.indisprimary
      and not exists (select 1 from pg_constraint k where k.conindid = x.indexrelid)
    order by 1`,
  migrations: `select case when to_regclass('drizzle.__drizzle_migrations') is null then -1 else (select count(*) from drizzle.__drizzle_migrations) end`,
};

/** `confdeltype`'s one-letter codes, as drizzle spells the same actions. */
const ON_DELETE = new Map([
  ['a', 'no action'],
  ['r', 'restrict'],
  ['c', 'cascade'],
  ['n', 'set null'],
  ['d', 'set default'],
]);

function lines(rows) {
  return String(rows ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * The three result sets, folded into the same shape `expectedSchema` returns.
 *
 * Exported and pure so the self-test can drift one field of one row and watch
 * exactly one problem come back — a comparison whose failure modes are only ever
 * exercised through a live stack is a comparison nobody has watched go red.
 */
export function readSchema({ columns, constraints, indexes, migrations }) {
  const tables = new Map();
  const table = (name) => {
    if (!tables.has(name)) {
      tables.set(name, { columns: new Map(), constraints: new Set(), indexes: new Set() });
    }
    return tables.get(name);
  };
  for (const line of lines(columns)) {
    const [name, column, type, notNull, hasDefault] = line.split('|');
    if (!name || !column) continue;
    table(name).columns.set(column, {
      type: normalizeType(type),
      notNull: notNull === 't',
      hasDefault: hasDefault === 't',
    });
  }
  for (const line of lines(constraints)) {
    const [name, kind, conname, from, target, to, onDelete] = line.split('|');
    if (!name) continue;
    const held = table(name).constraints;
    if (kind === 'p') held.add(renderPrimaryKey(from ? from.split(',') : []));
    if (kind === 'u') held.add(`unique (${(from ?? '').split(',').sort().join(', ')})`);
    if (kind === 'c') held.add(`check \`${conname}\``);
    if (kind === 'f') {
      held.add(
        renderForeignKey({
          columnsFrom: from ? from.split(',') : [],
          tableTo: target,
          columnsTo: to ? to.split(',') : [],
          onDelete: ON_DELETE.get(onDelete) ?? onDelete,
        }),
      );
    }
  }
  for (const line of lines(indexes)) {
    const [name, index, unique, columnNames] = line.split('|');
    if (!name) continue;
    table(name).indexes.add(
      renderIndex(index, unique === 't', columnNames ? columnNames.split(',') : []),
    );
  }
  return { tables, migrations: Number(migrations) };
}

/**
 * The `public` schema of the running stack, straight out of its own postgres.
 *
 * `to_regclass` is null rather than an error when drizzle's ledger table is
 * absent, so a database that was never migrated at all reports -1 instead of
 * throwing.
 */
function deployedSchema() {
  return readSchema({
    columns: queryDatabase(SCHEMA_QUERIES.columns),
    constraints: queryDatabase(SCHEMA_QUERIES.constraints),
    indexes: queryDatabase(SCHEMA_QUERIES.indexes),
    migrations: queryDatabase(SCHEMA_QUERIES.migrations),
  });
}

/** What the success line is allowed to claim, counted rather than asserted. */
export function schemaTotals(expected) {
  let columns = 0;
  let constraints = 0;
  let indexes = 0;
  for (const table of expected.tables.values()) {
    columns += table.columns.size;
    constraints += table.constraints.size;
    indexes += table.indexes.size;
  }
  return { tables: expected.tables.size, columns, constraints, indexes };
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
  const problems = checkSchema(expected, actual);
  for (const problem of problems) check(false, problem);
  if (problems.length === 0 && actual.migrations !== -1) {
    const totals = schemaTotals(expected);
    // Every noun in this sentence is a number this run compared. Round 3's said
    // "every column" while comparing column *names*, which is the one thing a
    // success line must not do: the header can carry a boundary, a one-line
    // verdict is read as the whole claim.
    console.info(
      `The deployed database matches ${expected.snapshot}: ${totals.tables} tables, ${totals.columns} columns compared by name, type, nullability and default-presence, ${totals.constraints} keys and check constraints, ${totals.indexes} indexes, and all ${expected.migrations} migration(s) recorded as applied. Enum values, default expressions and check predicates are not compared — see the header.`,
    );
  }
  report('assert-stack-schema');
}
