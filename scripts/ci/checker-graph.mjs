/**
 * A checker that checks checkers: who runs each rule, and can its subject
 * disarm its runner?
 *
 * ── THE DEFECT THIS GENERALISES (#40 round 6) ───────────────────────────────
 * `mainGuardProblems` enforced the main-module guard across `scripts/`. It was
 * invoked in exactly one place in the repository: line 1407 of
 * `gate-selftest.mjs` — a file inside `scripts/`, and therefore one of its own
 * subjects. Disarming `gate-selftest.mjs` disarmed the only thing that would
 * have objected to `gate-selftest.mjs` being disarmed. One edit, and the rule
 * stopped existing without anything going red.
 *
 * That is not a fact about the guard. It is a fact about the *shape* of the
 * invocation graph, and it is checkable:
 *
 *   **Every enforcement check must have at least one invoker that is not among
 *   the files it checks, and every declared invoker must be something CI
 *   actually runs.**
 *
 * A check whose invokers are all subjects is a check with a switch on the
 * inside of the door. The property does not make the harness hostile-proof —
 * nothing that runs from the revision under test can be, and ci.yml's SCOPE
 * block says so in four numbered paragraphs — but it turns "one `&&`" into "one
 * `&&` in each of three files, one of which is a Vitest project with a floor
 * that ratchets against origin/main". The cost of the accident is what moved.
 *
 * ── AND WHY THE GRAPH ALONE IS NOT ENOUGH ───────────────────────────────────
 * A blind review of the first version of this file named the two holes in it
 * before its run ended, and both reproduce:
 *
 *  1. **A call that cannot run counted as an invocation.** Put this file's
 *     outside witness's two calls inside `if (false) { … }` and both self-tests
 *     exit 0 — the fix for the critical finding, defeated by four characters,
 *     because the graph was built by finding CallExpressions. `calledNames`
 *     refuses statically dead positions now: a constant-falsy branch, a skipped
 *     or todo test, and the tail of a block after `return`/`throw`/`exit`.
 *  2. **A perfect graph over a gutted check.** `mainGuardProblems` rewritten to
 *     `return []` satisfies every structural rule here. So each row carries a
 *     `violate` fixture and `effectProblems` runs it: the check must report on
 *     an input that violates it, or this goes red no matter how the graph looks.
 *
 * Together those are the campaign's standing synthesis, applied to this file:
 * **provenance is checked by construction, use is checked by mutation.** If
 * flipping the input does not move the output, the machinery is ornament.
 *
 * ── WHAT IT STILL DOES NOT CLAIM ────────────────────────────────────────────
 * Static reachability, not execution. A call in a live test that discards the
 * result, or in a function nothing ever calls, still counts — refusing those
 * needs a call graph, which this is not. The registry is data in this same
 * commit, so someone editing a check can edit its row; the drift test makes that
 * loud rather than impossible, and the README readback makes deleting a row
 * loud too.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, sep } from 'node:path';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import { guardProblems } from './guard-scan.mjs';
import { scanForExpectedFailures } from './scan-expected-failures.mjs';
import { completedCommands } from './shell-command.mjs';
import { checkWorkflowFile, protectedCommandCoverage } from './workflow-policy.mjs';

/** Directories that hold source this repository wrote. */
const SOURCE_ROOTS = ['scripts', 'packages', 'apps'];
const SOURCE_EXTENSIONS = ['.mjs', '.js', '.cjs', '.ts', '.tsx', '.mts'];
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  'playwright-report',
  'test-results',
  'drizzle',
]);
const WORKFLOW_DIRECTORY = '.github/workflows';
const MANIFEST = '.github/ci-manifest.json';
/** This file. Its calls are `violate` probes, not invocations. */
const REGISTRY_FILE = 'scripts/ci/checker-graph.mjs';

/**
 * Every check in this repository that enforces a rule over files, and the
 * complete set of places it is called from.
 *
 * `subjects` is what the check reads — the files that could contain the edit it
 * is supposed to notice. `invokers` is every call site outside the module that
 * defines it. At least one invoker must lie outside every subject prefix, and
 * that is the entire point of the table.
 */
