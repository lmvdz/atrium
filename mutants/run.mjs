#!/usr/bin/env node
/**
 * The mutant runner for issue #22's realtime layer.
 *
 * Standing campaign rule, routed out of #21's round-2 gauntlet: **a mutation
 * claim ships with a committed, re-runnable mutant list and its results, or it
 * is not evidence.** `packages/core/mutants/` is the same thing for the core
 * engine; this is the realtime layer's, and it has one extra job that one does
 * not — half of what this ticket fixed lives in SQL, so half the mutants are
 * SQL.
 *
 *   node mutants/run.mjs                # run all, rewrite RESULTS.md
 *   node mutants/run.mjs --check        # …and exit 1 if any survives
 *   node mutants/run.mjs --only <id>    # one mutant, no RESULTS.md
 *   node mutants/run.mjs --verbose      # …and list the failing tests
 *   node mutants/run.mjs --suite unit   # skip the database half
 *
 * The integration mutants need a database, and they need it the same way the
 * suite does: `ATRIUM_TEST_DATABASE_URL` pointing at a migrated Postgres. The
 * simplest way to get one is
 *
 *   ./scripts/integration-test.sh --keep
 *   ATRIUM_TEST_DATABASE_URL=postgres://atrium_test:atrium_test@127.0.0.1:55445/atrium_test \
 *     node mutants/run.mjs
 *
 * ## Two kinds of mutant
 *
 * **`file`** — one verbatim substitution in one source file, restored in a
 * `finally`. Exactly the core runner's shape.
 *
 * **`sql`** — a statement executed against the live database, reverting a
 * deployed object to its round-2 behaviour. Migrations are journalled, so
 * editing `0004_…sql` after it has been applied changes nothing; the honest way
 * to demonstrate that the boundary is load-bearing is to *remove it from the
 * database that the tests are actually talking to*, and then put it back.
 *
 * Restoring is the part that could lie, so it does not use a copy: the restore
 * statements are extracted from `packages/db/drizzle/0004_…sql` at run time by
 * their leading marker, and re-executed. If the migration and the restore ever
 * disagreed, the restore would be re-deploying something this repo does not
 * ship — so it re-deploys exactly what the repo ships, or the run fails.
 *
 * ## The two ways a ledger like this lies, both closed
 *
 *  1. **A mutant that no longer applies.** A `file` mutant's `find` must occur
 *     exactly once; a `sql` mutant's restore markers must each match exactly one
 *     statement. Anything else is reported as `error` and fails `--check`.
 *  2. **A mutant caught by the wrong test.** `catches` names the tests that must
 *     go red, and every one of them must actually have. A mutant that only trips
 *     something unrelated is recorded as an escape, because the claim is "this
 *     test pins this rule", not "something, somewhere, noticed".
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const LEDGER = join(HERE, 'mutants.json');
const RESULTS = join(HERE, 'RESULTS.md');
const MIGRATION = join(ROOT, 'packages/db/drizzle/0004_trusted_actor_and_append_boundary.sql');

const args = process.argv.slice(2);
const check = args.includes('--check');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const verbose = args.includes('--verbose');
const suiteFilter = args.includes('--suite') ? args[args.indexOf('--suite') + 1] : null;

const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
let mutants = ledger.mutants;
if (only) mutants = mutants.filter((m) => m.id === only);
if (suiteFilter) mutants = mutants.filter((m) => m.suite === suiteFilter);
if (mutants.length === 0) {
  console.error(only ? `no mutant with id "${only}"` : 'nothing selected');
  process.exit(1);
}

const databaseUrl = process.env.ATRIUM_TEST_DATABASE_URL ?? null;
const needsDatabase = mutants.some((m) => m.suite === 'integration');
if (needsDatabase && !databaseUrl) {
  console.error(
    'ATRIUM_TEST_DATABASE_URL is not set, and integration mutants are selected.\n' +
      'Start one with `./scripts/integration-test.sh --keep`, or run `--suite unit`.\n' +
      'There is deliberately no skip: a mutant run that quietly covered half the\n' +
      'ledger would be the same class of false receipt the ledger exists to prevent.',
  );
  process.exit(1);
}

/* ── restoring SQL from the migration, never from a copy ───────────────────── */

