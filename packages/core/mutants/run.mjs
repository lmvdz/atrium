#!/usr/bin/env node
/**
 * The mutant runner for @atrium/core.
 *
 * Standing campaign rule, routed out of #21's round-2 gauntlet: **a mutation
 * claim ships with a committed, re-runnable mutant list and its results, or it
 * is not evidence.** Round 2's write-up claimed "25 run, 25 caught" and left
 * nothing in the repo a reviewer could execute. This is that thing.
 *
 *   node packages/core/mutants/run.mjs              # run all, rewrite RESULTS.md
 *   node packages/core/mutants/run.mjs --check      # …and exit 1 if any survives
 *   node packages/core/mutants/run.mjs --only <id>  # one mutant, no RESULTS.md
 *   node packages/core/mutants/run.mjs --verbose    # ...and list the failing tests
 *
 * How it works, and the three ways it can lie:
 *
 *  1. **A mutant that no longer applies.** Each `find` must occur exactly once in
 *     its file. Zero occurrences means the code moved and the mutant has been
 *     testing nothing; more than one means the substitution is ambiguous. Both
 *     are reported as `error` and both fail `--check`. A ledger's real failure
 *     mode is drifting into irrelevance while still printing a full column of
 *     ticks, and this is the guard against it.
 *  2. **A mutant caught by the wrong test.** `catches` names the tests that must
 *     go red, and the runner asserts every one of them actually did. A mutant
 *     that only trips some unrelated assertion is recorded as an escape, because
 *     the claim being made is "this test pins this rule", not "something,
 *     somewhere, noticed".
 *  3. **A mutant credited with nothing having fired.** r3's gauntlet: a suite
 *     that fails to *load* was recorded as `caught`, so a mutation that broke the
 *     parse earned a tick with no test naming it — and `RESULTS.md` kept no
 *     failing-test names, so the claim could not be audited from the artifact
 *     either. **A catch now requires a named failing test.** A load failure is
 *     its own verdict, `unpinned`, it is not counted as caught, and it fails
 *     `--check`: a mutation nothing can name is a mutation nothing pins, whatever
 *     the compiler thinks of it. Every failing test name is written into
 *     `RESULTS.md`, so the ledger is auditable without rerunning it.
 *
 * Sources are restored in a `finally` and on SIGINT/SIGTERM. If the process is
 * killed hard, `git diff packages/core/src` shows what is left over.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const LEDGER = join(HERE, 'mutants.json');
const RESULTS = join(HERE, 'RESULTS.md');

const args = process.argv.slice(2);
const check = args.includes('--check');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
/** Print the names of every failing test, which is how you write a `catches` list. */
const verbose = args.includes('--verbose');

const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
const mutants = only ? ledger.mutants.filter((m) => m.id === only) : ledger.mutants;
if (mutants.length === 0) {
  console.error(only ? `no mutant with id "${only}"` : 'ledger is empty');
  process.exit(1);
}

/** Original contents of every file we touch, so a crash can be undone. */
const originals = new Map();

function readOnce(file) {
  const path = join(PKG, file);
  if (!originals.has(path)) originals.set(path, readFileSync(path, 'utf8'));
  return { path, source: originals.get(path) };
}

function restoreAll() {
  for (const [path, source] of originals) writeFileSync(path, source);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    restoreAll();
    process.exit(130);
  });
}