export const ENFORCEMENT = [
  {
    check: 'mainGuardProblems',
    definedIn: 'scripts/ci/guard-scan.mjs',
    subjects: ['scripts/'],
    invokers: [
      'scripts/ci/gate-selftest.mjs',
      'scripts/ci/workflow-policy-selftest.mjs',
      'packages/ci-guard/test/checkers.test.ts',
    ],
    because:
      'the round-5 spelling was enforced only from gate-selftest.mjs, which is one of the files it scans; two `&&` insertions removed 316 assertions with every gate green',
    // The effect probe: the input that must move the output. See
    // `effectProblems` below for why presence is not use.
    violate: () =>
      guardProblems(
        'scripts/ci/probe.mjs',
        "import { isMainModule } from './main-module.mjs';\nif (isMainModule(import.meta.url) && process.env.CI === undefined) {\n  process.exit(main());\n}\n",
      ),
  },
  {
    check: 'checkerGraphProblems',
    definedIn: 'scripts/ci/checker-graph.mjs',
    subjects: ['scripts/'],
    invokers: [
      'scripts/ci/gate-selftest.mjs',
      'scripts/ci/workflow-policy-selftest.mjs',
      'packages/ci-guard/test/checkers.test.ts',
    ],
    because:
      'a check about self-reference that is only invoked by its own subjects would be the joke it is trying to stop',
    violate: () =>
      checkerGraphProblems({
        registry: [
          { ...ENFORCEMENT[0], invokers: ['scripts/ci/gate-selftest.mjs'], violate: null },
        ],
      }),
  },
  {
    check: 'checkWorkflowFile',
    definedIn: 'scripts/ci/workflow-policy.mjs',
    subjects: ['.github/workflows/'],
    invokers: [
      'scripts/ci/workflow-policy-selftest.mjs',
      'packages/ci-guard/test/checkers.test.ts',
    ],
    because:
      'the policy engine reads the workflow; the workflow decides whether the policy engine runs. Neither can be the only witness for the other',
    violate: () =>
      checkWorkflowFile(
        'name: probe\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    continue-on-error: true\n    steps:\n      - run: echo hi\n',
        'probe.yml',
      ),
  },
  {
    check: 'protectedCommandCoverage',
    definedIn: 'scripts/ci/workflow-policy.mjs',
    subjects: ['.github/workflows/'],
    invokers: [
      'scripts/ci/workflow-policy-selftest.mjs',
      'packages/ci-guard/test/checkers.test.ts',
    ],
    because: 'same graph as checkWorkflowFile, and it is the rule with the widest blast radius',
    // The real workflow with the protected set emptied — the mutation the policy
    // self-test runs, borrowed here so this row proves an effect and not a name.
    violate: ({ root, read }) =>
      protectedCommandCoverage(
        parseYaml(String(read(join(root, `${WORKFLOW_DIRECTORY}/ci.yml`), 'utf8')))?.jobs ?? {},
        [],
      ),
  },
  {
    check: 'scanForExpectedFailures',
    definedIn: 'scripts/ci/scan-expected-failures.mjs',
    subjects: ['packages/', 'apps/'],
    invokers: ['scripts/ci/assert-vitest-report.mjs', 'scripts/ci/gate-selftest.mjs'],
    because:
      'its subjects are the test files, and both invokers are outside them — this row is here as the control: it is what a healthy graph looks like',
    violate: () =>
      scanForExpectedFailures(
        ['x.test.ts'],
        () => "import { it } from 'vitest';\nit.fails('a', () => {});\n",
      ).findings,
  },
];

/**
 * Every check must FIRE on an input that violates it.
 *
 * ── WHY PRESENCE IS NOT USE (a blind review of round 6's own fix) ───────────
 * Everything above proves the *graph*: who calls what, and from where. None of
 * it proves the check still does anything. `mainGuardProblems` rewritten to
 * `return []` satisfies every rule in this file — it is defined where the
 * registry says, called from three places, one of them outside its subjects,
 * and all three run in CI. The graph is perfect and the rule is gone.
 *
 * That is the campaign's standing synthesis arriving in the machinery built to
 * enforce it: **provenance is checked by construction, use is checked by
 * mutation. If flipping the input does not move the output, the machinery is
 * ornament.** So each row carries a `violate` — an input the check must report
 * on — and this runs it. A gutted check goes red here regardless of how good its
 * invocation graph looks, and that closes from the other end what the
 * dead-code analysis in `calledNames` can only close shape by shape.
 */
