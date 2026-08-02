import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The mutant ledger, checked for drift by the ordinary test run.
 *
 * `packages/core/mutants/run.mjs` is the evidence — it applies each mutation,
 * runs the suite, and records what went red. It takes about a minute, so nobody
 * runs it on every commit, and that is exactly how a ledger rots: a refactor
 * moves a line, the mutant's `find` stops matching, and the artifact goes on
 * claiming coverage of a rule it can no longer reach.
 *
 * So the cheap half runs here, in the suite everybody runs. It does not execute
 * anything — it asserts that every mutation still *applies*: one file that
 * exists, one substring that occurs exactly once, and a replacement that would
 * actually change the file. A mutant that has drifted out of the code fails in
 * `pnpm test`, next to the code that moved.
 *
 * The expensive half — does the mutation get caught, and by the tests the ledger
 * names — is `run.mjs --check`, and its output is committed at
 * `mutants/RESULTS.md`.
 */

const MUTANTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'mutants');
const PKG = join(MUTANTS, '..');

interface Mutant {
  id: string;
  why: string;
  file: string;
  find: string;
  replace: string;
  catches?: string[];
}

const ledger: { mutants: Mutant[] } = JSON.parse(
  readFileSync(join(MUTANTS, 'mutants.json'), 'utf8'),
);

/** Every `it(...)` title in the suite, so `catches` can be checked for typos. */
function testTitles(): Set<string> {
  const titles = new Set<string>();
  const dir = join(PKG, 'test');
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.test.ts')) continue;
    const source = readFileSync(join(dir, entry), 'utf8');
    for (const match of source.matchAll(/\bit\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gs)) {
      const raw = match[2];
      if (raw !== undefined && !raw.includes('${')) titles.add(raw.replace(/\\(['"`])/g, '$1'));
    }
  }
  return titles;
}

describe('the mutant ledger still applies to this code', () => {
  it('has mutants at all, so an empty ledger cannot pass', () => {
    expect(ledger.mutants.length).toBeGreaterThan(30);
  });

  it('gives every mutant a distinct id', () => {
    const ids = ledger.mutants.map((mutant) => mutant.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const mutant of ledger.mutants) {
    it(`\`${mutant.id}\` still matches its source exactly once`, () => {
      const source = readFileSync(join(PKG, mutant.file), 'utf8');
      const occurrences = source.split(mutant.find).length - 1;
      // Not `toBeGreaterThan(0)`: two matches means the substitution is
      // ambiguous and the runner would mutate whichever came first.
      expect(occurrences).toBe(1);
      expect(mutant.replace).not.toBe(mutant.find);
      expect(mutant.why.length).toBeGreaterThan(20);
    });
  }

  it('names only tests that exist', () => {
    // A `catches` entry with a typo in it would make the runner report an escape
    // forever, which reads as a real finding and is not one.
    //
    // Template-titled tests (`it(\`… ${x} …\`)`) are skipped by the scan and so
    // cannot be named in a `catches` list — the table-driven matrices generate
    // hundreds of them, and a ledger entry should point at a test somebody wrote
    // a sentence for anyway.
    const titles = testTitles();
    const missing: string[] = [];
    for (const mutant of ledger.mutants) {
      for (const name of mutant.catches ?? []) {
        if (!titles.has(name)) missing.push(`${mutant.id} → "${name}"`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('claims a catcher for every mutant', () => {
    const uncovered = ledger.mutants
      .filter((mutant) => (mutant.catches ?? []).length === 0)
      .map((mutant) => mutant.id);
    expect(uncovered).toEqual([]);
  });
});
