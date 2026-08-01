/**
 * A second witness for `it.fails()`, read from the source rather than a report.
 *
 * WHY THIS EXISTS. The round-2 receipt promised that expected-failure counts
 * would "reconcile between the dual reports". They cannot, and the reason is
 * worth writing down: Vitest's stock JSON reporter records an `it.fails()` test
 * as `status: "passed"` with an empty `failureMessages` array. Verified against
 * Vitest 4.1.10 on a probe file with one `it.fails`, one `it.skip`, one
 * `it.todo` and one ordinary test — the stock report said 4 tests, 2 passed, 1
 * pending, 1 todo, and nothing anywhere distinguished the expected failure from
 * the real pass. The annotation is gone by the time it reaches that file. So
 * the stock report is not a witness for `fails` at any level of effort, and a
 * cross-check that pretends otherwise is theatre.
 *
 * What the two reports *can* reconcile — every other status, the test count,
 * the file count, and the identity of every individual test — they do, in
 * assert-vitest-report.mjs. That closes the "gutted reporter is a stub" path. It
 * does not close a reporter that walks the run honestly and drops one flag. For
 * that the witness has to come from outside the reporting path entirely, which
 * is this file.
 *
 * ── WHY IT PARSES (round 4) ──────────────────────────────────────────────────
 * Round 3 did this with a line-oriented regex, and the round-3 gauntlet found
 * that it missed `test.each([...]).fails(...)` — a form its own comment claimed
 * to support — because `[\w.]*` cannot step over `([1, 2])`. That is not a
 * regex to be patched; it is the wrong tool. A line matcher cannot see any of:
 *
 *     test.each([[1], [2]]).fails('x', fn)     // a call in the middle of the chain
 *     it['fails']('x', fn)                     // computed member access
 *     it?.fails('x', fn)                       // optional chaining
 *     test\n  .each(rows)\n  .fails('x', fn)   // the chain spread over lines
 *     const broken = it.fails                  // an alias, then broken('x', fn)
 *     const { fails } = it                     // destructured off the runner
 *     export const broken = it.fails           // in a helper the report never names
 *
 * — and it fired on `it('rejects it.fails', …)`, prose inside a string literal,
 * which is a false positive in the same breath.
 *
 * So this reads the TypeScript AST. `.fails` is recognised as a member access
 * however it is spelled, wherever it sits in a chain, across as many lines as it
 * likes; a string that merely contains the text is not an access and does not
 * fire. To keep that precise rather than merely broad, a `.fails` access counts
 * only when the *root* of its chain is a test-runner binding: one of Vitest's
 * globals, a name imported from `vitest`, a name imported from a relative module
 * (an unknown helper is treated as suspect), or a local alias of any of those.
 * `someResult.fails` in application code is not an expected-failure annotation
 * and is not reported.
 *
 * ── AND WHY IT SCANS THE GLOB, NOT THE REPORT ────────────────────────────────
 * Round 3 scanned exactly the modules the CI reporter named, which makes the
 * reporter the authority on what the second witness is allowed to look at — the
 * witness could be blinded by the thing it exists to check, and an annotation
 * living in a helper module (never a "module" in any report) was outside its
 * world entirely. So the scan starts from every test file on disk, and then
 * follows relative imports transitively, so a helper is read even though no
 * report will ever name it.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { posix, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

/** The test glob, as a predicate: `*.{test,spec}.{js,ts,jsx,tsx,mjs,cjs,mts,cts}`. */
export const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;

/** Directories a test glob never means, and that would make the walk unbounded. */
const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  'coverage',
  'dist',
  'build',
  'node_modules',
  'playwright-report',
  'test-results',
]);

/**
 * Vitest's globals, always in the root set. A config with `globals: false`
 * imports them instead, which the import scan picks up; a config with
 * `globals: true` does not, which is why they are seeded here unconditionally.
 */
const RUNNER_GLOBALS = ['it', 'test', 'describe', 'suite', 'bench'];

/** Modules whose bindings can be a test runner. Relative ones are followed too. */
function isRunnerModule(specifier) {
  return specifier === 'vitest' || specifier.startsWith('vitest/');
}