function effectProblems(registry, context) {
  const problems = [];
  for (const entry of registry) {
    if (entry.violate === null || entry.violate === undefined) {
      problems.push(
        `${entry.check} has no \`violate\` fixture in the registry, so nothing here proves it still does anything. A check rewritten to \`return []\` satisfies every other rule in this file: defined where the registry says, called from three places, one of them outside its subjects, all of them run by CI — a perfect graph over a rule that is gone.`,
      );
      continue;
    }
    let reported;
    try {
      reported = entry.violate(context);
    } catch (error) {
      problems.push(`${entry.check}'s \`violate\` fixture threw: ${error.message}`);
      continue;
    }
    if (!Array.isArray(reported) || reported.length === 0) {
      problems.push(
        `${entry.check} reported nothing about an input that violates it. Presence is not use: the invocation graph can be perfect over a check that has been gutted to \`return []\`, and this is the only thing here that would notice.`,
      );
    }
  }
  return problems;
}

const toPosix = (path) => path.split(sep).join(posix.sep);

/** Every source file under the roots, repo-relative and POSIX-spelled. */
export function sourceFiles(root = process.cwd(), list = readdirSync) {
  const found = [];
  const walk = (relative) => {
    let entries;
    try {
      entries = list(join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const next = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(next);
        continue;
      }
      if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) found.push(next);
    }
  };
  for (const rootDirectory of SOURCE_ROOTS) walk(rootDirectory);
  return found.map(toPosix);
}

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  return /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

/**
 * The names this file *calls*, as a set.
 *
 * A call, not a mention: the round-5 lesson one level up. `import {
 * mainGuardProblems }` without a call site, a name in a comment, and the string
 * `'mainGuardProblems'` in a message all read as absent, because the question is
 * "does this file run the check", and only a call does.
 */
export function calledNames(path, source) {
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, true, scriptKind(path));
  const names = new Set();
  const visit = (node, dead) => {
    if (ts.isCallExpression(node) && !dead) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) names.add(callee.text);
      else if (ts.isPropertyAccessExpression(callee)) names.add(callee.name.text);
    }
    node.forEachChild((child) => visit(child, dead || entersDeadCode(node, child)));
  };
  parsed.forEachChild((child) => visit(child, false));
  return names;
}

/**
 * Stepping from `parent` into `child` enters code that cannot run.
 *
 * ── THE DEFECT (found by a blind review of round 6's own fix) ───────────────
 * A second lineage named it before it finished its run: "the checker graph
 * counts syntactic calls even when they are under a dead branch." Measured, and
 * it defeats the fix for the critical finding outright — put the outside
 * witness's two calls inside `if (false) { … }`:
 *
 *     node scripts/ci/gate-selftest.mjs            exit 0
 *     node scripts/ci/workflow-policy-selftest.mjs exit 0
 *
 * The graph proved "`mainGuardProblems` has an invoker that is not one of its
 * subjects" by finding a CallExpression. **An invoker that cannot execute is not
 * an invoker**, and a proof of presence is not a proof of use — which is this
 * campaign's standing lesson arriving in the machinery built to enforce it.
 *
 * Full reachability needs a control-flow graph and is not what this is. These
 * are the shapes that make a call statically unreachable, and each one is
 * refused by construction: a constant-falsy branch, a skipped or todo test, and
 * the tail of a block after `return`/`throw`. Anything subtler is out of scope
 * and stated as such — but the *effect probe* below closes the general case from
 * the other end, by requiring each check to actually fire on a violating input.
 */
function entersDeadCode(parent, child) {
  if (ts.isIfStatement(parent)) {
    const value = constantTruthiness(parent.expression);
    if (value === false && child === parent.thenStatement) return true;
    if (value === true && child === parent.elseStatement) return true;
    return false;
  }
  if (ts.isConditionalExpression(parent)) {
    const value = constantTruthiness(parent.condition);
    if (value === false && child === parent.whenTrue) return true;
    if (value === true && child === parent.whenFalse) return true;
    return false;
  }
  // `it.skip('…', () => { … })` and `it.todo(…)` never run their callback.
  if (ts.isCallExpression(parent) && isSkippedTest(parent.expression)) {
    return parent.arguments.includes(child);
  }
  // Everything after a `return`/`throw`/`process.exit()` in the same block.
  if (ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isCaseClause(parent)) {
    const statements = parent.statements;
    const index = statements.indexOf(child);
    if (index <= 0) return false;
    return statements.slice(0, index).some((earlier) => terminates(earlier));
  }
  return false;
}

