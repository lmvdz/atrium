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
 * deployed object to an earlier round's behaviour. Migrations are journalled, so
 * editing an applied one changes nothing; the honest way to demonstrate that the
 * boundary is load-bearing is to *remove it from the database that the tests are
 * actually talking to*, and then put it back.
 *
 * Restoring is the part that could lie, so it does not use a copy: the restore
 * statements are extracted from the migration files at run time by their leading
 * marker, and re-executed. If the migration and the restore ever disagreed, the
 * restore would be re-deploying something this repo does not ship — so it
 * re-deploys exactly what the repo ships, or the run fails.
 *
 * A mutant names the migration it restores from (`restoreMigration`), because
 * three migrations now define `atrium_append_core_event` and a bare marker would
 * match all of them. Restoring the append function from 0005 would re-deploy the
 * nine-argument version this round removed — the one that took the receipt window
 * from its caller — as a restore that "worked" and left the database describing
 * the defect. Markers are named down to the function for the same reason: 0006
 * carries a `REVOKE EXECUTE ON FUNCTION` for the append and another for the
 * derivation, and a bare `REVOKE EXECUTE ON FUNCTION` would match both.
 *
 * ## The four ways a ledger like this lies, all closed
 *
 * ("Three" until r6, over a list of four — round 5 added the crash-recovery item
 * and left the heading. A count in a heading that disagrees with the list under
 * it is the cheapest possible version of the defect this file exists to find.)
 *
 *  1. **A mutant that no longer applies.** A `file` mutant's `find` must occur
 *     exactly once; a `sql` mutant's restore markers must each match exactly one
 *     statement in the migration it names. Anything else is reported as `error`
 *     and fails `--check`.
 *  2. **A mutant caught by the wrong test.** `catches` names the tests that must
 *     go red, and every one of them must actually have. A mutant that only trips
 *     something unrelated is recorded as an escape, because the claim is "this
 *     test pins this rule", not "something, somewhere, noticed".
 *  3. **A run that died mid-mutation.** Applying a mutation and undoing it are two
 *     moments, and anything that kills the process between them leaves an earlier
 *     round's behaviour in the working tree. `mutants/.inflight.json` records the
 *     mutation and the file's original bytes for exactly that window; a leftover
 *     record is recovered on the next start and reported. See the note on it.
 *  4. **A mutant measured against a stale build.** #26 r6's lesson, applied
 *     here: `packages/*` are consumed by their *built* `dist` in some suites
 *     (`packages/ingest` and `apps/server` both resolve `@atrium/core` and
 *     `@atrium/db` that way), so mutating a file under `packages/` without
 *     rebuilding measures whatever was on disk. Every mutation of a file under
 *     `packages/` triggers `pnpm --filter "./packages/*" build`, before the
 *     suite and again after the restore. It costs a few seconds per mutant and
 *     it is the difference between a receipt and a claim.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import {
  clearInFlight as clear,
  markInFlight as mark,
  recoverInterruptedRun as recoverInFlight,
} from './inflight.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const LEDGER = join(HERE, 'mutants.json');
const RESULTS = join(HERE, 'RESULTS.md');
const MIGRATIONS = join(ROOT, 'packages/db/drizzle');
/** The migration a `sql` mutant restores from when it does not name one. */
const DEFAULT_RESTORE_MIGRATION = '0007_kind_discriminated_room.sql';

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

const migrationCache = new Map();

function statementsOf(file) {
  if (!migrationCache.has(file)) {
    migrationCache.set(
      file,
      readFileSync(join(MIGRATIONS, file), 'utf8')
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0),
    );
  }
  return migrationCache.get(file);
}

/**
 * A restore marker, resolved to the one file it should be read from.
 *
 * A `restoreFrom` entry may be a bare marker — read from the mutant's
 * `restoreMigration` — or `{ migration, marker }`, which names its own file.
 *
 * The second form exists because of a real split rather than for convenience:
 * the *newest definition* of `atrium_append_core_event` lives in 0008 and the
 * newest definition of `atrium_core_events_invariants` now lives in 0017, and
 * one mutant replaces both. Restoring either from the wrong one re-deploys a
 * superseded definition as a restore that "worked" — the exact failure this
 * whole mechanism exists to prevent, and the one AGENTS.md records as having
 * shipped once already.
 *
 * Per-marker rather than a list of files, because the marker for the invariants
 * trigger matches in BOTH 0008 and 0017: searching a set of files would make it
 * ambiguous, and resolving an ambiguity by taking the first match is how the
 * superseded definition gets deployed in the first place. Each marker names one
 * file and must match exactly one statement in it.
 */
