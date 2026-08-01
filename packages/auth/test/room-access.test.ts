import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { authorize } from '../src/authz.js';
import { effectiveRoomRole } from '../src/room-access.js';
import {
  analyzeImportBoundary,
  type BoundaryRule,
  describeOffence,
  describeUnmodelled,
  describeUnparsed,
  describeUnresolved,
} from './support/import-boundary.js';

/**
 * The half of room authorization a stub can settle: the role ceiling, and the
 * claim that nothing outside this package still asks the derived table.
 *
 * The other half — that the SQL really refuses a room row whose member row is
 * gone — is not decidable here, because the mechanism is a join and the only
 * honest test of a join is a database. That lives in
 * `apps/web/e2e/room-access.spec.ts`, against real Postgres, calling these same
 * exported functions.
 */

describe('effectiveRoomRole', () => {
  it('denies when the join matched nothing', () => {
    // Catches: `effectiveRoomRole` treating a missing row as anything but a
    // denial — the entire fix rests on "no member row, no authority".
    expect(effectiveRoomRole(undefined)).toBeNull();
    expect(effectiveRoomRole(null)).toBeNull();
  });

  it('passes the role through when both tables agree', () => {
    // The positive control. Without it, `return null` passes every other test
    // in this file — which is exactly the shape a denial-only suite rewards.
    expect(effectiveRoomRole({ role: 'owner', workspaceRole: 'owner' })).toBe('owner');
    expect(effectiveRoomRole({ role: 'admin', workspaceRole: 'admin' })).toBe('admin');
    expect(effectiveRoomRole({ role: 'member', workspaceRole: 'member' })).toBe('member');
  });

  it('caps a stale elevated room role at the committed workspace role', () => {
    /**
     * The demotion whose propagation failed: `syncWorkspaceRoomRoles` timed out
     * on the member lock, so `memberships.role` still says admin while
     * `workspace_members.role` says member.
     *
     * Catches: returning `row.role` instead of the lower of the two — which is
     * what every version of this read did through round 5, and what would let
     * `room.rename` / `room.archive` through for a demoted member.
     */
    expect(effectiveRoomRole({ role: 'admin', workspaceRole: 'member' })).toBe('member');
    expect(effectiveRoomRole({ role: 'owner', workspaceRole: 'member' })).toBe('member');
    expect(effectiveRoomRole({ role: 'owner', workspaceRole: 'admin' })).toBe('admin');
  });

  it('does not raise a room role to meet a higher workspace role', () => {
    // The ceiling is a ceiling, not an assignment. A promotion whose room rows
    // have not been reconciled yet stays at the room role; `afterUpdateMemberRole`
    // is what raises it, after the write it depends on has committed.
    // Catches: replacing `lowerOf` with "prefer the workspace role".
    expect(effectiveRoomRole({ role: 'member', workspaceRole: 'owner' })).toBe('member');
    expect(effectiveRoomRole({ role: 'admin', workspaceRole: 'owner' })).toBe('admin');
  });

  it('denies, and says so, when either role is unreadable', () => {
    /**
     * Both directions, because `lowerOf` returns the *string* it could not
     * parse and the denial depends on `parseRole` then refusing it.
     *
     * Catches: a version that falls back to the readable side, which is the
     * `parseRole(role) ?? 'member'` failure `roomRole` already has a paragraph
     * about — the exact string `authorize()` refuses becomes a working grant.
     */
    const logger = { warn: vi.fn() };
    expect(effectiveRoomRole({ role: 'admin', workspaceRole: 'billing,admin' }, logger)).toBeNull();
    expect(effectiveRoomRole({ role: 'superuser', workspaceRole: 'owner' }, logger)).toBeNull();
    expect(effectiveRoomRole({ role: 'admin', workspaceRole: '' }, logger)).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn.mock.calls[0]?.[1]).toMatchObject({ unknownRole: true });
  });

  it('reads a list of known roles as its strongest member, and still caps', () => {
    /**
     * Recording measured behaviour, because the first draft of the test above
     * asserted the opposite of it.
     *
     * `workspace_members.role` is free text and Better Auth writes multi-role
     * values comma-separated. `parseRole` is strict about *unknown* components
     * — `billing,admin` is null, above — but a list whose every component is a
     * role we know resolves to the strongest one, so `admin,member` is `admin`.
     * That is `parseRole`'s documented contract; `assertKnownRole`'s prose in
     * `org.ts` claims lists are rejected outright and is wrong about this case.
     * Noted rather than changed: tightening it belongs with the code that
     * writes roles, not with the code that reads them.
     *
     * The ceiling is unaffected either way, which is what this asserts.
     */
    expect(effectiveRoomRole({ role: 'admin', workspaceRole: 'admin,member' })).toBe('admin');
    expect(effectiveRoomRole({ role: 'admin', workspaceRole: 'member,owner' })).toBe('admin');
    expect(effectiveRoomRole({ role: 'owner', workspaceRole: 'member,admin' })).toBe('admin');
  });

  it('produces a role `authorize` refuses admin commands for after a demotion', () => {
    /**
     * The ceiling wired to the thing it protects, rather than asserted in
     * isolation. `room.archive` is an admin command; a member may not run it.
     *
     * Catches: any regression in the ceiling that a `toBe('member')` assertion
     * would still pass — this one fails at the decision, which is where it
     * matters.
     */
    const role = effectiveRoomRole({ role: 'admin', workspaceRole: 'member' });
    const decision = authorize('room.archive', role === null ? null : { role }, { scope: 'room' });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe('insufficient_role');

    // …and still allows what a member may do, so the denial above is about the
    // role and not about the command never being allowed.
    expect(
      authorize('message.send', role === null ? null : { role }, { scope: 'room' }).allowed,
    ).toBe(true);
  });
});

/**
 * The apps cannot *import* the room-membership table, and are checked for
 * reaching it off a handle. Two guarantees, and only the first is an invariant.
 *
 * Round 9 splits that sentence because rounds 7 and 8 ran the two halves
 * together and the round-8 delta caught the claim outrunning the analysis. Read
 * `test/support/import-boundary.ts`'s header first; the short version:
 *
 *  - **Import half — an invariant.** No file under `apps/` can reach the
 *    binding through any specifier shape, re-export chain or laundering
 *    wrapper. Resolved to a fixpoint; where it cannot resolve, it reports.
 *  - **Access half — a best-effort check.** It finds `db.query.memberships` and
 *    the shapes around it by tracking the handle syntactically, and four kinds
 *    of shape walk past it. Each has a fixture in "the access half does not see
 *    these, and says so", asserting the miss, so closing one makes those tests
 *    fail and forces the wording to be updated with the code. Round 9 said
 *    *five*, and the round-9 delta found a sixth it had not listed; round 10
 *    re-derived the list from the grammar of an initializer instead of from the
 *    implementation, closed seven, and left the four that need a type checker or
 *    a model of object values.
 *
 * A clean access run means "none of the shapes this check knows about are
 * present" — not "the table is not reached off a handle in this tree".
 *
 * Rounds 2–5 fixed five propagation paths and the class stayed open because the
 * authorization *read* was written out in the two apps. The read now lives in
 * `room-access.ts` alone, where it joins `workspace_members`. This asserts that
 * it stays that way — a fourth query added to a page or a handler is how the
 * join gets forgotten again, and it is an easy thing to do by accident and a
 * hard thing to see in review.
 *
 * **Round 6 asserted this with a regex, and the round-6 gauntlet was right that
 * a regex is not a boundary.** `import * as db`, a subpath, an `await import()`,
 * a re-export, or a helper laundered through another package all walked past it.
 * The check is what keeps the authorization class closed, so being defeatable by
 * import style made it decoration. It is now an AST reachability analysis —
 * `test/support/import-boundary.ts`, whose header states the model — and every
 * evasion above has a fixture below proving it fires.
 *
 * Prose is still not an offence: several files legitimately *discuss*
 * `memberships` in a comment, and a check that fails on a paragraph teaches
 * people to delete paragraphs. Only what a module actually pulls in counts.
 */