const SKIPPED = new Set(['skip', 'todo', 'skipIf', 'runIf', 'fails']);
const RUNNERS = new Set(['it', 'test', 'describe', 'suite', 'bench']);

function isSkippedTest(callee) {
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (!SKIPPED.has(callee.name.text)) return false;
  const root = ts.isIdentifier(callee.expression)
    ? callee.expression.text
    : ts.isPropertyAccessExpression(callee.expression)
      ? callee.expression.expression.getText?.()
      : undefined;
  return typeof root === 'string' && RUNNERS.has(root.split('.')[0] ?? '');
}

function terminates(statement) {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  if (!ts.isExpressionStatement(statement)) return false;
  const call = statement.expression;
  return (
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === 'process' &&
    call.expression.name.text === 'exit'
  );
}

/** `true`/`false` when an expression is a compile-time constant, else undefined. */
function constantTruthiness(expression) {
  const node = ts.isParenthesizedExpression(expression) ? expression.expression : expression;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.NullKeyword) return false;
  if (ts.isIdentifier(node) && node.text === 'undefined') return false;
  if (ts.isNumericLiteral(node)) return node.text !== '0';
  if (ts.isStringLiteralLike(node)) return node.text !== '';
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = constantTruthiness(node.operand);
    return inner === undefined ? undefined : !inner;
  }
  return undefined;
}

/**
 * Every step's `run:` script in every workflow file.
 *
 * Parsed, not scanned. The first draft of this read the raw text and, to catch
 * block scalars without re-implementing YAML indentation, threw the whole file
 * in as an extra haystack — which makes a *comment* that quotes a command read
 * as a step that runs it. That is the round-4 `echo`-the-fetch defect and the
 * round-6 fixture-literal defect wearing a third hat, written by the same hand
 * that had just fixed both. Two parsers are already in this repository. Use
 * them: `yaml` for the document, `shell-command.mjs` for the script.
 *
 * `.yaml` as well as `.yml`, for the same reason the policy engine now
 * enumerates the directory.
 */
export function workflowRunScripts(root = process.cwd(), read = readFileSync, list = readdirSync) {
  const scripts = [];
  let entries;
  try {
    entries = list(join(root, WORKFLOW_DIRECTORY), { withFileTypes: true });
  } catch {
    return scripts;
  }
  for (const entry of entries) {
    if (!(entry.isFile() || entry.isSymbolicLink()) || !/\.ya?ml$/.test(entry.name)) continue;
    let document;
    try {
      document = parseYaml(String(read(join(root, WORKFLOW_DIRECTORY, entry.name), 'utf8')));
    } catch {
      continue;
    }
    for (const job of Object.values(document?.jobs ?? {})) {
      for (const step of Array.isArray(job?.steps) ? job.steps : []) {
        if (typeof step?.run === 'string') scripts.push(step.run);
      }
    }
  }
  return scripts;
}

/** True when some workflow step runs `path` as a command rather than naming it. */
function runByWorkflow(path, scripts) {
  for (const script of scripts) {
    let commands;
    try {
      commands = completedCommands(script);
    } catch {
      continue;
    }
    for (const command of commands) {
      if (command.argv.includes(path)) return true;
    }
  }
  return false;
}

/** The workspaces `.github/ci-manifest.json` gives a floor to. */
function enrolledWorkspaces(root, read) {
  try {
    const manifest = JSON.parse(String(read(join(root, MANIFEST), 'utf8')));
    return Object.entries(manifest.vitest?.workspaces ?? {})
      .filter(([, entry]) => typeof entry?.minTests === 'number' && entry.minTests >= 1)
      .map(([workspace]) => `${toPosix(workspace)}/`);
  } catch {
    return [];
  }
}

const isTestFile = (path) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);