function isRelative(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

const toPosix = (path) => path.split(sep).join('/');

function defaultRead(path) {
  return readFileSync(path, 'utf8');
}

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Every test file on disk, whether or not any report mentions it.
 *
 * @param {string} root repository root
 * @returns {string[]} repo-relative POSIX paths, sorted
 */
export function collectTestFiles(root = process.cwd()) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
        found.push(toPosix(relative(root, full)));
      }
    }
  };
  walk(resolve(root));
  return found.sort();
}

/** The root identifier of a member/call chain: `test.each(rows).fails` → `test`. */
function rootIdentifier(node) {
  let current = node;
  for (;;) {
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current) ||
      ts.isCallExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    if (ts.isTaggedTemplateExpression(current)) {
      current = current.tag;
      continue;
    }
    break;
  }
  return ts.isIdentifier(current) ? current.text : undefined;
}

function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return undefined;
}

/** Walks every node, since `ts.forEachChild` alone stops at the first truthy return. */
function forEachNode(node, visitor) {
  visitor(node);
  ts.forEachChild(node, (child) => {
    forEachNode(child, visitor);
  });
}

/**
 * The module graph of one file: what it imports, and which names it binds from
 * where. Collected once, because the root-name set cannot be computed until the
 * whole graph is known (see `taintedModules`).
 */
function readModuleShape(sourceFile) {
  /** @type {{specifier: string, names: string[]}[]} */
  const bindings = [];
  const specifiers = [];

  forEachNode(sourceFile, (node) => {
    if (ts.isImportDeclaration(node)) {
      const target = node.moduleSpecifier;
      const specifier = ts.isStringLiteralLike(target) ? target.text : '';
      specifiers.push(specifier);
      const clause = node.importClause;
      if (clause === undefined) return;
      const names = [];
      if (clause.name) names.push(clause.name.text);
      const named = clause.namedBindings;
      if (named !== undefined) {
        if (ts.isNamespaceImport(named)) names.push(named.name.text);
        else for (const element of named.elements) names.push(element.name.text);
      }
      bindings.push({ specifier, names });
      return;
    }
    if (ts.isExportDeclaration(node)) {
      const target = node.moduleSpecifier;
      if (target !== undefined && ts.isStringLiteralLike(target)) specifiers.push(target.text);
      return;
    }
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (!isDynamicImport && !isRequire) return;
      const [argument] = node.arguments;
      if (argument !== undefined && ts.isStringLiteralLike(argument))
        specifiers.push(argument.text);
    }
  });

  return { bindings, specifiers };
}

/**
 * Names in one file that may denote a test runner.
 *
 * Seeded with Vitest's globals, extended with everything imported from `vitest`
 * itself and with everything imported from a *relative module that reaches
 * `vitest`* — that second clause is what makes the helper and re-export forms
 * visible without making every property named `fails` in the repository a
 * finding. `import { validate } from './domain'` binds nothing runner-shaped, so
 * `validate().fails` is not an annotation; `import { broken } from './helpers'`
 * where `helpers.ts` imports `it` from `vitest` binds something that might be.
 *
 * Then closed over local aliasing (`const t = test`) to a fixpoint, so a chain
 * of aliases is followed rather than only its first hop.
 */
function runnerRootNames(sourceFile, shape, reaches) {
  const names = new Set(RUNNER_GLOBALS);

  for (const { specifier, names: bound } of shape.bindings) {
    if (!isRunnerModule(specifier) && !reaches(specifier)) continue;
    for (const name of bound) names.add(name);
  }

  for (let pass = 0; pass < 8; pass += 1) {
    const before = names.size;
    forEachNode(sourceFile, (node) => {
      if (!ts.isVariableDeclaration(node) || node.initializer === undefined) return;
      if (!ts.isIdentifier(node.name)) return;
      const root = rootIdentifier(node.initializer);
      if (root !== undefined && names.has(root)) names.add(node.name.text);
    });
    if (names.size === before) break;
  }

  return names;
}

/** True when `node` sits anywhere inside a call whose callee roots at a runner. */
function insideRunnerCall(node, roots) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (!ts.isCallExpression(current)) continue;
    const root = rootIdentifier(current.expression);
    if (root !== undefined && roots.has(root)) return true;
  }
  return false;
}

/**
 * Every expected-failure annotation in one already-parsed file.
 *
 * @param {ts.SourceFile} sourceFile
 * @param {string} file path, for messages
 * @param {Set<string>} roots names that may denote a test runner here
 */