/** Run the package suite; return `{ failed, names, loadError }`. */
function runSuite() {
  const dir = mkdtempSync(join(tmpdir(), 'atrium-mutants-'));
  const out = join(dir, 'report.json');
  try {
    const run = spawnSync(
      'npx',
      ['vitest', 'run', '--reporter=json', '--outputFile', out, '--silent'],
      { cwd: PKG, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let report = null;
    try {
      report = JSON.parse(readFileSync(out, 'utf8'));
    } catch {
      // No report at all: the suite did not get far enough to write one.
      return { failed: 0, names: [], loadError: run.status !== 0 };
    }
    const names = [];
    for (const file of report.testResults ?? []) {
      // `test/mutants.test.ts` asserts that every ledger entry still matches its
      // source exactly once, so it goes red under EVERY mutation by
      // construction. Counting it would make every mutant look caught whether or
      // not anything tested the rule — the precise vacuity this ledger exists to
      // rule out. It is excluded here and its own correctness is the ordinary
      // suite's business.
      if (String(file.name ?? '').endsWith('mutants.test.ts')) continue;
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

const rows = [];
let exitCode = 0;

try {
  process.stdout.write('baseline… ');
  const baseline = runSuite();
  if (baseline.failed > 0 || baseline.loadError) {
    console.error(
      `\nthe suite is not green before any mutation (${baseline.failed} failing). ` +
        'Mutant results against a red suite mean nothing; fix the suite first.',
    );
    process.exit(1);
  }
  console.log('green');

  for (const mutant of mutants) {
    process.stdout.write(`${mutant.id}… `);
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
    let result;
    try {
      result = runSuite();
    } finally {
      writeFileSync(path, source);
    }

    if (result.loadError) {
      // Not a catch. The suite never ran, so no test named this rule, and a
      // ledger row whose evidence is "nothing happened, loudly" is the vacuity
      // this file exists to rule out. Fix the mutant so it compiles, or accept
      // that the rule is unpinned.
      rows.push({
        ...mutant,
        verdict: 'unpinned',
        detail:
          'the suite failed to load, so no named test failed — a mutation nothing can name is a mutation nothing pins',
        failures: [],
      });
      console.log('UNPINNED (suite failed to load; no named test)');
      exitCode = 1;
      continue;
    }

    const claimed = mutant.catches ?? [];
    if (claimed.length === 0) {
      rows.push({
        ...mutant,
        verdict: 'error',
        detail: '`catches` is empty — a mutant with no named catcher makes no auditable claim',
        failures: result.names,
      });
      console.log('ERROR (no named catcher)');
      exitCode = 1;
      continue;
    }

    const missed = claimed.filter((name) => !result.names.includes(name));
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
      if (verbose) for (const name of result.names) console.log(`    \u21b3 ${name}`);
    }
  }
} finally {
  restoreAll();
}

if (!only) {
  const caught = rows.filter((row) => row.verdict === 'caught').length;
  const lines = [
    '# Mutant ledger results — `@atrium/core`',
    '',
    'Generated by `node packages/core/mutants/run.mjs`. Do not edit by hand: rerun it.',
    '',
    `**${caught} of ${rows.length} caught.**`,
    '',
    'Each row applies one verbatim substitution to one source file, runs the whole',
    '`@atrium/core` suite, and restores the file. A mutant is *caught* only when the',
    'tests the ledger names for it actually fail — a mutation that trips something',
    'else is recorded as an escape, because the claim being made is that a specific',
    'test pins a specific rule.',
    '',
    '**A suite that fails to load is not a catch.** It is recorded as `unpinned` and',
    'fails `--check`: no test ran, so no test named the rule, and a row whose whole',
    'evidence is that nothing happened is the vacuity this ledger exists to rule out.',
    'Every failing test name is listed below its mutant, so a reader can audit the',
    'claim from this file without rerunning anything.',
    '',
    '| mutant | file | verdict | detail |',
    '| --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    lines.push(
      `| \`${row.id}\` | \`${row.file}\` | ${row.verdict === 'caught' ? 'caught' : `**${row.verdict}**`} | ${row.detail} |`,
    );
  }
  lines.push('', '## What each mutant is for, and what actually went red', '');
  for (const row of rows) {
    lines.push(`- **\`${row.id}\`** — ${row.why}`);
    if ((row.catches ?? []).length > 0) {
      lines.push(`  - claimed catcher(s): ${row.catches.map((name) => `_${name}_`).join('; ')}`);
    }
    // The names, not the count. r3's gauntlet: `RESULTS.md` recorded "27
    // failing" and nothing a reviewer could check, so the claim was unauditable
    // from the artifact even when it was true.
    if ((row.failures ?? []).length > 0) {
      const unique = [...new Set(row.failures)].sort();
      lines.push(`  - failing tests (${unique.length}):`);
      for (const name of unique) lines.push(`    - _${name}_`);
    } else if (row.verdict === 'caught') {
      lines.push('  - failing tests: **none recorded — this row is not auditable**');
    }
  }
  lines.push('');
  writeFileSync(RESULTS, lines.join('\n'));
  console.log(`\n${caught}/${rows.length} caught — wrote ${RESULTS}`);
}

if (check && exitCode !== 0) {
  console.error('\nat least one mutant survived or has drifted; see the output above');
}
process.exit(check ? exitCode : 0);