/**
 * Every way the invocation graph is not what the registry says it is.
 *
 * @param {object} [options]
 * @param {string} [options.root] repository root
 * @param {typeof ENFORCEMENT} [options.registry] injectable so the self-tests can
 *   feed this a graph with a known hole without editing the real one
 * @param {(path: string, encoding: string) => string} [options.read]
 * @param {typeof readdirSync} [options.list]
 * @returns {string[]} human-readable problems; empty means every check has an
 *   invoker outside its own subjects and CI runs all of them
 */
export function checkerGraphProblems({
  root = process.cwd(),
  registry = ENFORCEMENT,
  read = readFileSync,
  list = readdirSync,
} = {}) {
  const problems = [];
  const files = sourceFiles(root, list);
  const callers = new Map();
  for (const file of files) {
    let names;
    try {
      names = calledNames(file, String(read(join(root, file), 'utf8')));
    } catch (error) {
      problems.push(`${file} could not be read for the invocation graph: ${error.message}`);
      continue;
    }
    callers.set(file, names);
  }

  const runScripts = workflowRunScripts(root, read, list);
  const workspaces = enrolledWorkspaces(root, read);

  for (const entry of registry) {
    const { check, definedIn, subjects, invokers } = entry;
    if (!files.includes(definedIn)) {
      problems.push(
        `${check} is declared as living in ${definedIn}, which is not a source file this scan found. The registry in scripts/ci/checker-graph.mjs and the tree have drifted.`,
      );
      continue;
    }

    // --- who actually calls it, excluding the module that defines it ---------
    // And excluding this file: every call here is a `violate` probe, which is a
    // test of the check rather than a use of it. Counting a probe as an invoker
    // would let the registry satisfy itself.
    const found = [...callers]
      .filter(([file, names]) => file !== definedIn && file !== REGISTRY_FILE && names.has(check))
      .map(([file]) => file)
      .sort();
    const declared = [...invokers].sort();
    for (const file of found) {
      if (!declared.includes(file)) {
        problems.push(
          `${file} calls ${check}, which the registry in scripts/ci/checker-graph.mjs does not list as one of its invokers. Add it — the list is how "who runs this check" stays a fact rather than a memory.`,
        );
      }
    }
    for (const file of declared) {
      if (!found.includes(file)) {
        problems.push(
          `the registry says ${file} invokes ${check}, and it does not (any more). ${entry.because}. Restore the call, or explain in the registry why the graph is allowed to be thinner.`,
        );
      }
    }

    // --- the property the whole file exists for ------------------------------
    // An empty `subjects` would make "at least one invoker outside the subjects"
    // trivially true for every row, which is the cheapest way to satisfy this
    // file without satisfying anything it is about. A check that reads nothing
    // is not a check.
    if (!Array.isArray(subjects) || subjects.length === 0) {
      problems.push(
        `${check} is in the registry with no subjects. "At least one invoker outside the files it reads" is satisfied by anything when the set of files it reads is empty — declare what it actually reads, or take the row out.`,
      );
      continue;
    }
    const outside = declared.filter(
      (file) => !subjects.some((prefix) => file.startsWith(toPosix(prefix))),
    );
    if (outside.length === 0) {
      problems.push(
        `every invoker of ${check} (${declared.join(', ') || 'none at all'}) is itself among the files it checks (${subjects.join(', ')}). Sole enforcer, sole exception: an edit to the subject disarms the only thing that would have noticed the edit. Give it a call site outside those paths — packages/ci-guard exists for exactly this.`,
      );
    }

    // --- and CI has to run them ----------------------------------------------
    for (const file of declared) {
      if (runByWorkflow(file, runScripts)) continue;
      const workspace = workspaces.find((prefix) => file.startsWith(prefix));
      if (workspace !== undefined && isTestFile(file)) continue;
      problems.push(
        `nothing in ${WORKFLOW_DIRECTORY} runs ${file}, and it is not a test file in a workspace enrolled in ${MANIFEST}. It is listed as an invoker of ${check}, so if CI never reaches it the check has one fewer witness than the registry claims.`,
      );
    }
  }
  // And the half none of the above can reach: does each check still *do*
  // anything? A perfect graph over a gutted rule is the failure this whole file
  // is about, one level up.
  problems.push(...effectProblems(registry, { root, read }));
  return problems;
}