export function findAnnotations(sourceFile, file, roots) {
  const lines = sourceFile.getFullText().split('\n');
  const findings = [];

  const record = (node, label) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({ file, line: line + 1, label, text: (lines[line] ?? '').trim() });
  };

  forEachNode(sourceFile, (node) => {
    // `it.fails`, `it?.fails`, `test.each(rows).fails`, `it.concurrent.fails`,
    // and any of those spread over as many lines as the author likes — the AST
    // does not care where the newlines went.
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'fails') {
      const root = rootIdentifier(node.expression);
      if (root !== undefined && roots.has(root)) {
        // Reported at the `fails` token, not at the start of the chain: when the
        // chain is spread over three lines, the line that matters is the one
        // carrying the annotation, not the one carrying `it`.
        record(node.name, node.questionDotToken ? '?.fails' : '.fails');
      }
      return;
    }
    // `it['fails']` — the same property, spelled so no `.fails` appears at all.
    if (ts.isElementAccessExpression(node)) {
      const argument = node.argumentExpression;
      if (argument !== undefined && ts.isStringLiteralLike(argument) && argument.text === 'fails') {
        const root = rootIdentifier(node.expression);
        if (root !== undefined && roots.has(root)) record(node, "['fails']");
      }
      return;
    }
    // `const { fails } = it` / `const { fails: broken } = test`, which hands the
    // annotation a name of its own before it is ever called.
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      if (!ts.isObjectBindingPattern(node.name)) return;
      const root = rootIdentifier(node.initializer);
      if (root === undefined || !roots.has(root)) return;
      for (const element of node.name.elements) {
        const source_ = propertyName(element.propertyName ?? element.name);
        if (source_ === 'fails') record(element, 'destructured `fails`');
      }
      return;
    }
    // `it('x', { fails: true }, fn)` — the options-object spelling, including
    // the version where the options live in a variable the runner is handed
    // later. An explicit `fails: false` is the opposite of an annotation, and a
    // `fails` key that is neither `true` nor an argument to a runner call is
    // somebody's domain object, not a Vitest option.
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === 'fails') {
      const explicitlyTrue = node.initializer.kind === ts.SyntaxKind.TrueKeyword;
      const explicitlyFalse = node.initializer.kind === ts.SyntaxKind.FalseKeyword;
      if (!explicitlyFalse && (explicitlyTrue || insideRunnerCall(node, roots))) {
        record(node, '{ fails: … }');
      }
      return;
    }
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'fails') {
      if (insideRunnerCall(node, roots) || roots.has('fails')) record(node, '{ fails }');
    }
  });

  return findings;
}

/** Extension candidates for a relative import, TypeScript's `.js`-means-`.ts` included. */
function resolutionCandidates(base) {
  const candidates = [base];
  const rewritten = base.replace(/\.([cm]?)js$/, '.$1ts');
  if (rewritten !== base) candidates.push(rewritten, base.replace(/\.[cm]?js$/, '.tsx'));
  for (const extension of ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']) {
    candidates.push(`${base}${extension}`);
  }
  for (const extension of ['.ts', '.tsx', '.js', '.jsx', '.mjs']) {
    candidates.push(posix.join(base, `index${extension}`));
  }
  return candidates;
}

function resolveRelative(importer, specifier, read) {
  const base = posix.normalize(posix.join(posix.dirname(toPosix(importer)), specifier));
  for (const candidate of resolutionCandidates(base)) {
    try {
      read(candidate);
      return candidate;
    } catch {
      // Not this one.
    }
  }
  return undefined;
}

/**
 * Scans every entry file and everything it can reach through relative imports.
 *
 * Two passes, because the first cannot answer the question the second asks. A
 * name imported from `./helpers` is only runner-shaped if `helpers` reaches
 * `vitest`, and that is a property of the whole graph — not of the file being
 * read when it is read. So: walk and parse everything first, propagate "reaches
 * vitest" to a fixpoint across the edges, then look for annotations knowing
 * which of each file's imports could carry one.
 *
 * @param {string[]} entryFiles test modules, repo-relative
 * @param {(path: string) => string} read
 * @returns {{findings: {file: string, line: number, label: string, text: string}[],
 *            scanned: string[], unparsable: string[]}}
 */
