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
 * ── WHAT IT DOES NOT CLAIM ──────────────────────────────────────────────────
 * Reachability, not execution: a declared invoker that CI runs may still call
 * the check and throw the result away. The registry pins the graph, not the
 * semantics. And the registry is data in this same commit — someone editing the
 * check can edit its row. The drift test below is what makes that loud: a
 * removed call site is a failure, because the discovered set and the declared
 * set stop matching.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, sep } from 'node:path';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import { completedCommands } from './shell-command.mjs';

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
  },
  {
    check: 'scanForExpectedFailures',
    definedIn: 'scripts/ci/scan-expected-failures.mjs',
    subjects: ['packages/', 'apps/'],
    invokers: ['scripts/ci/assert-vitest-report.mjs', 'scripts/ci/gate-selftest.mjs'],
    because:
      'its subjects are the test files, and both invokers are outside them — this row is here as the control: it is what a healthy graph looks like',
  },
];

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
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) names.add(callee.text);
      else if (ts.isPropertyAccessExpression(callee)) names.add(callee.name.text);
    }
    node.forEachChild(visit);
  };
  parsed.forEachChild(visit);
  return names;
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
    const found = [...callers]
      .filter(([file, names]) => file !== definedIn && names.has(check))
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
  return problems;
}