const migrationStatements = readFileSync(MIGRATION, 'utf8')
  .split('--> statement-breakpoint')
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0);

/** Every statement whose first non-comment line starts with `marker`. */
function statementsFor(marker) {
  return migrationStatements.filter((statement) => {
    const body = statement
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .trim();
    return body.startsWith(marker);
  });
}

/* ── the test suites ───────────────────────────────────────────────────────── */

/** Run one suite; return `{ failed, names, loadError }`. */
function runSuite(suite) {
  const dir = mkdtempSync(join(tmpdir(), 'atrium-r3-mutants-'));
  const out = join(dir, 'report.json');
  const argv = ['vitest', 'run', '--reporter=json', '--outputFile', out, '--silent'];
  if (suite === 'integration') argv.push('--config', 'vitest.integration.config.ts');
  try {
    const run = spawnSync('npx', argv, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    });
    let report = null;
    try {
      report = JSON.parse(readFileSync(out, 'utf8'));
    } catch {
      return { failed: 0, names: [], loadError: run.status !== 0 };
    }
    const names = [];
    for (const file of report.testResults ?? []) {
      // `mutants/ledger.test.ts` asserts that every entry still matches its
      // source exactly once, so it goes red under EVERY `file` mutation by
      // construction. Counting it would make every mutant look caught whether or
      // not anything tested the rule — the precise vacuity this ledger exists to
      // rule out. Excluded here; its own correctness is `pnpm test`'s business.
      if (String(file.name ?? '').includes(join('mutants', 'ledger.test.ts'))) continue;
      for (const assertion of file.assertionResults ?? []) {
        if (assertion.status === 'failed') names.push(assertion.title ?? assertion.fullName ?? '');
      }
    }
    return {
      failed: names.length,
      names,
      loadError: run.status !== 0 && (report.numFailedTests ?? 0) === 0 && names.length === 0,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ── applying and undoing a mutation ───────────────────────────────────────── */

const originals = new Map();
let sql = null;

function readOnce(file) {
  const path = join(ROOT, file);
  if (!originals.has(path)) originals.set(path, readFileSync(path, 'utf8'));
  return { path, source: originals.get(path) };
}

async function restoreSql(mutant) {
  const statements = (mutant.restoreFrom ?? []).flatMap((marker) => {
    const found = statementsFor(marker);
    if (found.length !== 1) {
      throw new Error(
        `restore marker "${marker}" matched ${found.length} statements in the migration, expected 1`,
      );
    }
    return found;
  });
  for (const statement of mutant.restorePrelude ?? []) await sql.unsafe(statement);
  for (const statement of statements) await sql.unsafe(statement);
}

function restoreFiles() {
  for (const [path, source] of originals) writeFileSync(path, source);
}

let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    interrupted = true;
    restoreFiles();
    process.exit(130);
  });
}

/* ── the run ───────────────────────────────────────────────────────────────── */

const rows = [];
let exitCode = 0;