export function scanForExpectedFailures(entryFiles, read = defaultRead) {
  /** @type {Map<string, {sourceFile: ts.SourceFile, shape: object, edges: Map<string, string>}>} */
  const modules = new Map();
  const unparsable = [];
  const queue = [...entryFiles.map(toPosix)];
  const seen = new Set();

  // --- pass 1: parse the reachable graph ------------------------------------
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    let source;
    try {
      source = read(file);
    } catch {
      // A module named by a report but absent from disk is the vitest gate's
      // problem, not this scanner's; it reconciles the file list separately.
      continue;
    }
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(file),
    );
    // A file the parser could not read is a blind spot, and a blind spot in the
    // second witness is exactly what the first witness cannot cover for.
    if ((sourceFile.parseDiagnostics ?? []).length > 0) unparsable.push(file);
    const shape = readModuleShape(sourceFile);
    const edges = new Map();
    for (const specifier of shape.specifiers) {
      if (!isRelative(specifier)) continue;
      const resolved = resolveRelative(file, specifier, read);
      if (resolved === undefined) continue;
      edges.set(specifier, resolved);
      if (!seen.has(resolved)) queue.push(resolved);
    }
    modules.set(file, { sourceFile, shape, edges });
  }

  // --- taint: which modules can hand out a test runner ----------------------
  const reachesVitest = new Set();
  for (const [file, { shape }] of modules) {
    if (shape.specifiers.some(isRunnerModule)) reachesVitest.add(file);
  }
  for (let pass = 0; pass < modules.size + 1; pass += 1) {
    const before = reachesVitest.size;
    for (const [file, { edges }] of modules) {
      if (reachesVitest.has(file)) continue;
      for (const target of edges.values()) {
        if (reachesVitest.has(target)) {
          reachesVitest.add(file);
          break;
        }
      }
    }
    if (reachesVitest.size === before) break;
  }

  // --- pass 2: find annotations, now that roots can be decided --------------
  const findings = [];
  for (const [file, { sourceFile, shape, edges }] of modules) {
    const reaches = (specifier) => {
      const target = edges.get(specifier);
      return target !== undefined && reachesVitest.has(target);
    };
    const roots = runnerRootNames(sourceFile, shape, reaches);
    findings.push(...findAnnotations(sourceFile, file, roots));
  }

  return { findings, scanned: [...modules.keys()], unparsable };
}

/** Turns a scan into gate problems, reconciled against what the reporter claimed. */
export function checkExpectedFailureWitness(scan, reportedCount) {
  const problems = [];
  const { findings, scanned, unparsable } = scan;

  if (scanned.length === 0) {
    problems.push(
      'the expected-failure scanner read no files at all. A witness that looked at nothing agrees with any report, which is the shape of a gate that has quietly stopped gating.',
    );
  }
  for (const file of unparsable) {
    problems.push(
      `${file} could not be parsed, so the expected-failure scanner cannot see what is in it. An unreadable test file is a blind spot in the only witness that can see \`it.fails\` at all.`,
    );
  }
  for (const { file, line, label, text } of findings) {
    problems.push(
      `${file}:${line} carries an expected-failure annotation (${label}): \`${text}\`. A test asserted to fail is not coverage; it is a hole with a green tick over it, and the stock Vitest report calls it "passed".`,
    );
  }
  if (findings.length !== reportedCount) {
    problems.push(
      `the source says ${findings.length} expected-failure annotation(s) exist across the ${scanned.length} file(s) scanned and the CI reporter says ${reportedCount} ran. Two independent witnesses disagree about the same run: either the reporter is not counting \`fails\`, or the annotation is in a file the runner never executed. Both are gate failures until they agree.`,
    );
  }
  return problems;
}

function main(argv) {
  const entries = argv.slice(2);
  const scan = scanForExpectedFailures(entries.length > 0 ? entries : collectTestFiles());
  for (const { file, line, label, text } of scan.findings) {
    console.error(
      `::error file=${file},line=${line}::expected-failure annotation (${label}): ${text}`,
    );
  }
  console.info(
    `Expected-failure scan: ${scan.scanned.length} file(s) parsed, ${scan.findings.length} annotation(s) found.`,
  );
  return scan.findings.length > 0 || scan.unparsable.length > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv));
}
