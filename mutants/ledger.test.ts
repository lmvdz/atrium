import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The mutant ledger, checked by the ordinary suite.
 *
 * A ledger like this has one real failure mode, and it is not "a mutant
 * escapes" — that is loud and the runner reports it. It is **drift**: the code a
 * mutant substitutes into moves, the `find` stops matching, and the ledger keeps
 * printing a full column of ticks for substitutions that no longer describe
 * anything. `RESULTS.md` would still say "23 caught" while covering nothing.
 *
 * So the cheap half of the runner's own guard lives here, next to `pnpm test`:
 * a mutant whose `find` has drifted fails the suite in the same commit that
 * moved the code, rather than the next time somebody remembers to run the
 * mutant pass against a database.
 *
 * The other half — that a mutant's `catches` names tests that *exist* — is here
 * for the same reason. The runner asserts those tests went red; it cannot tell
 * a test that stayed green from a test whose name has a typo in it, and both
 * would read as an escape. A name that matches nothing in the repo is a
 * permanent false finding waiting to be argued about.
 *
 * `packages/core/mutants/test/mutants.test.ts` is this file's twin for the core
 * engine, and its lesson is taken: this file goes red under *every* mutation by
 * construction, so the runner excludes it from each mutant's score. Counting it
 * would make every mutant look caught whether or not anything tested the rule —
 * the same vacuity class, one level up.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

interface Mutant {
  id: string;
  suite: 'unit' | 'integration';
  kind: 'file' | 'sql';
  why: string;
  file?: string;
  find?: string;
  replace?: string;
  apply?: string;
  restoreFrom?: string[];
  restorePrelude?: string[];
  catches?: string[];
}

const ledger = JSON.parse(readFileSync(join(HERE, 'mutants.json'), 'utf8')) as {
  mutants: Mutant[];
};

const MIGRATION = join(ROOT, 'packages/db/drizzle/0004_trusted_actor_and_append_boundary.sql');
const migrationStatements = readFileSync(MIGRATION, 'utf8')
  .split('--> statement-breakpoint')
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0)
  .map((statement) =>
    statement
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .trim(),
  );

/** Every test title in the repo, from `it('…')` and `test('…')`. */
function everyTestTitle(): Set<string> {
  const titles = new Set<string>();
  const skip = new Set(['node_modules', '.next', 'dist', '.git', '.claude']);
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!path.endsWith('.test.ts')) continue;
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(/\b(?:it|test)\(\s*(['"`])([\s\S]*?)\1/g)) {
        titles.add(match[2] as string);
      }
    }
  };
  walk(ROOT);
  return titles;
}

describe('the mutant ledger still describes this code', () => {
  it('has mutants at all, in both suites', () => {
    // A ledger that emptied itself would pass every assertion below. Catches:
    // deleting entries, and the more likely accident of a `--suite` filter
    // getting committed into the file.
    expect(ledger.mutants.length).toBeGreaterThanOrEqual(20);
    expect(ledger.mutants.some((m) => m.suite === 'unit')).toBe(true);
    expect(ledger.mutants.some((m) => m.suite === 'integration')).toBe(true);
  });

  it('gives every mutant a unique id', () => {
    const ids = ledger.mutants.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(ledger.mutants.filter((m) => m.kind === 'file'))(
    'finds $id exactly once in its source file',
    (mutant) => {
      const source = readFileSync(join(ROOT, mutant.file as string), 'utf8');
      const occurrences = source.split(mutant.find as string).length - 1;
      // Exactly one. Zero means the code moved and this mutant has been testing
      // nothing; more than one means the substitution is ambiguous and the
      // runner would be mutating whichever occurrence came first.
      expect(occurrences).toBe(1);
    },
  );

  it.each(ledger.mutants.filter((m) => m.kind === 'file'))(
    'makes $id an actual change',
    (mutant) => {
      // A `replace` equal to its `find` is a mutant that mutates nothing and is
      // therefore caught by nothing — an escape that would be reported as one,
      // but only after a full suite run against a database.
      expect(mutant.replace).not.toBe(mutant.find);
    },
  );

  it.each(ledger.mutants.filter((m) => m.kind === 'sql'))(
    'resolves every restore marker of $id to exactly one migration statement',
    (mutant) => {
      // The restore comes from the migration rather than from a copy, so a
      // marker that matches nothing would leave the database mutated for every
      // subsequent test in the run — and one that matches two would re-deploy an
      // ambiguous pair. Either way the *next* mutant's result is meaningless.
      for (const marker of mutant.restoreFrom ?? []) {
        const matched = migrationStatements.filter((statement) => statement.startsWith(marker));
        expect({ marker, matched: matched.length }).toEqual({ marker, matched: 1 });
      }
    },
  );

  it('names only tests that exist', () => {
    const titles = everyTestTitle();
    const missing = ledger.mutants.flatMap((mutant) =>
      (mutant.catches ?? [])
        .filter((name) => !titles.has(name))
        .map((name) => `${mutant.id} → "${name}"`),
    );
    // A typo in a `catches` entry is a permanent false finding: the runner
    // reports the mutant as an escape forever, and the next person spends an
    // afternoon looking for a hole that is a missing apostrophe.
    expect(missing).toEqual([]);
  });

  it('claims at least one test for every mutant', () => {
    // Without this, an entry with an empty `catches` is scored on "did anything
    // fail" — which is the weakest possible claim and exactly the one the
    // `catches` mechanism exists to replace.
    const unclaimed = ledger.mutants.filter((m) => (m.catches ?? []).length === 0).map((m) => m.id);
    expect(unclaimed).toEqual([]);
  });
});