describe('room membership is not reachable outside @atrium/auth', () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));

  /** The real rule, in one place, so every assertion below is about *it*. */
  function repoRule(overrides: Partial<BoundaryRule> = {}): BoundaryRule {
    return {
      root,
      declaredIn: 'packages/db/src/schema.ts',
      exportName: 'memberships',
      forbiddenRoots: ['apps'],
      /**
       * Wider than the forbidden root on purpose: a helper laundered through
       * some other package is invisible unless the packages are in the graph.
       *
       * `scripts` is here because round 11's own analysis asked for it —
       * `packages/auth/test/mutation-ledger.test.ts` imports
       * `../../../scripts/mutation-ledger.mjs`, which under round 10 resolved to
       * a file nobody had parsed and was silently treated as taint-free. The
       * graph has to contain what the graph reaches, and the `unresolved`
       * channel is what says so when it does not.
       */
      graphRoots: ['apps', 'packages', 'scripts'],
      /**
       * The vetted holders. This list *is* the invariant, stated positively —
       * three files may name the table, and here is why each one may:
       *
       *  - **`room-access.ts`** is the authorization *read*, the one that joins
       *    `workspace_members`. One file, which is the whole point of round 6.
       *  - **`workspace.ts`** is every *write*, and each one happens inside the
       *    `(workspace, member)` advisory lock this package owns. Splitting read
       *    from write is the arrangement; both being in `@atrium/auth` is what
       *    lets the lock and the join be stated once.
       *  - **`client.ts`** takes `import * as appSchema from './schema.js'`
       *    because that is how drizzle is handed its relational metadata. What
       *    it exports is a database connection — the ambient capability both
       *    apps legitimately hold — not a wrapper around one table.
       *
       * The last two were **found by this check rather than known in advance**:
       * a first draft listed `room-access.ts` alone, on a grep that missed
       * `workspace.ts`'s multi-line import, and the analysis said so by
       * cascading the taint out through `@atrium/auth` into every consumer.
       *
       * `client.ts` is also exactly what `forbiddenAccessName` pays for: a
       * registered schema is what makes `db.query.memberships` exist.
       */
      allowed: [
        'packages/auth/src/room-access.ts',
        'packages/auth/src/workspace.ts',
        'packages/db/src/client.ts',
      ],
      /**
       * Files under `apps/` that may name the table anyway — and the reason
       * round 11 had to invent the field.
       *
       * Round 10 excused these by skipping every directory called `e2e`, which
       * excused `apps/web/app/test/route.ts` — an App Router route — in the same
       * breath. A directory name is not a reason. These three are:
       *
       *  - the two Playwright specs are the suite that *proves* the join against
       *    real Postgres, so they seed and count `memberships` rows on purpose;
       *  - `ensure-database.mjs` migrates and truncates that database before the
       *    suite runs, and takes the whole module to do it.
       *
       * None of them is served to a user: Playwright specs are not in the Next
       * build, and the analysis reports an exemption that matches nothing, so
       * the list cannot rot into a licence for a file that has since moved.
       */
      exempt: [
        'apps/web/e2e/role-sync.spec.ts',
        'apps/web/e2e/room-access.spec.ts',
        'apps/web/e2e/support/ensure-database.mjs',
      ],
      /**
       * The only directories outside the denominator, each an anchored path.
       *
       * Build output, and nothing else. `node_modules` is skipped by name
       * wherever it occurs because it is a resolution boundary Node itself
       * defines; every other exclusion is a full path, so nothing is excused for
       * being *called* `dist` or `test` somewhere in the middle of a route.
       */
      excludedPaths: [
        'apps/web/.next',
        'apps/server/dist',
        'packages/auth/dist',
        'packages/core/dist',
        'packages/db/dist',
        'packages/ingest/dist',
      ],
      forbiddenAccessName: 'memberships',
      ...overrides,
    };
  }

  /**
   * The repository analysis is identical for every assertion that does not
   * override the rule, and it now parses 125 files across two fixpoints — so it
   * is run once and read many times rather than rebuilt per test.
   */
  let repoAnalysisCache: ReturnType<typeof analyzeImportBoundary> | null = null;
  const repoAnalysis = () => {
    repoAnalysisCache ??= analyzeImportBoundary(repoRule());
    return repoAnalysisCache;
  };

  it('finds nothing under apps/ that can reach `memberships`', () => {
    /**
     * Catches: reinstating the round-5 shape in either app, and every evasion of
     * it the fixtures below enumerate. Verified against the round-5 tree, where
     * it names `apps/web/lib/workspaces.ts` and `apps/server/src/index.ts`.
     */
    const { offences } = repoAnalysis();

    expect(
      offences.map(describeOffence),
      'an app can reach room membership directly; the joined read is in @atrium/auth',
    ).toEqual([]);
  });

  it('finds no computed import specifier under apps/', () => {
    /**
     * The one shape the analysis cannot follow: `import(someVariable)`. It is
     * reported rather than skipped, because "we could not tell" must not read as
     * "it was fine". Catches: smuggling the table in behind a computed
     * specifier, which would otherwise be the last remaining syntactic escape.
     */
    const { computed } = repoAnalysis();
    expect(computed).toEqual([]);
  });

  it('finds no app file naming `memberships` as a property either', () => {
    /**
     * The hole the `client.ts` allowlist entry opens, closed. `createDatabase`
     * registers the whole schema with drizzle, so `db.query.memberships` exists
     * on every handle both apps already hold — reachable by property name, with
     * no import anywhere for an import rule to see.
     *
     * Catches: `db.query.memberships.findMany(…)` or `db['query']['memberships']`
     * in a page, a handler or a Server Action — the round-5 read, rewritten in
     * the one syntax the round-6 regex and the import graph both miss.
     */
    const { accesses } = repoAnalysis();
    expect(
      accesses.map((access) => `${access.file}:${access.line} ${access.text}`),
      'an app is reaching room membership off a database handle by name',
    ).toEqual([]);
  });

  describe('the premise, measured', () => {
    /**
     * A boundary check that resolves nothing passes everything. Each of these
     * asserts a piece of machinery the verdict above depends on, because the way
     * this class of guard dies is silently: a wrong root, an exclusion that
     * swallowed the tree, a resolver returning null for the one specifier that
     * matters.
     */
    it('is looking at the right tree', () => {
      const { scanned } = repoAnalysis();
      expect(scanned.length).toBeGreaterThan(10);
      expect(scanned).toContain('apps/web/lib/workspaces.ts');
      expect(scanned).toContain('apps/server/src/index.ts');
      expect(scanned).toContain('packages/auth/src/room-access.ts');
    });

    /**
     * **The denominator, which is the thing round 10 never re-derived.**
     *
     * Every assertion above this one is about what the analysis *found*. These
     * are about what it *looked at*, and they exist because both round-10
     * critics escaped the guard without touching its grammar at all: one dropped
     * a `.js` route the file filter never matched, one used a directory whose
     * name was on a skip list. A checker that scans the wrong set of files
     * passes every test it has and protects nothing.
     */
    it('parses the files a directory-name skip list used to drop', () => {
      /**
       * `apps/web/e2e`, `apps/web/test`, `apps/server/test` and
       * `packages/db/drizzle` were all outside the denominator under round 10,
       * because `DEFAULT_SKIP` matched those *names* anywhere in a path. The
       * same rule dropped `apps/web/app/test/route.ts` — which is the App Router
       * route `/test` — and `apps/web/lib/build/anything.ts`.
       *
       * Catches: reinstating any name-based skip. Each of these is a real file
       * in this repository whose directory carried one of those names.
       */
      const { scanned } = repoAnalysis();
      expect(scanned).toContain('apps/web/e2e/room-access.spec.ts');
      expect(scanned).toContain('apps/web/test/env.test.ts');
      expect(scanned).toContain('apps/server/test/ws-server.test.ts');
      expect(scanned).toContain('packages/auth/test/room-access.test.ts');
    });

    it('parses every module extension Next and Node execute, not only TypeScript', () => {
      /**
       * Finding A's first counterexample. `apps/web/tsconfig.json` sets
       * `allowJs` and includes `**\/*.mjs`; Next serves `route.js` and
       * `page.jsx`. Round 10's filter was `/\.(?:tsx?|mts|cts)$/`, so a planted
       * `apps/web/app/leaky/route.js` reported nothing and `curl` with no cookie
       * got every membership row in the database.
       *
       * Asserted on the two `.mjs` files this repository actually has, so the
       * test is about the real tree rather than about a regex.
       */
      const { scanned } = repoAnalysis();
      expect(scanned).toContain('apps/web/e2e/support/ensure-database.mjs');
      expect(scanned).toContain('apps/web/e2e/support/config.mjs');
      expect(scanned).toContain('scripts/mutation-ledger.mjs');
    });

    it('leaves nothing under a graph root unaccounted for', () => {
      /**
       * The one assertion that would have caught all three counterexamples at
       * once, and the round's organizing rule stated as a test: every file is
       * parsed or named, every specifier resolves or is reported, every
       * expression form is modelled or reported.
       *
       * Catches: a new file type (`.mdx`, `.vue`) landing under `apps/`, a file
       * that stopped parsing, an import nobody can resolve, and an expression
       * form the handle walk has never seen.
       */
      const analysis = repoAnalysis();
      expect(analysis.unparsed.map(describeUnparsed), 'a file nobody parsed').toEqual([]);
      expect(
        analysis.unresolved.map(describeUnresolved),
        'a specifier that resolves to nothing this analysis read',
      ).toEqual([]);
      expect(
        analysis.unmodelled.map(describeUnmodelled),
        'an expression form the handle walk has no model of',
      ).toEqual([]);
    });

    it('excludes only build output, by anchored path, and says which', () => {
      /**
       * The exclusions, read back out of the analysis rather than trusted.
       *
       * Two directions matter. Nothing may leave the denominator except by a
       * rule a human wrote — so every excluded directory is either
       * `node_modules` (a boundary Node defines) or a declared path. And a
       * declared path that exists but was never reached is a rule pointing
       * somewhere the walk does not go, which its author believes is excluded.
       */
      const analysis = repoAnalysis();
      const declared = new Set(repoRule().excludedPaths ?? []);
      for (const path of analysis.excluded) {
        expect(
          path.endsWith('/node_modules') || declared.has(path),
          `${path} left the denominator without a rule saying so`,
        ).toBe(true);
      }
      expect(analysis.unusedExclusions, 'an exclusion that excludes nothing').toEqual([]);
      expect(analysis.unusedExemptions, 'an exemption for a file that has moved').toEqual([]);
    });

    it('resolves the `@/` alias the app actually writes', () => {
      /**
       * The fourth counterexample, and the one that was live: six app modules
       * import through `@/…`, and a specifier that was neither relative nor
       * `@atrium/…` was classified as a third-party package and dropped.
       *
       * The import half survived it — a file under `apps/` that names the table
       * offends wherever its importers live — but the *handle* graph did not:
       * `import { db } from '@/lib/db'` resolved to nothing, so `db()` was not a
       * handle and `db().query.memberships` in a Server Action was reported by
       * nobody. The fixture below proves that; this pins the resolution.
       */
      const { resolveSpecifier } = repoAnalysis();
      expect(resolveSpecifier('@/lib/db', 'apps/web/app/app/actions.ts')).toBe(
        'apps/web/lib/db.ts',
      );
      expect(resolveSpecifier('@/lib/session', 'apps/web/app/app/page.tsx')).toBe(
        'apps/web/lib/session.ts',
      );
    });

    it('resolves the workspace specifiers the apps actually write', () => {
      const { resolveSpecifier } = repoAnalysis();
      expect(resolveSpecifier('@atrium/db', 'apps/web/lib/workspaces.ts')).toBe(
        'packages/db/src/index.ts',
      );
      expect(resolveSpecifier('@atrium/db/schema', 'apps/web/lib/workspaces.ts')).toBe(
        'packages/db/src/schema.ts',
      );
      expect(resolveSpecifier('@atrium/auth', 'apps/server/src/index.ts')).toBe(
        'packages/auth/src/index.ts',
      );
      expect(resolveSpecifier('./room-access.js', 'packages/auth/src/index.ts')).toBe(
        'packages/auth/src/room-access.ts',
      );
      // A real dependency is not this rule's business.
      expect(resolveSpecifier('better-auth', 'packages/auth/src/auth.ts')).toBe(null);
    });

    it('knows that `@atrium/db` exposes the table it is guarding', () => {
      // The vacuity guard. If the seed or the `export *` chain ever stopped
      // propagating, every assertion above would pass by knowing nothing.
      const { exposureOf } = repoAnalysis();
      expect(exposureOf('packages/db/src/schema.ts').names).toContain('memberships');
      expect(exposureOf('packages/db/src/index.ts').names).toContain('memberships');
    });

    it('lets the vetted holders hold the table without tainting @atrium/auth', () => {
      // The allowlist doing its job, and the reason `apps/web/lib/workspaces.ts`
      // may import `listAuthorizedRooms` at all. `index.ts` star-re-exports all
      // three, so it is the assertion that the package's public surface is clean.
      const { exposureOf } = repoAnalysis();
      expect(exposureOf('packages/auth/src/room-access.ts')).toEqual({ names: [], all: false });
      expect(exposureOf('packages/auth/src/workspace.ts')).toEqual({ names: [], all: false });
      expect(exposureOf('packages/auth/src/index.ts')).toEqual({ names: [], all: false });
    });

    it('would fail this very repository if the allowlist were empty', () => {
      /**
       * The strongest premise assertion here. It proves the analysis genuinely
       * reaches from `apps/` through `@atrium/auth` into `room-access.ts` — so
       * the green verdict above is the allowlist's doing and not a broken graph
       * that connects nothing to anything.
       */
      const { offences } = analyzeImportBoundary(repoRule({ allowed: [] }));
      expect(offences.length).toBeGreaterThan(0);
      expect(offences.map((offence) => offence.file)).toContain('apps/web/lib/workspaces.ts');
    });
  });

  /**
   * One fixture per evasion the round-6 regex admitted.
   *
   * Each builds a miniature repository on disk and runs the *same*
   * `analyzeImportBoundary` the verdict above runs — not a re-implementation of
   * it — so a regression in the analysis fails these too. The evading source
   * sits inline next to its expectation, which is the point: a reviewer can read
   * the evasion and the verdict together.
   */
  describe('evasions the round-6 regex admitted', () => {
    const trees: string[] = [];

    afterAll(() => {
      for (const tree of trees) rmSync(tree, { recursive: true, force: true });
    });

    /** A miniature repo: `packages/db` declaring the table, plus whatever else. */
    function fixture(files: Record<string, string>): BoundaryRule {
      const tree = mkdtempSync(join(tmpdir(), 'atrium-boundary-'));
      trees.push(tree);
      const all: Record<string, string> = {
        'packages/db/src/schema.ts': 'export const memberships = { name: "memberships" };\n',
        'packages/db/src/index.ts': "export * from './schema.js';\n",
        ...files,
      };
      for (const [path, source] of Object.entries(all)) {
        const absolute = join(tree, path);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, source);
      }
      return {
        root: tree,
        declaredIn: 'packages/db/src/schema.ts',
        exportName: 'memberships',
        forbiddenRoots: ['apps'],
        graphRoots: ['apps', 'packages'],
        allowed: [],
        forbiddenAccessName: 'memberships',
      };
    }

    /** The offending files a rule reports, deduplicated and sorted. */
    function offenders(rule: BoundaryRule): string[] {
      return [...new Set(analyzeImportBoundary(rule).offences.map((o) => o.file))].sort();
    }

    /**
     * A miniature `@atrium/db` that hands out a handle, as the real one does.
     *
     * The access half is about the table reached off a *connection*, so every
     * fixture for it needs a connection to reach it off. This is the smallest
     * arrangement that is honest about how one exists: `createDatabase` holds the
     * schema (which is why the real `client.ts` is allowlisted) and returns a
     * handle whose `query` carries every registered table.
     */
    const handleFixture: Record<string, string> = {
      'packages/db/src/client.ts':
        "import * as schema from './schema.js';\n" +
        'export function createDatabase() {\n' +
        '  return { query: schema };\n' +
        '}\n',
      'packages/db/src/index.ts': "export * from './schema.js';\nexport * from './client.js';\n",
    };

    /** The access half's verdict for a fixture, with `client.ts` vetted. */
    function accessesOf(rule: BoundaryRule): { file: string; kind: string }[] {
      const { accesses } = analyzeImportBoundary({
        ...rule,
        allowed: ['packages/db/src/client.ts'],
      });
      return accesses.map((access) => ({ file: access.file, kind: access.kind }));
    }

    it('fires on the plain named import — the shape round 6 did catch', () => {
      // The control for the fixture harness itself. If this did not fire, every
      // assertion below would be measuring a mini-repo that resolves nothing.
      const rule = fixture({
        'apps/web/lib/rooms.ts':
          "import { memberships } from '@atrium/db';\nexport const t = memberships;\n",
      });
      expect(offenders(rule)).toEqual(['apps/web/lib/rooms.ts']);
    });

    it('fires on a namespace import', () => {
      // `db.memberships` never appears in an import statement, so the regex saw
      // an import of `@atrium/db` with no braces and passed it.
      const rule = fixture({
        'apps/web/lib/rooms.ts':
          "import * as db from '@atrium/db';\nexport const t = db.memberships;\n",
      });
      expect(offenders(rule)).toEqual(['apps/web/lib/rooms.ts']);
    });

    it('fires on a subpath import', () => {
      // `@atrium/db/schema` is a *declared* export of that package, so this was
      // never exotic — it is one word away from the shape the regex matched.
      const rule = fixture({
        'apps/web/lib/rooms.ts':
          "import { memberships } from '@atrium/db/schema';\nexport const t = memberships;\n",
      });
      expect(offenders(rule)).toEqual(['apps/web/lib/rooms.ts']);
    });

    it('fires on an invented subpath that resolves to nothing', () => {
      // The resolver refuses to treat "I could not find it" as "it is fine";
      // otherwise inventing a subpath would be the cheapest evasion of all.
      const rule = fixture({
        'apps/web/lib/rooms.ts': "import { memberships } from '@atrium/db/no-such-entry';\n",
      });
      expect(offenders(rule)).toEqual(['apps/web/lib/rooms.ts']);
    });

    it('fires on a dynamic import', () => {
      const rule = fixture({
        'apps/web/lib/rooms.ts':
          'export async function load() {\n' +
          "  const { memberships } = await import('@atrium/db');\n" +
          '  return memberships;\n' +
          '}\n',
      });
      expect(offenders(rule)).toEqual(['apps/web/lib/rooms.ts']);
    });

    it('fires on `require`', () => {
      const rule = fixture({
        'apps/web/lib/rooms.ts':
          "const db = require('@atrium/db');\nexport const t = db.memberships;\n",
      });
      expect(offenders(rule)).toEqual(['apps/web/lib/rooms.ts']);
    });

    it('fires on an aliased named import', () => {
      const rule = fixture({
        'apps/web/lib/rooms.ts':
          "import { memberships as m } from '@atrium/db';\nexport const t = m;\n",
      });
      expect(offenders(rule)).toEqual(['apps/web/lib/rooms.ts']);
    });

    it('fires on a type-only import, deliberately', () => {
      /**
       * A type import is erased and cannot run a query, so this is stricter than
       * the threat. It is still the rule: an exemption is a case every reviewer
       * has to hold in their head, and a type-only import of a table object has
       * no use that is not a step towards the value import. Recorded as a test
       * so the strictness is a decision rather than an accident.
       */
      const rule = fixture({
        'apps/web/lib/rooms.ts': "import type { memberships } from '@atrium/db';\n",
      });
      expect(offenders(rule)).toEqual(['apps/web/lib/rooms.ts']);
    });

    it('fires on both ends of a re-export laundered through an app file', () => {
      // The one that made the regex look worst: the consuming file's import
      // statement mentions neither `@atrium/db` nor `memberships`.
      const rule = fixture({
        'apps/web/lib/tables.ts': "export { memberships } from '@atrium/db';\n",
        'apps/web/lib/rooms.ts':
          "import { memberships } from './tables.js';\nexport const t = memberships;\n",
      });
      expect(offenders(rule)).toEqual(['apps/web/lib/rooms.ts', 'apps/web/lib/tables.ts']);
    });

    it('fires on a star re-export through an app file', () => {
      const rule = fixture({
        'apps/web/lib/tables.ts': "export * from '@atrium/db';\n",
        'apps/web/lib/rooms.ts':
          "import { memberships } from './tables.js';\nexport const t = memberships;\n",
      });
      expect(offenders(rule)).toEqual(['apps/web/lib/rooms.ts', 'apps/web/lib/tables.ts']);
    });

    it('fires on a namespace re-export through an app file', () => {
      const rule = fixture({
        'apps/web/lib/tables.ts': "export * as db from '@atrium/db';\n",
        'apps/web/lib/rooms.ts': "import { db } from './tables.js';\nexport const t = db;\n",
      });
      expect(offenders(rule)).toEqual(['apps/web/lib/rooms.ts', 'apps/web/lib/tables.ts']);
    });

    it('fires on an unsafe helper re-exported from another package', () => {
      /**
       * The evasion with no `@atrium/db` and no `memberships` anywhere near the
       * app: a second package queries the table itself and exports a function.
       * This is what rule 2 in the analysis header buys — a module that holds
       * the table taints everything it exports, because a name-only rule cannot
       * see through a wrapper.
       */
      const rule = fixture({
        'packages/legacy/src/index.ts':
          "import { memberships } from '@atrium/db';\n" +
          'export function roomsFor(userId: string) {\n' +
          '  return [memberships, userId];\n' +
          '}\n',
        'apps/web/lib/rooms.ts':
          "import { roomsFor } from '@atrium/legacy';\nexport const t = roomsFor('u');\n",
      });
      // Only the app file is an offender: `packages/` is in the graph so the
      // taint can be *followed* through it, but the rule is about what `apps/`
      // may reach, and the helper's own package is not under judgement.
      expect(offenders(rule)).toEqual(['apps/web/lib/rooms.ts']);
    });

    it('fires through a chain of packages, not just one hop', () => {
      // Reachability, not adjacency: the fixpoint has to carry the taint across
      // as many re-export hops as somebody cares to add.
      const rule = fixture({
        'packages/legacy/src/index.ts': "export { memberships as rows } from '@atrium/db';\n",
        'packages/older/src/index.ts': "export { rows as tbl } from '@atrium/legacy';\n",
        'apps/web/lib/rooms.ts': "import { tbl } from '@atrium/older';\nexport const t = tbl;\n",
      });
      expect(offenders(rule)).toContain('apps/web/lib/rooms.ts');
    });

    it('fires on the table reached off a handle, with no import at all', () => {
      /**
       * The evasion the import graph cannot see, and the reason `client.ts` can
       * be allowlisted honestly. Nothing here imports the table; `createDatabase`
       * registered the schema, so drizzle's relational API has it by name.
       */
      const rule = fixture({
        ...handleFixture,
        'apps/web/lib/rooms.ts':
          "import { createDatabase } from '@atrium/db';\n" +
          'export const t = createDatabase().query.memberships;\n',
      });
      const withClientAllowed = { ...rule, allowed: ['packages/db/src/client.ts'] };

      // The import half is satisfied — `createDatabase` is a vetted export…
      expect(offenders(withClientAllowed)).toEqual([]);
      // …and the access half is what actually catches it.
      const { accesses } = analyzeImportBoundary(withClientAllowed);
      expect(accesses.map((access) => access.file)).toEqual(['apps/web/lib/rooms.ts']);
      expect(accesses[0]?.text).toContain('memberships');
      expect(accesses[0]?.kind).toBe('property');
    });

    it('fires on the same access written as a string index', () => {
      /**
       * `db['query']['memberships']` is the same read with the property name
       * moved into a string, which is where a name-based check usually stops.
       *
       * **Round 7 wrote this against `(globalThis as any).db`**, which was a way
       * of having *some* receiver rather than a claim about which one. That
       * stopped firing when the check became receiver-aware, and the fixture is
       * on a real handle now — which is both the realistic shape and the one
       * that keeps the assertion about the string index rather than about
       * `globalThis`.
       */
      const rule = fixture({
        ...handleFixture,
        'apps/web/lib/rooms.ts':
          "import { createDatabase } from '@atrium/db';\n" +
          "export const t = createDatabase().query['memberships'];\n",
      });
      const { accesses } = analyzeImportBoundary({
        ...rule,
        allowed: ['packages/db/src/client.ts'],
      });
      expect(accesses.map((access) => access.file)).toEqual(['apps/web/lib/rooms.ts']);
      expect(accesses[0]?.kind).toBe('string-index');
    });

    /**
     * The evasions the round-7 AST rewrite admitted, one fixture each.
     *
     * Round 7 replaced a regex with a reachability analysis and measured it: of
     * twelve evasion fixtures, round 6's regex caught two. The round-7 gauntlet
     * then demonstrated two more evasions of the *rewrite* — both against the
     * access half, which only ever looked at property and element access. These
     * are those, plus the shapes around them, measured the same way against the
     * round-7 analysis (`node scripts/mutation-ledger.mjs r7-access-analysis`).
     */
    describe('evasions the round-7 access check admitted', () => {
      it('fires on the table destructured straight off a handle', () => {
        /**
         * The round-7 delta's first example. No forbidden import, no property
         * access, no element access — and `rows` is the table.
         *
         * Catches: an access check that walks `PropertyAccessExpression` and
         * `ElementAccessExpression` and nothing else, which is what
         * `import-boundary.ts:326` did.
         */
        const rule = fixture({
          ...handleFixture,
          'apps/web/lib/rooms.ts':
            "import { createDatabase } from '@atrium/db';\n" +
            'export function load() {\n' +
            '  const { memberships } = createDatabase().query;\n' +
            '  return memberships;\n' +
            '}\n',
        });
        expect(accessesOf(rule)).toEqual([{ file: 'apps/web/lib/rooms.ts', kind: 'destructured' }]);
      });

      it('fires when the destructured table is renamed', () => {
        // Verbatim from the round-7 delta. Renaming is the first thing anybody
        // tries against a check that greps for a name.
        const rule = fixture({
          ...handleFixture,
          'apps/web/lib/rooms.ts':
            "import { createDatabase } from '@atrium/db';\n" +
            'export function load() {\n' +
            '  const { memberships: rows } = createDatabase().query;\n' +
            '  return rows.findMany;\n' +
            '}\n',
        });
        expect(accessesOf(rule)).toEqual([{ file: 'apps/web/lib/rooms.ts', kind: 'destructured' }]);
      });

      it('fires when the destructuring is nested', () => {
        /**
         * `const { query: { memberships } } = db()` never names `query` and
         * `memberships` in the same access, so a check that looked only at the
         * top level of a pattern would miss it. The receiver fact has to travel
         * down the pattern, which is what the recursion is for.
         */
        const rule = fixture({
          ...handleFixture,
          'apps/web/lib/rooms.ts':
            "import { createDatabase } from '@atrium/db';\n" +
            'export function load() {\n' +
            '  const {\n' +
            '    query: { memberships },\n' +
            '  } = createDatabase();\n' +
            '  return memberships;\n' +
            '}\n',
        });
        expect(accessesOf(rule)).toEqual([{ file: 'apps/web/lib/rooms.ts', kind: 'destructured' }]);
      });

      it('fires on a table read off a handle that was destructured first', () => {
        /**
         * The two halves the other way round: destructure `query` off the
         * handle, then reach the table off *that*. It only fires if a name bound
         * by destructuring a handle is itself treated as a handle — which is the
         * difference between following a value and pattern-matching a shape.
         */
        const rule = fixture({
          ...handleFixture,
          'apps/web/lib/rooms.ts':
            "import { createDatabase } from '@atrium/db';\n" +
            'export function load() {\n' +
            '  const { query } = createDatabase();\n' +
            '  return query.memberships;\n' +
            '}\n',
        });
        expect(accessesOf(rule)).toEqual([{ file: 'apps/web/lib/rooms.ts', kind: 'property' }]);
      });

      it('fires on a computed key it cannot resolve', () => {
        /**
         * The round-7 delta's second example: `db().query['member' + 'ships']`.
         * The key is not a literal, so a literal-key check sees nothing.
         *
         * Reported rather than resolved, and deliberately: constant-folding this
         * one would leave `db.query[name]` open, and "we could not tell" must not
         * read as "it was fine" — the same rule the computed-*specifier* half has
         * followed since round 7. It is affordable because it is asked only of a
         * database handle; an app has no reason to index one dynamically.
         */
        const rule = fixture({
          ...handleFixture,
          'apps/web/lib/rooms.ts':
            "import { createDatabase } from '@atrium/db';\n" +
            "export const t = createDatabase().query['member' + 'ships'];\n",
        });
        expect(accessesOf(rule)).toEqual([{ file: 'apps/web/lib/rooms.ts', kind: 'computed-key' }]);
      });

      it('fires on a computed key held in a variable', () => {
        // The same evasion without the concatenation, which is the shape anybody
        // writing it to evade the check would actually use.
        const rule = fixture({
          ...handleFixture,
          'apps/web/lib/rooms.ts':
            "import { createDatabase } from '@atrium/db';\n" +
            "const table = ['member', 'ships'].join('');\n" +
            'export const t = createDatabase().query[table];\n',
        });
        expect(accessesOf(rule)).toEqual([{ file: 'apps/web/lib/rooms.ts', kind: 'computed-key' }]);
      });

      it('fires through a handle the app gets from its own module', () => {
        /**
         * How both apps actually hold a connection: `apps/web/lib/db.ts` exports
         * `function db(): Database`, and every page and action calls it. Nothing
         * in `rooms.ts` mentions `@atrium/db`, so the handle has to be followed
         * *across* the module boundary for this to fire at all.
         *
         * Catches: a receiver check seeded only from direct imports of the
         * declaring package — which would be receiver-aware and useless, because
         * no app file imports it directly.
         */
        const rule = fixture({
          ...handleFixture,
          'apps/web/lib/db.ts':
            "import { createDatabase } from '@atrium/db';\n" +
            'export function db() {\n' +
            '  return createDatabase();\n' +
            '}\n',
          'apps/web/lib/rooms.ts':
            "import { db } from './db.js';\n" + 'export const t = db().query.memberships;\n',
        });
        expect(accessesOf(rule)).toEqual([{ file: 'apps/web/lib/rooms.ts', kind: 'property' }]);
      });

      it('fires through a handle declared only by its type annotation', () => {
        /**
         * `apps/web/lib/db.ts`'s real signature is `export function db():
         * Database` — the body goes through a `globalThis` cache, so there is
         * nothing syntactic to follow, and the annotation is the only statement
         * that this is a connection. It is the author's statement, which is a
         * better signal than any guess, and this is where it is honoured.
         */
        const rule = fixture({
          ...handleFixture,
          'packages/db/src/index.ts':
            "export * from './schema.js';\n" +
            "export * from './client.js';\n" +
            'export type Database = { query: unknown };\n',
          'apps/web/lib/db.ts':
            "import type { Database } from '@atrium/db';\n" +
            'export function db(): Database {\n' +
            '  return (globalThis as { handle?: Database }).handle as Database;\n' +
            '}\n',
          'apps/web/lib/rooms.ts':
            "import { db } from './db.js';\n" +
            'export function load() {\n' +
            '  const { memberships } = db().query;\n' +
            '  return memberships;\n' +
            '}\n',
        });
        expect(accessesOf(rule)).toEqual([{ file: 'apps/web/lib/rooms.ts', kind: 'destructured' }]);
      });

      it('fires on a handle taken as an annotated parameter', () => {
        // The other half of the annotation rule, and the shape every function in
        // `packages/auth` uses: `function f(db: Database)`.
        const rule = fixture({
          ...handleFixture,
          'packages/db/src/index.ts':
            "export * from './schema.js';\n" +
            "export * from './client.js';\n" +
            'export type Database = { query: unknown };\n',
          'apps/web/lib/rooms.ts':
            "import type { Database } from '@atrium/db';\n" +
            'export function load(db: Database) {\n' +
            '  return db.query.memberships;\n' +
            '}\n',
        });
        expect(accessesOf(rule)).toEqual([{ file: 'apps/web/lib/rooms.ts', kind: 'property' }]);
      });
    });

    /**
     * The narrowing the round-7 gauntlet asked for, as tests.
     *
     * Round 7's access check flagged `anything.memberships` anywhere under
     * `apps/` — a response body, a domain object, a React prop. A boundary check
     * that fails on a view model teaches people to rename their fields, and a
     * rule people work around is not a rule. These four are the legitimate code
     * that must keep compiling; without them the widening above would just be a
     * noisier version of the same mistake.
     */
    describe('and the receiver, without which the widening is just noise', () => {
      it('ignores the word on a value that never came from the database', () => {
        const rule = fixture({
          'apps/web/lib/rooms.ts':
            'export async function load() {\n' +
            "  const response = await fetch('/api/workspace');\n" +
            '  const body = (await response.json()) as { memberships: string[] };\n' +
            '  return body.memberships;\n' +
            '}\n',
        });
        expect(accessesOf(rule)).toEqual([]);
      });

      it('ignores a domain object that has a memberships field', () => {
        // The API-shape case: a workspace summary the server already computed,
        // through the vetted reader, with the joined read behind it.
        const rule = fixture({
          'apps/web/lib/rooms.ts':
            'interface Workspace {\n' +
            '  memberships: number;\n' +
            '}\n' +
            'export function count(workspace: Workspace) {\n' +
            '  return workspace.memberships;\n' +
            '}\n',
        });
        expect(accessesOf(rule)).toEqual([]);
      });

      it('ignores a React prop destructured in a parameter', () => {
        const rule = fixture({
          'apps/web/lib/rooms.ts':
            'export function List({ memberships }: { memberships: string[] }) {\n' +
            '  return memberships.length;\n' +
            '}\n',
        });
        expect(accessesOf(rule)).toEqual([]);
      });

      it('ignores a computed key on something that is not a handle', () => {
        /**
         * The control that pays for the conservative computed-key rule. Every
         * `record[key]` in an app would fire if the receiver were not asked
         * about — which is precisely the objection round 7's known-limits
         * section raised against doing this at all.
         */
        const rule = fixture({
          'apps/web/lib/rooms.ts':
            'export function pick(record: Record<string, string>, key: string) {\n' +
            '  return record[key];\n' +
            '}\n',
        });
        expect(accessesOf(rule)).toEqual([]);
      });
    });

    /**
     * **Evasions the round-9 initializer walk admitted — written from the
     * grammar, not from the code.**
     *
     * The round-9 receipt said handles were traced "through variable
     * initializers", and the round-9 delta found a sixth escape past that:
     * `const db = cond ? createDatabase() : createDatabase()`, because
     * `isHandle` had no `ConditionalExpression` case. The five known-limit
     * fixtures below did not cover it, so the *narrowing itself was inaccurate*
     * — which is a worse defect than the gap, because a stated limit is what a
     * reader is entitled to rely on.
     *
     * These fixtures were written the other way round from every previous round:
     * by enumerating what an initializer can *be* in the grammar — every
     * expression form that passes a value through, and every declaration form
     * that carries one — and only then asking the analysis. That found the sixth
     * the delta named and **six more it did not**, in two families the delta's
     * list did not reach:
     *
     *  - *expression forms*: `?:`, `??`, `||`, `&&`, a comma sequence, an
     *    assignment expression;
     *  - *declaration forms*: a parameter **default**, a binding element's own
     *    **default**, a destructuring pattern in **parameter position** (which
     *    `collectAccesses` never looked at, annotated or defaulted);
     *  - and one in the **handle graph**: `export default createDatabase()`,
     *    which `readModule` never recorded, so a one-line package could launder
     *    a connection.
     *
     * All of them are now closed, so this block is positive — each asserts the
     * shape *fires*. The limits that remain are in the block below it, and they
     * are the ones that need a type checker or a model of values rather than
     * more grammar.
     *
     * Catches: `boundary-initializer-walk` in `scripts/mutation-ledger.mjs`,
     * which reverts `isHandle` and the declaration walk to round 9's.
     */
    describe('evasions the round-9 initializer walk admitted', () => {
      /** The shape the round-9 delta named, and the two one-armed versions. */
      it('fires on a handle from a conditional initializer', () => {
        const rule = fixture({
          ...handleFixture,
          'apps/web/lib/rooms.ts':
            "import { createDatabase } from '@atrium/db';\n" +
            'const db = process.env.X ? createDatabase() : createDatabase();\n' +
            'export const t = db.query.memberships;\n',
        });
        expect(accessesOf(rule)).toEqual([{ file: 'apps/web/lib/rooms.ts', kind: 'property' }]);
      });

      it('fires when only one arm of the conditional is a handle', () => {
        // Either arm is enough. A value that is a handle down one path is a
        // handle; the check's job is to notice the path, not to prove it taken.
        const rule = fixture({
          ...handleFixture,
          'apps/web/lib/rooms.ts':
            "import { createDatabase } from '@atrium/db';\n" +
            'declare const fallback: { query: { memberships: unknown } };\n' +
            'const db = process.env.X ? fallback : createDatabase();\n' +
            'export const t = db.query.memberships;\n',
        });
        expect(accessesOf(rule)).toEqual([{ file: 'apps/web/lib/rooms.ts', kind: 'property' }]);
      });

      it('fires on a handle from `??`, `||` and `&&`', () => {
        const rule = fixture({
          ...handleFixture,
          'apps/web/lib/rooms.ts':
            "import { createDatabase } from '@atrium/db';\n" +
            'declare const cached: undefined;\n' +
            'const a = cached ?? createDatabase();\n' +
            'const b = cached || createDatabase();\n' +
            'const c = process.env.X && createDatabase();\n' +
            'export const t = [a.query.memberships, b.query.memberships, c.query.memberships];\n',
        });
        expect(accessesOf(rule)).toEqual([
          { file: 'apps/web/lib/rooms.ts', kind: 'property' },
          { file: 'apps/web/lib/rooms.ts', kind: 'property' },
          { file: 'apps/web/lib/rooms.ts', kind: 'property' },
        ]);
      });

      it('fires on a comma sequence, including the indirect-call idiom', () => {
        /**
         * `(0, createDatabase)()` is the shape a bundler emits and a person
         * writes to defeat a `this` binding. Its value is the right operand, so
         * the call is a call of `createDatabase`.
         */
        const rule = fixture({
          ...handleFixture,
          'apps/web/lib/rooms.ts':
            "import { createDatabase } from '@atrium/db';\n" +
            'const a = (console.log("warming"), createDatabase());\n' +
            'const b = (0, createDatabase)();\n' +
            'export const t = [a.query.memberships, b.query.memberships];\n',
        });
        expect(accessesOf(rule)).toEqual([
          { file: 'apps/web/lib/rooms.ts', kind: 'property' },
          { file: 'apps/web/lib/rooms.ts', kind: 'property' },
        ]);
      });

      it('fires on an assignment expression used as an initializer', () => {
        // `let cached; const db = (cached = createDatabase())`. The *assignment*
        // is still not followed — see the limits below — but the expression's
        // value is, and that is the one written in a single statement.
        const rule = fixture({
          ...handleFixture,
          'apps/web/lib/rooms.ts':
            "import { createDatabase } from '@atrium/db';\n" +
            'let cached: unknown;\n' +
            'const db = (cached = createDatabase());\n' +
            'export const t = db.query.memberships;\n',
        });
        expect(accessesOf(rule)).toEqual([{ file: 'apps/web/lib/rooms.ts', kind: 'property' }]);
      });

      it('fires on a handle that is a parameter default', () => {
        /**
         * **The one the delta's list did not reach, and the cheapest of the
         * lot.** Round 9 read a parameter's *annotation* only, so
         * `function load(db = createDatabase())` needed no annotation and no
         * second statement — an initializer written right there, which is
         * exactly what the header promised to follow.
         */
        const rule = fixture({
          ...handleFixture,
          'apps/web/lib/rooms.ts':
            "import { createDatabase } from '@atrium/db';\n" +
            'export function load(db = createDatabase()) {\n' +
            '  return db.query.memberships;\n' +
            '}\n',
        });
        expect(accessesOf(rule)).toEqual([{ file: 'apps/web/lib/rooms.ts', kind: 'property' }]);
      });

      it('fires on a handle that is a binding element default', () => {
        const rule = fixture({
          ...handleFixture,
          'apps/web/lib/rooms.ts':
            "import { createDatabase } from '@atrium/db';\n" +
            'declare const options: { db?: { query: { memberships: unknown } } };\n' +
            'const { db = createDatabase() } = options;\n' +
            'export const t = db.query.memberships;\n',
        });
        expect(accessesOf(rule)).toEqual([{ file: 'apps/web/lib/rooms.ts', kind: 'property' }]);
      });

      it('fires on the table destructured in a parameter default', () => {
        /**
         * `collectAccesses` asked its destructuring question of variable
         * declarations only, so a binding pattern in parameter position took the
         * table straight off a handle with nothing reported. A pattern is a
         * pattern wherever it is written.
         */
        const rule = fixture({
          ...handleFixture,
          'apps/web/lib/rooms.ts':
            "import { createDatabase } from '@atrium/db';\n" +
            'export function load({ memberships } = createDatabase().query) {\n' +
            '  return memberships;\n' +
            '}\n',
        });
        expect(accessesOf(rule)).toEqual([{ file: 'apps/web/lib/rooms.ts', kind: 'destructured' }]);
      });

      it('fires on the table destructured off an annotated parameter', () => {
        // The same hole reached through the annotation rather than the default,
        // and the shape this repository would actually write.
        const rule = fixture({
          ...handleFixture,
          'packages/db/src/client.ts':
            "import * as schema from './schema.js';\n" +
            'export interface Database {\n' +
            '  query: typeof schema;\n' +
            '}\n' +
            'export function createDatabase(): Database {\n' +
            '  return { query: schema };\n' +
            '}\n',
          'apps/web/lib/rooms.ts':
            "import type { Database } from '@atrium/db';\n" +
            'export function load({ query: { memberships } }: Database) {\n' +
            '  return memberships;\n' +
            '}\n',
        });
        expect(accessesOf(rule)).toEqual([{ file: 'apps/web/lib/rooms.ts', kind: 'destructured' }]);
      });

      it('fires on a conditional used directly as the receiver', () => {
        const rule = fixture({
          ...handleFixture,
          'apps/web/lib/rooms.ts':
            "import { createDatabase } from '@atrium/db';\n" +
            'export const t = (process.env.X ? createDatabase() : createDatabase()).query\n' +
            '  .memberships;\n' +
            'export const { memberships } = (process.env.Y\n' +
            '  ? createDatabase()\n' +
            '  : createDatabase()).query;\n',
        });
        expect(accessesOf(rule)).toEqual([
          { file: 'apps/web/lib/rooms.ts', kind: 'property' },
          { file: 'apps/web/lib/rooms.ts', kind: 'destructured' },
        ]);
      });

      it('fires on a handle laundered through another package as `export default`', () => {
        /**
         * The handle-graph half of the same audit. `readModule` recorded named
         * exports, star re-exports and namespace re-exports — and not
         * `ExportAssignment`, so one line in any package (`export default
         * createDatabase()`) handed every importer a connection the receiver
         * test could not root anything in.
         *
         * The import half was never blind to this file: `@atrium/helper` is a
         * toucher, so rule 2 taints everything it exports. This is the *access*
         * half, and it is the one that has to see the handle to ask about the
         * receiver at all.
         */
        const rule = fixture({
          ...handleFixture,
          'packages/helper/src/index.ts':
            "import { createDatabase } from '@atrium/db';\n" + 'export default createDatabase();\n',
          'apps/web/lib/rooms.ts':
            "import handle from '@atrium/helper';\n" +
            'export const t = handle.query.memberships;\n',
        });
        expect(accessesOf(rule)).toEqual([{ file: 'apps/web/lib/rooms.ts', kind: 'property' }]);
      });

      describe('and the receiver test still holds through every one of them', () => {
        /**
         * The widening's own control block. Every case above makes *more* things
         * count as handles, and the failure mode of that is the round-7 noise
         * the receiver question was introduced to remove: a check that fires on
         * `workspace.memberships` in a view. These assert it did not come back.
         */
        it('ignores a conditional between two things that are not handles', () => {
          const rule = fixture({
            'apps/web/lib/rooms.ts':
              'declare const a: { memberships: string[] };\n' +
              'declare const b: { memberships: string[] };\n' +
              'export const t = (process.env.X ? a : b).memberships;\n',
          });
          expect(accessesOf(rule)).toEqual([]);
        });

        it('ignores `??` and `||` between values that never came from the database', () => {
          const rule = fixture({
            'apps/web/lib/rooms.ts':
              'declare const fromProps: { memberships: string[] } | undefined;\n' +
              'declare const fromServer: { memberships: string[] };\n' +
              'const view = fromProps ?? fromServer;\n' +
              'export const t = view.memberships;\n',
          });
          expect(accessesOf(rule)).toEqual([]);
        });

        it('ignores a computed key on a defaulted parameter that is not a handle', () => {
          // The conservative computed-key rule is affordable only because it is
          // asked of handles. Parameter defaults are now followed, so this is
          // the control for that specific widening.
          const rule = fixture({
            'apps/web/lib/rooms.ts':
              'export function pick(record: Record<string, string> = {}, key = "a") {\n' +
              '  return record[key];\n' +
              '}\n',
          });
          expect(accessesOf(rule)).toEqual([]);
        });

        it('ignores an arithmetic or comparison expression that mentions a handle', () => {
          /**
           * `binaryIsHandle` answers yes only for the operators that pass a
           * value *through*. Without that restriction "any expression mentioning
           * a handle" would be a handle, and `db.query.rooms.length > 0` would
           * make a plain number one.
           */
          const rule = fixture({
            ...handleFixture,
            'apps/web/lib/rooms.ts':
              "import { createDatabase } from '@atrium/db';\n" +
              'const db = createDatabase();\n' +
              'const summary = String(db) + "!";\n' +
              'declare const view: { memberships: string[] };\n' +
              'const same = (summary === "x" ? view : view);\n' +
              'export const t = same.memberships;\n',
          });
          expect(accessesOf(rule)).toEqual([]);
        });
      });
    });

    /**
     * **The access half is a best-effort check. These are the shapes it does not
     * see, asserted rather than described.**
     *
     * The round-8 delta named five escapes past `computeBinding`, and it was
     * right about all five — measured here, one fixture each. Round 9's decision
     * was to *narrow the claim* rather than chase them, and this block is what
     * makes that decision honest instead of a paragraph:
     *
     *  - **A limitation with a test is a limitation somebody measured.** Round 6
     *    accepted a 15-second presence window as a sentence and round 7 wrote
     *    the sentence down; the round-7 delta then showed the window was not a
     *    ceiling at all. The lesson kept from that was that an accepted limit is
     *    a claim, and claims get measured. These are that, for a guarantee
     *    instead of a duration.
     *  - **They fail loudly if a future round closes one.** A fixture asserting
     *    "nothing is reported" goes red the moment the analysis improves, which
     *    forces the header and the ticket to be updated in the same commit. The
     *    alternative is a "known limits" list that quietly stops being true —
     *    the exact anti-staleness failure `RETRO.md` exists to prevent.
     *  - **They double as receiver controls.** A receiver-blind check reports
     *    every one of them, which is part of why `boundary-blind-receiver` and
     *    `r7-access-analysis` fail as widely as their receipts record.
     *
     * **Round 10 changed the answer to "why narrow rather than close".** Round 9
     * argued that closing the closable three would leave the header saying
     * "best-effort" anyway, and the round-9 delta answered it: best-effort is
     * acceptable only when its stated limits are *accurate*, and a sixth escape
     * (`cond ? createDatabase() : createDatabase()`) was not in this list. That
     * is a defect of a different kind from a gap — a reader is entitled to rely
     * on a stated limit — so round 10 audited what an initializer can be from
     * the grammar rather than from the code, found six more, and closed every
     * one of them (see the block above). The claim is unchanged in shape and
     * this list is now the whole of it:
     *
     *  - a handle held in a **class field** or an **object property**;
     *  - a handle **assigned after its declaration**, with no initializer to
     *    read at the declaration site;
     *  - a handle in a **container** — an array element, a `Map` value;
     *  - a handle arriving as an **un-annotated parameter** the caller supplies
     *    (a parameter *default* is now followed; it is an initializer).
     *
     * Each needs something a syntactic pass does not have: a model of object and
     * container values for the first three, a type checker for the last. That is
     * a different sentence from round 9's, which was a cost argument about
     * shapes that were merely more work. **The import half is unaffected and
     * remains an invariant** — it follows every acquisition route for the table
     * itself, to a fixpoint. Two different guarantees, and this round still
     * states them separately.
     */
    describe('the access half does not see these, and says so', () => {
      it('does not see a handle held in a class field', () => {
        /**
         * `computeBinding` handles imported names, variable declarations,
         * parameters, binding elements and function declarations. A
         * `PropertyDeclaration` is none of those, so `this.db` is not a handle
         * and `this.db.query.memberships` is not reported.
         *
         * Reachable in this repository? No file does it today, and nothing stops
         * one. That is what "best-effort" means and why it is written down.
         */
        const rule = fixture({
          ...handleFixture,
          'apps/web/lib/rooms.ts':
            "import { createDatabase } from '@atrium/db';\n" +
            'export class Rooms {\n' +
            '  private readonly db = createDatabase();\n' +
            '  load() {\n' +
            '    return this.db.query.memberships;\n' +
            '  }\n' +
            '}\n',
        });
        expect(accessesOf(rule)).toEqual([]);
      });

      it('does not see a handle held in an object property', () => {
        // `isHandle` on an object literal answers no, so `holder.db` is not a
        // handle however the object was built.
        const rule = fixture({
          ...handleFixture,
          'apps/web/lib/rooms.ts':
            "import { createDatabase } from '@atrium/db';\n" +
            'const holder = { db: createDatabase() };\n' +
            'export const t = holder.db.query.memberships;\n',
        });
        expect(accessesOf(rule)).toEqual([]);
      });

      it('does not see a handle assigned after its declaration', () => {
        /**
         * `computeBinding` reads a `VariableDeclaration`'s *initializer*. A
         * declaration with no initializer, assigned later, has nothing to read —
         * which is why the header's old wording ("traced through assignments")
         * claimed more than the code did. It traces through initializers.
         */
        const rule = fixture({
          ...handleFixture,
          'apps/web/lib/rooms.ts':
            "import { createDatabase } from '@atrium/db';\n" +
            'let handle: ReturnType<typeof createDatabase> | undefined;\n' +
            'export function load() {\n' +
            '  handle = createDatabase();\n' +
            '  return handle.query.memberships;\n' +
            '}\n',
        });
        expect(accessesOf(rule)).toEqual([]);
      });

      it('does not see a handle stored in an array or a Map', () => {
        // A container is a value the analysis would have to model. `pool[0]`
        // resolves to `pool`, whose initializer is an array literal, which is
        // not a handle.
        const rule = fixture({
          ...handleFixture,
          'apps/web/lib/rooms.ts':
            "import { createDatabase } from '@atrium/db';\n" +
            'const pool = [createDatabase()];\n' +
            'export const first = pool[0].query.memberships;\n' +
            "const byName = new Map([['primary', createDatabase()]]);\n" +
            "export const named = byName.get('primary').query.memberships;\n",
        });
        expect(accessesOf(rule)).toEqual([]);
      });

      it('does not see a handle arriving as an unannotated callback parameter', () => {
        /**
         * The one that genuinely needs a type checker. `withDatabase(cb)` passes
         * a handle to `cb`, and `cb`'s parameter has no annotation — so there is
         * nothing syntactic to go on, and guessing would reintroduce exactly the
         * receiver-blind noise round 8 removed.
         *
         * Annotating it (`(db: Database) => …`) puts it back in scope, which is
         * how this repository writes them and is why the gap has not bitten.
         */
        const rule = fixture({
          ...handleFixture,
          'apps/web/lib/rooms.ts':
            "import { createDatabase } from '@atrium/db';\n" +
            'function withDatabase(run: (db: ReturnType<typeof createDatabase>) => unknown) {\n' +
            '  return run(createDatabase());\n' +
            '}\n' +
            'export const t = withDatabase((db) => db.query.memberships);\n',
        });
        expect(accessesOf(rule)).toEqual([]);
      });

      it('still sees the same read when the parameter is annotated', () => {
        /**
         * The control for the whole block, and the reason "best-effort" is not
         * "broken". Every gap above is about *finding* the handle; none of them
         * is the check failing on a handle it has found. Take the previous
         * fixture and write the annotation this repository always writes, and it
         * fires.
         *
         * Catches: any change that makes the annotated-parameter path stop
         * resolving, which would turn the fixtures above from documented limits
         * into a checker that reports nothing at all.
         */
        const rule = fixture({
          ...handleFixture,
          'packages/db/src/client.ts':
            "import * as schema from './schema.js';\n" +
            'export interface Database {\n' +
            '  query: typeof schema;\n' +
            '}\n' +
            'export function createDatabase(): Database {\n' +
            '  return { query: schema };\n' +
            '}\n',
          'apps/web/lib/rooms.ts':
            "import type { Database } from '@atrium/db';\n" +
            'export function load(db: Database) {\n' +
            '  return db.query.memberships;\n' +
            '}\n',
        });
        expect(accessesOf(rule)).toEqual([{ file: 'apps/web/lib/rooms.ts', kind: 'property' }]);
      });
    });

    /**
     * **The denominator — every one of these was green on `fix/auth-r10`.**
     *
     * Both round-10 critics escaped the guard, from different lineages, without
     * touching the expression grammar it had just finished re-deriving. That is
     * the finding: round 10 asked "what can an initializer be?" and never asked
     * "which files are in the graph at all?". Each fixture below is one answer
     * to the second question, and each one is a file the round-10 analysis
     * either never opened or never resolved.
     *
     * They are written as *evasions* rather than as unit tests of the file walk
     * on purpose: the question a reader has is "could somebody do this", and the
     * answer has to be a tree with a leak in it.
     */
    describe('evasions the round-10 denominator admitted', () => {
      /** The evasion, spelled once per module extension Next and Node execute. */
      for (const extension of ['js', 'jsx', 'mjs', 'cjs'] as const) {
        it(`fires on a route written as .${extension}`, () => {
          /**
           * `apps/web/tsconfig.json` sets `allowJs: true` and includes
           * `**\/*.mjs`; Next's App Router serves `route.js` and `page.jsx` as
           * first-class routes. Round 10's file filter was
           * `/\.(?:tsx?|mts|cts)$/`, so the executing critic planted
           * `apps/web/app/leaky/route.js`, got `offences=[]` from the analyzer,
           * then served it with `next dev` and read every room membership in the
           * database out of a request that carried no cookie.
           */
          const rule = fixture({
            [`apps/web/app/leaky/route.${extension}`]:
              "import { memberships } from '@atrium/db';\n" +
              'export async function GET() {\n' +
              '  return Response.json({ leaked: memberships });\n' +
              '}\n',
          });
          expect(offenders(rule)).toEqual([`apps/web/app/leaky/route.${extension}`]);
        });
      }

      it('fires on the table reached off a handle in a .js route', () => {
        // The access half of the same hole: no import of the table at all, which
        // is the shape `next dev` actually served.
        const rule = fixture({
          ...handleFixture,
          'apps/web/lib/db.js':
            "import { createDatabase } from '@atrium/db';\n" +
            'export function db() {\n' +
            '  return createDatabase();\n' +
            '}\n',
          'apps/web/app/leaky/route.js':
            "import { db } from '../../lib/db.js';\n" +
            'export async function GET() {\n' +
            '  return Response.json(await db().query.memberships.findMany());\n' +
            '}\n',
        });
        expect(accessesOf(rule)).toEqual([
          { file: 'apps/web/app/leaky/route.js', kind: 'property' },
        ]);
      });

      /**
       * One case per directory name round 10 dropped *anywhere in a path*.
       *
       * `apps/web/app/test/route.ts` is not a test — it is the route `/test`.
       * `apps/web/lib/build/leak.ts` is not build output. `drizzle` and `e2e`
       * are the same mistake with different words.
       */
      for (const directory of ['test', 'build', 'dist', 'e2e', 'drizzle', 'coverage'] as const) {
        it(`fires on a file under a directory called ${directory}`, () => {
          const rule = fixture({
            [`apps/web/app/${directory}/route.ts`]:
              "import { memberships } from '@atrium/db';\n" +
              'export async function GET() {\n' +
              '  return Response.json({ leaked: memberships });\n' +
              '}\n',
          });
          expect(offenders(rule)).toEqual([`apps/web/app/${directory}/route.ts`]);
        });
      }

      it('reports a specifier that resolves outside the graph instead of trusting it', () => {
        /**
         * Finding A's third counterexample. `graphRoots` is `['apps',
         * 'packages']`, so a re-export through `toolbox/` was never parsed —
         * `taintOf` had no entry for it, `exposesAnything` answered *false*, and
         * the app that imported it was clean. Silently: not reported the way a
         * computed specifier is.
         *
         * The file is now named, with the path it landed on, so the fix is
         * either to widen the graph or to explain the edge.
         */
        const rule = fixture({
          'toolbox/tables.ts': "export { memberships } from '../packages/db/src/schema.js';\n",
          'apps/web/lib/rooms.ts':
            "import { memberships } from '../../../toolbox/tables.js';\n" +
            'export const t = memberships;\n',
        });
        const { unresolved, offences } = analyzeImportBoundary(rule);
        expect(
          unresolved.map((entry) => `${entry.file} ${entry.reason} ${entry.resolved}`),
        ).toEqual(['apps/web/lib/rooms.ts outside-the-graph toolbox/tables.ts']);
        // And with the graph widened to include it, the leak is an ordinary
        // offence — which is what makes the report above actionable rather than
        // decorative.
        // (`toolbox/` itself is not under a forbidden root, so it is not an
        // offender — the point is that the app importing from it becomes one.)
        expect(offenders({ ...rule, graphRoots: ['apps', 'packages', 'toolbox'] })).toEqual([
          'apps/web/lib/rooms.ts',
        ]);
        expect(offences).toEqual([]);
      });

      it('reports a bare specifier nobody declared, rather than assuming npm', () => {
        /**
         * How `@/lib/db` disappeared: anything that was neither relative nor
         * `@atrium/…` was assumed to be a third-party package. A specifier is
         * external now only if it is a Node builtin or is declared in a
         * `package.json` on the way up to the root.
         */
        const rule = fixture({
          'apps/web/lib/rooms.ts':
            "import { rows } from 'not-a-real-package';\nexport const t = rows;\n",
        });
        expect(
          analyzeImportBoundary(rule).unresolved.map(
            (entry) => `${entry.file} ${entry.specifier} ${entry.reason}`,
          ),
        ).toEqual(['apps/web/lib/rooms.ts not-a-real-package undeclared-package']);
      });

      it('follows a `paths` alias into the handle graph', () => {
        /**
         * **The one that was live in this repository.** Six app modules import
         * through `@/…`, `apps/web/lib/db.ts` is where both apps get their
         * connection, and under round 10 `import { db } from '@/lib/db'`
         * resolved to nothing at all — so `db()` was not a handle, and the
         * receiver test that the entire access half rests on had nothing to root
         * itself in.
         *
         * The alias is read from the app's own `tsconfig.json`, because a copy
         * of it in the rule would be a second place to keep in step.
         */
        const rule = fixture({
          ...handleFixture,
          'apps/web/tsconfig.json': JSON.stringify({
            compilerOptions: { paths: { '@/*': ['./*'] } },
          }),
          'apps/web/lib/db.ts':
            "import { createDatabase } from '@atrium/db';\n" +
            'export function db() {\n' +
            '  return createDatabase();\n' +
            '}\n',
          'apps/web/app/app/actions.ts':
            "import { db } from '@/lib/db';\n" +
            'export async function listRooms() {\n' +
            '  return db().query.memberships;\n' +
            '}\n',
        });
        expect(accessesOf(rule)).toEqual([
          { file: 'apps/web/app/app/actions.ts', kind: 'property' },
        ]);
      });

      it('reports a file type nobody has decided about', () => {
        /**
         * The rule that survives the next extension somebody invents. `.mdx` is
         * executable in a Next app; `.vue` is executable somewhere else. Neither
         * is parsed here, and the answer to "we do not know what this is" is a
         * report, not silence.
         */
        const rule = fixture({
          'apps/web/app/page.mdx': '# hello\n',
        });
        const { unparsed } = analyzeImportBoundary(rule);
        expect(unparsed.map((entry) => `${entry.file} ${entry.reason}`)).toEqual([
          'apps/web/app/page.mdx unknown-extension',
        ]);
      });

      it('reports a file that did not parse, which otherwise reads as clean', () => {
        /**
         * A file that fails to parse produces an *empty* walk — no imports, no
         * accesses — which is indistinguishable from a file that has nothing to
         * hide. TypeScript's parser is error-tolerant and hands back a tree
         * either way, so the diagnostics have to be asked for.
         */
        const rule = fixture({
          'apps/web/lib/rooms.ts': "import { memberships } from '@atrium/db'\nfunction (((\n",
        });
        const { unparsed } = analyzeImportBoundary(rule);
        expect(unparsed.map((entry) => entry.file)).toEqual(['apps/web/lib/rooms.ts']);
        expect(unparsed[0]?.reason).toBe('parse-error');
      });

      it('reports an exemption that no longer matches a file', () => {
        // An exemption is a licence with a name on it. When the file moves, the
        // licence has to be re-justified rather than silently covering nothing.
        const rule = fixture({
          'apps/web/lib/rooms.ts': 'export const t = 1;\n',
        });
        const { unusedExemptions } = analyzeImportBoundary({
          ...rule,
          exempt: ['apps/web/e2e/moved-away.spec.ts'],
        });
        expect(unusedExemptions).toEqual(['apps/web/e2e/moved-away.spec.ts']);
      });

      it('exempts a named file without exempting its neighbours', () => {
        /**
         * The replacement for "skip every directory called `e2e`", measured: the
         * named spec may hold the table, and the file beside it may not.
         */
        const rule = fixture({
          'apps/web/e2e/room-access.spec.ts':
            "import { memberships } from '@atrium/db';\nexport const seeded = memberships;\n",
          'apps/web/e2e/sneaky.spec.ts':
            "import { memberships } from '@atrium/db';\nexport const also = memberships;\n",
        });
        expect(offenders({ ...rule, exempt: ['apps/web/e2e/room-access.spec.ts'] })).toEqual([
          'apps/web/e2e/sneaky.spec.ts',
        ]);
      });

      it('reports an exclusion that exists and excludes nothing', () => {
        /**
         * A declared exclusion the walk never reaches is a rule whose author
         * believes a directory is excluded when nothing excludes it. Build
         * output that has not been built yet is *not* that — it is absent, and
         * absent is not stale, which is why the report tests for existence.
         */
        const rule = fixture({
          'apps/web/lib/rooms.ts': 'export const t = 1;\n',
          'packages/db/dist/schema.js': 'export const memberships = {};\n',
        });
        expect(
          analyzeImportBoundary({ ...rule, excludedPaths: ['packages/db/dist'] }).unusedExclusions,
        ).toEqual([]);
        expect(
          analyzeImportBoundary({ ...rule, excludedPaths: ['packages/db/nope'] }).unusedExclusions,
        ).toEqual([]);
        expect(
          // `packages/db/src` exists and is inside the walk, so an exclusion
          // that never fired for it would mean the walk did not go there.
          analyzeImportBoundary({ ...rule, excludedPaths: ['toolbox'] }).unusedExclusions,
        ).toEqual([]);
      });

      it('does not descend into an excluded path, and says it did not', () => {
        const rule = fixture({
          'apps/web/lib/rooms.ts': 'export const t = 1;\n',
          'apps/web/.next/server/leak.js':
            "import { memberships } from '@atrium/db';\nexport const t = memberships;\n",
        });
        // Without the exclusion, generated output is judged like anything else…
        expect(offenders(rule)).toEqual(['apps/web/.next/server/leak.js']);
        // …and with it, the directory is named as excluded rather than absent.
        const excluded = analyzeImportBoundary({ ...rule, excludedPaths: ['apps/web/.next'] });
        expect(excluded.offences).toEqual([]);
        expect(excluded.excluded).toEqual(['apps/web/.next']);
      });
    });

    /**
     * **Evasions of the expression grammar that round 10's own re-derivation
     * missed**, which is the codex critic's finding and one of this round's own.
     *
     * Round 10 claimed at `import-boundary.ts:27` that it had enumerated "every
     * expression form that passes a value through". It had not, and the proof is
     * that `isHandle` ended in `return false` — a fall-through is the shape of a
     * claim that cannot be true, because it answers "not a handle" for every form
     * nobody thought of. There is no fall-through now: pass-through, declared
     * terminal, or reported.
     */
    describe('evasions the round-10 grammar admitted', () => {
      it('fires on a handle laundered through a tagged template', () => {
        /**
         * The codex critic injected exactly this, ran the full suite — **343
         * tests green** — and removed it again. `` tag`ignored` `` is a *call* of
         * `tag`, and round 10 had no `TaggedTemplateExpression` case, so the
         * handle vanished and the "no app file naming `memberships`" assertion
         * passed with the table being read off a connection two lines below it.
         */
        const rule = fixture({
          ...handleFixture,
          'apps/web/lib/rooms.ts':
            "import { createDatabase as getDb } from '@atrium/db';\n" +
            'const tag = () => getDb();\n' +
            'const db = tag`ignored`;\n' +
            'export const rows = db.query.memberships;\n',
        });
        expect(accessesOf(rule)).toEqual([{ file: 'apps/web/lib/rooms.ts', kind: 'property' }]);
      });

      it('fires on a handle taken through `import =` and `export =`', () => {
        /**
         * Two declaration forms outside the four gaps round 10's header
         * enumerated: `ImportEqualsDeclaration` was recorded for the import half
         * and wrote nothing to `handles.imported`, and `ExportAssignment` was
         * skipped outright when `isExportEquals`.
         *
         * Today `tsc` refuses both under `module: ESNext` (TS1202/TS1203), which
         * is a *dependency* this analysis now states rather than a redundancy —
         * a package compiled as CommonJS makes them legal again.
         */
        const rule = fixture({
          ...handleFixture,
          'packages/helper/src/index.ts':
            "import { createDatabase } from '@atrium/db';\n" + 'export = createDatabase();\n',
          'apps/web/lib/rooms.ts':
            "import handle = require('@atrium/helper');\n" +
            'export const t = handle.query.memberships;\n',
        });
        expect(accessesOf(rule)).toEqual([{ file: 'apps/web/lib/rooms.ts', kind: 'property' }]);
      });

      it('reports an expression form it has no model of, and treats it as a handle', () => {
        /**
         * `yield` is the honest example: its value comes from whoever drives the
         * iterator, which no syntactic pass can see. Round 10 would have answered
         * "not a handle" — the same answer it gave a tagged template. The rule
         * now is that an unclassified form is *reported* and answered yes, so the
         * failure reads "this check does not understand your code" rather than
         * "your code is fine".
         */
        const rule = fixture({
          ...handleFixture,
          'apps/web/lib/rooms.ts':
            "import { createDatabase } from '@atrium/db';\n" +
            'export function* load() {\n' +
            '  const db = yield createDatabase();\n' +
            '  return db.query.memberships;\n' +
            '}\n',
        });
        const analysis = analyzeImportBoundary({
          ...rule,
          allowed: ['packages/db/src/client.ts'],
        });
        expect(analysis.unmodelled.map((form) => `${form.file} ${form.kind}`)).toEqual([
          'apps/web/lib/rooms.ts YieldExpression',
        ]);
        expect(analysis.accesses.map((access) => access.kind)).toEqual(['property']);
      });

      it('reports an `import =` of an entity name rather than dropping it', () => {
        // The other half of `import =`: an alias for a namespace member, which
        // has no specifier to resolve and no model here.
        const rule = fixture({
          'apps/web/lib/rooms.ts':
            "import * as atrium from '@atrium/db';\n" +
            'import rows = atrium.memberships;\n' +
            'export const t = rows;\n',
        });
        expect(
          analyzeImportBoundary(rule).unmodelled.map((form) => `${form.file} ${form.kind}`),
        ).toEqual(['apps/web/lib/rooms.ts ImportEqualsDeclaration(entity)']);
      });

      it('keeps every declared terminal quiet, so the report means something', () => {
        /**
         * The control that pays for the no-fall-through rule. If literals,
         * objects, `this`, `new`, unary operators and JSX all reported, the
         * `unmodelled` channel would be noise and nobody would read it — which is
         * how a fail-closed rule dies in practice.
         */
        const rule = fixture({
          ...handleFixture,
          'apps/web/lib/rooms.tsx':
            "import { createDatabase } from '@atrium/db';\n" +
            'export class Holder {\n' +
            '  private readonly db = createDatabase();\n' +
            '  read() {\n' +
            '    return this.db;\n' +
            '  }\n' +
            '}\n' +
            'const literals = [1, "two", `three`, /four/, true, null, {}, []];\n' +
            'const built = new Holder();\n' +
            'const unary = -1 + Number(!literals.length) + (typeof built === "object" ? 1 : 0);\n' +
            'export const meta = import.meta.url;\n' +
            'export const view = <div data-x={unary}>{literals.length}</div>;\n',
        });
        expect(analyzeImportBoundary(rule).unmodelled).toEqual([]);
      });
    });

    it('reports a computed dynamic specifier instead of ignoring it', () => {
      const rule = fixture({
        'apps/web/lib/rooms.ts':
          "const name = '@atrium/' + 'db';\nexport const load = () => import(name);\n",
      });
      const { computed, offences } = analyzeImportBoundary(rule);
      expect(offences).toEqual([]);
      expect(computed.map((entry) => entry.file)).toEqual(['apps/web/lib/rooms.ts']);
    });

    describe('and the controls, without which all of the above is noise', () => {
      it('allows a safe named import from the same tainted package', () => {
        // `@atrium/db` carries the table *and* everything the apps legitimately
        // need. A checker that banned the package would pass every test above
        // and be useless; this is what stops that.
        const rule = fixture({
          'packages/db/src/schema.ts':
            'export const memberships = { name: "memberships" };\n' +
            'export const workspaceMembers = { name: "workspace_members" };\n',
          'apps/web/lib/rooms.ts':
            "import { workspaceMembers } from '@atrium/db';\nexport const t = workspaceMembers;\n",
        });
        expect(offenders(rule)).toEqual([]);
      });

      it('allows an app to import a vetted reader that holds the table', () => {
        // The real shape: `room-access.ts` on the allowlist, re-exported through
        // a package index, consumed by an app. This is the arrangement that has
        // to stay legal, and the second half is the same tree with the allowlist
        // taken away.
        const rule = fixture({
          'packages/auth/src/room-access.ts':
            "import { memberships } from '@atrium/db';\n" +
            'export function listAuthorizedRooms() {\n' +
            '  return memberships;\n' +
            '}\n',
          'packages/auth/src/index.ts': "export * from './room-access.js';\n",
          'apps/web/lib/rooms.ts':
            "import { listAuthorizedRooms } from '@atrium/auth';\n" +
            'export const t = listAuthorizedRooms();\n',
        });
        expect(offenders({ ...rule, allowed: ['packages/auth/src/room-access.ts'] })).toEqual([]);
        // …and without the allowlist entry, the same tree is an offence — so the
        // pass above is the allowlist deciding, not the analysis giving up.
        expect(offenders(rule)).toContain('apps/web/lib/rooms.ts');
      });

      it('ignores a side-effect import, which binds nothing', () => {
        const rule = fixture({
          'apps/web/lib/rooms.ts': "import '@atrium/db';\n",
        });
        expect(offenders(rule)).toEqual([]);
      });

      it('ignores the word in a comment', () => {
        // The rule round 6 got right and this must not lose: prose about
        // `memberships` is how these files explain themselves.
        const rule = fixture({
          'apps/web/lib/rooms.ts':
            '// The joined read against memberships lives in @atrium/auth;\n' +
            '// this file must never import memberships from @atrium/db.\n' +
            "import { createDatabase } from '@atrium/db';\nexport const t = createDatabase;\n",
        });
        expect(offenders(rule)).toEqual([]);
      });
    });
  });
});