async function main() {
  if (needsDatabase) sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });

  const suites = [...new Set(mutants.map((m) => m.suite))];
  for (const suite of suites) {
    process.stdout.write(`baseline (${suite})… `);
    const baseline = runSuite(suite);
    if (baseline.failed > 0 || baseline.loadError) {
      console.error(
        `\nthe ${suite} suite is not green before any mutation (${baseline.failed} failing).\n` +
          'Mutant results against a red suite mean nothing; fix the suite first.',
      );
      process.exit(1);
    }
    console.log('green');
  }

  for (const mutant of mutants) {
    if (interrupted) break;
    process.stdout.write(`${mutant.id}… `);

    let result;
    if (mutant.kind === 'sql') {
      try {
        await sql.unsafe(mutant.apply);
      } catch (error) {
        rows.push({
          ...mutant,
          verdict: 'error',
          detail: `the mutation statement failed: ${error.message}`,
          failures: [],
        });
        console.log('ERROR (mutation did not apply)');
        exitCode = 1;
        continue;
      }
      try {
        result = runSuite(mutant.suite);
      } finally {
        await restoreSql(mutant);
      }
    } else {
      const { path, source } = readOnce(mutant.file);
      const occurrences = source.split(mutant.find).length - 1;
      if (occurrences !== 1) {
        rows.push({
          ...mutant,
          verdict: 'error',
          detail: `\`find\` occurs ${occurrences} times in ${mutant.file}, expected exactly 1 — the mutant has drifted out of the code`,
          failures: [],
        });
        console.log(`ERROR (${occurrences} matches)`);
        exitCode = 1;
        continue;
      }
      writeFileSync(path, source.replace(mutant.find, mutant.replace));
      try {
        result = runSuite(mutant.suite);
      } finally {
        writeFileSync(path, source);
      }
    }

    if (result.loadError) {
      rows.push({
        ...mutant,
        verdict: 'caught',
        detail: 'the suite fails to load — the mutation is refused before any test runs',
        failures: [],
      });
      console.log('caught (suite fails to load)');
      continue;
    }

    const missed = (mutant.catches ?? []).filter((name) => !result.names.includes(name));
    if (result.failed === 0) {
      rows.push({ ...mutant, verdict: 'ESCAPED', detail: 'no test failed', failures: [] });
      console.log('ESCAPED');
      exitCode = 1;
    } else if (missed.length > 0) {
      rows.push({
        ...mutant,
        verdict: 'ESCAPED',
        detail: `${result.failed} tests failed, but not the ones claimed: ${missed.map((n) => `"${n}"`).join(', ')}`,
        failures: result.names,
      });
      console.log(`ESCAPED (wrong tests; ${result.failed} failed)`);
      if (verbose) for (const name of result.names) console.log(`    ↳ ${name}`);
      exitCode = 1;
    } else {
      rows.push({
        ...mutant,
        verdict: 'caught',
        detail: `${result.failed} failing`,
        failures: result.names,
      });
      console.log(`caught (${result.failed} failing)`);
      if (verbose) for (const name of result.names) console.log(`    ↳ ${name}`);
    }
  }
}

try {
  await main();
} finally {
  restoreFiles();
  await sql?.end({ timeout: 5 });
}

if (!only && !suiteFilter) {
  const caught = rows.filter((row) => row.verdict === 'caught').length;
  const lines = [
    '# Mutant results — issue #22, realtime layer',
    '',
    '<!-- Generated by `node mutants/run.mjs`. Do not edit by hand. -->',
    '',
    `**${rows.length} run, ${caught} caught.**`,
    '',
    'Each row restores one round-2 behaviour and reports which tests went red.',
    'A `sql` mutant is applied to the live database and undone from the migration',
    'file itself, because migrations are journalled and editing an applied one',
    'changes nothing.',
    '',
    '| mutant | suite | verdict | detail |',
    '| --- | --- | --- | --- |',
    ...rows.map(
      (row) =>
        `| \`${row.id}\` | ${row.suite} | ${row.verdict === 'caught' ? 'caught' : `**${row.verdict}**`} | ${row.detail} |`,
    ),
    '',
    '## What each mutant restores',
    '',
    ...rows.flatMap((row) => [`- **\`${row.id}\`** — ${row.why}`]),
    '',
  ];
  writeFileSync(RESULTS, `${lines.join('\n')}\n`);
  console.log(`\n${rows.length} run, ${caught} caught. Wrote ${RESULTS}.`);
}

process.exit(check ? exitCode : 0);