function resolveMarker(mutant, entry) {
  const marker = typeof entry === 'string' ? entry : entry.marker;
  const file =
    typeof entry === 'string'
      ? (mutant.restoreMigration ?? DEFAULT_RESTORE_MIGRATION)
      : entry.migration;
  return { marker, file };
}

/** Every statement in `file` whose first non-comment line starts with `marker`. */
function statementsFor(marker, file) {
  return statementsOf(file).filter((statement) => {
    const body = statement
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .trim();
    return body.startsWith(marker);
  });
}

/**
 * Rebuild the workspace packages.
 *
 * Not optional bookkeeping — see note 3 in the header. A mutation under
 * `packages/` that is not rebuilt is measured against the previous artifact,
 * which is how #26 r6's ledger reported seven passing suites for a mutation the
 * suites never saw.
 */
function rebuildPackages() {
  const run = spawnSync('pnpm', ['--filter', './packages/*', 'build'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  return run.status === 0;
}

const needsRebuild = (mutant) => mutant.kind === 'file' && mutant.file.startsWith('packages/');

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

/**
 * The crash-recovery record — the fourth way a ledger like this lies.
 *
 * The three in the header are about a mutant that no longer applies, one caught
 * by the wrong test, and one measured against a stale build. This is the one that
 * bit during round 5 and is not in that list: **a run that dies between applying
 * a mutation and undoing it leaves the mutation in the working tree**.
 *
 * The mechanism is `mutants/inflight.mjs`, which is its own module for a reason
 * the r5 delta gave: recovery was the one part of this instrument with no
 * instrument of its own, because a script that does its work at import time
 * cannot be unit-tested without running it. It is a pure function there,
 * `mutants/inflight.test.ts` drives all four of its outcomes, and the mutant
 * `inflight_recovery_is_a_no_op` makes that suite go red. The residual window a
 * filesystem record cannot close, and what closes it from the other end, are
 * written down in that module's header.
 */
const INFLIGHT = join(HERE, '.inflight.json');

function recoverInterruptedRun() {
  const verdict = recoverInFlight({ path: INFLIGHT, root: ROOT });
  if (verdict.status === 'clean') return;
  if (verdict.status === 'refuse') {
    console.error(verdict.reason);
    process.exit(1);
  }
  console.error(
    `recovered: a previous run died with "${verdict.id}" applied to ${verdict.file}. The file has\n` +
      'been restored from the record. Rebuilding, then continuing.',
  );
  rebuildPackages();
}

function markInFlight(record) {
  mark(INFLIGHT, record);
}

function clearInFlight() {
  clear(INFLIGHT);
}

function readOnce(file) {
  const path = join(ROOT, file);
  if (!originals.has(path)) originals.set(path, readFileSync(path, 'utf8'));
  return { path, source: originals.get(path) };
}

async function restoreSql(mutant) {
  const statements = (mutant.restoreFrom ?? []).flatMap((entry) => {
    const { marker, file } = resolveMarker(mutant, entry);
    const found = statementsFor(marker, file);
    if (found.length !== 1) {
      throw new Error(
        `restore marker "${marker}" matched ${found.length} statements in ${file}, expected 1`,
      );
    }
    return found;
  });
  for (const statement of mutant.restorePrelude ?? []) await sql.unsafe(statement);
  for (const statement of statements) await sql.unsafe(statement);
}

function restoreFiles() {
  for (const [path, source] of originals) writeFileSync(path, source);
  clearInFlight();
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
  // Before anything else, and before the baseline in particular: a baseline
  // measured over a leftover mutation is a baseline for a tree nobody wrote.
  recoverInterruptedRun();
  if (needsDatabase) sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });

  // The baseline is measured against a freshly built workspace for the same
  // reason each mutant is: a green baseline over a stale `dist` is a green
  // baseline for a tree that is not this one.
  process.stdout.write('building packages… ');
  if (!rebuildPackages()) {
    console.error('\nthe workspace does not build; mutant results against it mean nothing.');
    process.exit(1);
  }
  console.log('ok');

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
      markInFlight({ id: mutant.id, kind: 'sql' });
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
        clearInFlight();
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
      markInFlight({ id: mutant.id, kind: 'file', file: mutant.file, original: source });
      writeFileSync(path, source.replace(mutant.find, mutant.replace));
      let restoredCleanly = true;
      try {
        if (needsRebuild(mutant) && !rebuildPackages()) {
          // A mutation that will not compile is refused before any test runs —
          // real evidence, and evidence of a different kind, so the mutant has to
          // have claimed it. A mutant that names a test and is instead caught by
          // `tsc` is an `error`: the test it claims went unmeasured, and the
          // ledger would otherwise print a tick for a rule nothing ran.
          const claimed = mutant.caughtBy === 'build';
          rows.push({
            ...mutant,
            verdict: claimed ? 'caught' : 'error',
            detail: claimed
              ? 'the workspace build refuses it — a compile-time parity assert, not a test'
              : `the workspace build fails, but this mutant claims tests (${(mutant.catches ?? []).map((n) => `"${n}"`).join(', ')}) — set "caughtBy": "build" if the compiler is the pin, or make the mutation compile so the claim is measured`,
            failures: [],
          });
          console.log(claimed ? 'caught (build refuses it)' : 'ERROR (build fails, tests claimed)');
          if (!claimed) exitCode = 1;
          continue;
        }
        result = runSuite(mutant.suite);
      } finally {
        writeFileSync(path, source);
        clearInFlight();
        // Restored *and* rebuilt, or every mutant after this one is measured
        // against this one's artifact. Recorded rather than thrown: a throw from
        // a `finally` would swallow whatever the `try` was doing, including the
        // interrupt handler's own unwinding.
        if (needsRebuild(mutant) && !rebuildPackages()) restoredCleanly = false;
      }
      if (!restoredCleanly) {
        console.error(
          `\ncould not rebuild the workspace after restoring "${mutant.id}" — every later ` +
            'result would be measured against a mutated artifact. Stopping.',
        );
        process.exit(1);
      }
    }

    if (result.loadError) {
      // Same rule as the build failure above: a mutant caught by the loader
      // rather than by the test it names has not measured that test.
      const claimed = mutant.caughtBy === 'load';
      rows.push({
        ...mutant,
        verdict: claimed ? 'caught' : 'error',
        detail: claimed
          ? 'the suite fails to load — the mutation is refused before any test runs'
          : `the suite fails to load, but this mutant claims tests (${(mutant.catches ?? []).map((n) => `"${n}"`).join(', ')}) — set "caughtBy": "load" if that is the pin`,
        failures: [],
      });
      console.log(claimed ? 'caught (suite fails to load)' : 'ERROR (load fails, tests claimed)');
      if (!claimed) exitCode = 1;
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
      // The recorded number is the count of *claimed* tests confirmed red, not
      // the total that failed (#22 gauntlet r6, nit).
      //
      // The r6 critic re-ran `--check` and got `1 failing` where the committed
      // file said `2 failing` for two entries. Every named catcher still went
      // red, so the verdict was sound — but the number was not reproducible,
      // because the total includes **collateral**: tests that fail for the same
      // reason without being the pin, and whose count moves whenever a suite
      // gains a case, a timing-sensitive test flips, or a mutation happens to
      // wedge something adjacent. A ledger whose whole point is that a claim is
      // measured must not print a number that drifts on a re-run of the same
      // commit.
      //
      // `catches` is what the mutant claims, the runner already requires every
      // one of them to have gone red, and `catches.length` is a property of the
      // committed file. So that is what is recorded. The full failure list is
      // still kept on the row for `--verbose`, where it is diagnostics rather
      // than a receipt.
      const claimed = (mutant.catches ?? []).length;
      rows.push({
        ...mutant,
        verdict: 'caught',
        detail: `${claimed} claimed ${claimed === 1 ? 'test' : 'tests'} red`,
        failures: result.names,
      });
      console.log(`caught (${claimed} claimed red, ${result.failed} failing in total)`);
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
    'Each row restores one earlier round‘s behaviour and reports which tests went red.',
    'A `sql` mutant is applied to the live database and undone from the migration',
    'file it names, because migrations are journalled and editing an applied one',
    'changes nothing.',
    '',
    '**Every artifact the suites consume is rebuilt** — `pnpm --filter "./packages/*"',
    'build` runs before the baseline, and again around any mutation of a file under',
    '`packages/`, because `packages/ingest` and `apps/server` resolve `@atrium/core`',
    'and `@atrium/db` through their built `dist`. A ledger that skips this measures',
    'whatever was on disk (#26 r6).',
    '',
    '**The `detail` column counts the tests each mutant *claimed*, and only those.**',
    'It used to be the total that failed, which is not byte-reproducible: the total',
    'includes collateral — tests that fail for the same reason without being the pin —',
    'and it moves whenever a suite gains a case. The r6 gauntlet re-ran `--check` and',
    'got `1 failing` where this file said `2 failing`; every named catcher had gone',
    'red, so the verdict was sound and only the number drifted. The runner already',
    'requires every claimed test to go red, so "*n* claimed tests red" means *n* named',
    'pins were measured and all *n* fired. `--verbose` prints the full failure list.',
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
