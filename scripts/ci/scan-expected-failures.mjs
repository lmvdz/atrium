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
 *
 * That boundary — the test glob plus what it reaches — is where it stops, and
 * that was measured rather than assumed. Pointed at every source file in the
 * repository instead, the scan reports one finding: `test.options?.fails ===
 * true` in vitest-ci-reporter.mjs, where `test` is a Vitest task object and the
 * line is the reporter *detecting* annotations rather than carrying one. There
 * is no honest rule that keeps that quiet without a carve-out, and a carve-out
 * in a witness is a hole. Reachability from a test file is the boundary that
 * needs no exceptions.
 *
 * ── WHAT THIS PASS IS NOT (round 5, correcting round 4's claim) ──────────────
 * Round 4's receipt called this an *independent witness*. It is independent —
 * it reads source, not reports — but it is not a *complete* one, and the two
 * words were run together. Being precise about it, because a witness whose
 * limits are unwritten gets trusted past them:
 *
 *   - **Non-relative imports are not followed.** A helper reached as
 *     `@atrium/test-utils`, a tsconfig path alias, or a bare workspace name is
 *     never read, so an annotation living there is invisible here.
 *   - **Computed keys must be literal.** `it['fails']` is seen; `it[KEY]` where
 *     `const KEY = 'fails'`, or `it[`fai${'ls'}`]`, is not — this pass does no
 *     constant folding and has no type information.
 *   - **`globalThis` roots are not runner roots.** `globalThis.it.fails(…)`
 *     roots at `globalThis`, which is not in the root set and deliberately is
 *     not: putting it there would make every `.fails` in the repository a
 *     finding.
 *   - **Registration from a setup file is invisible.** A `setupFiles` entry
 *     that installs a wrapper is not in any test file's import graph, so the
 *     annotation it applies is applied somewhere this scan never looks.
 *
 * All four fail **closed**, and by the other witness rather than by this one:
 * vitest-ci-reporter.mjs reads `test.options?.fails` off the live task object,
 * so any of these that actually annotates a running test raises the reporter's
 * count above this scan's, and `checkExpectedFailureWitness` fails on the
 * disagreement. That is the design — two witnesses on different sides of the
 * reporting path, each covering the other's blind spots — and it is exactly as
 * strong as that: it survives *either* witness being wrong, not both. An
 * annotation spelled one of the four ways above, in a run whose reporter has
 * also been edited to drop the flag, is seen by neither. Closing that needs a
 * check that does not execute from the revision under test, which is the
 * governance trigger in the README and not something this file can do.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
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
  // Symlinked directories can point at an ancestor, and a walk that follows one
  // never finishes — it just goes on finding the same tests under longer and
  // longer paths until the process dies, which reads as a hung CI job rather
  // than as a bug. Real paths are cheap to remember, so remember them. (Nothing
  // in this repo symlinks a directory today; this costs one syscall per
  // directory and removes the failure mode outright.)
  const visited = new Set();
  const walk = (dir) => {
    let real;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = resolve(dir, entry.name);
      // `withFileTypes` does not follow links, so a symlink reports as neither
      // a file nor a directory until it is resolved.
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stats = statSync(full);
          isDirectory = stats.isDirectory();
          isFile = stats.isFile();
        } catch {
          continue; // A dangling link is not a test file.
        }
      }
      if (isDirectory) walk(full);
      else if (isFile && TEST_FILE.test(entry.name)) found.push(toPosix(relative(root, full)));
    }
  };
  walk(resolve(root));
  return [...new Set(found)].sort();
}

/**
 * The identifier a member/call chain is rooted at, and the first property taken
 * off it: `helpers.validate().fails` → `{root: 'helpers', member: 'validate'}`.
 *
 * Round 5 kept only the root, which is enough while a binding is either a runner
 * or not. It is not enough for a namespace: `import * as helpers from './lib'`
 * binds one name to a whole module, and whether `helpers.something.fails` is an
 * annotation depends on which `something`. That is the round-5 gauntlet's second
 * major — the per-binding narrowing regressed to per-module the moment the
 * binding was a namespace object — so the first member travels with the root.
 */
function chainFromRoot(node) {
  const members = [];
  let current = node;
  for (;;) {
    if (ts.isPropertyAccessExpression(current)) {
      members.push(propertyName(current.name));
      current = current.expression;
      continue;
    }
    if (ts.isElementAccessExpression(current)) {
      const argument = current.argumentExpression;
      members.push(
        argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : undefined,
      );
      current = current.expression;
      continue;
    }
    if (
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
  if (!ts.isIdentifier(current)) return {};
  return { root: current.text, member: members.at(-1) };
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

/** In a runner-export map, "every name", for `export * from 'vitest'`. */
const ANY_EXPORT = '*';

/**
 * What a name can be, once the graph has been walked.
 *
 * `RUNNER` — this binding *is* a test runner, so `x.fails` on it is an
 * annotation. A `Set` — this binding is a namespace object, and only the members
 * in the set are runners. `undefined` — neither, so `.fails` on it is somebody's
 * domain property and none of this file's business.
 */
const RUNNER = Symbol('runner-binding');

function exportedKind(exports, name) {
  if (exports === undefined) return undefined;
  if (exports.has(name)) return exports.get(name);
  return exports.has(ANY_EXPORT) ? RUNNER : undefined;
}

/** The member names a namespace import of this module would expose. */
function namespaceMembers(exports) {
  return new Set(exports.keys());
}

/**
 * What one expression evaluates to, as far as this pass can tell.
 *
 * `it.fails` → RUNNER. `helpers` where `helpers` is a namespace → its member
 * set. `helpers.knownBroken` → RUNNER when `knownBroken` is one of the members;
 * `helpers.validate()` → undefined when it is not. Passing the *whole* `.fails`
 * access in is deliberate: for `helpers.fails` the member taken off the
 * namespace is `fails` itself, and that is exactly the name that has to be
 * runner-derived for the access to mean anything.
 */
function classify(node, scope) {
  const { root, member } = chainFromRoot(node);
  if (root === undefined) return undefined;
  if (scope.roots.has(root)) return RUNNER;
  const members = scope.namespaces.get(root);
  if (members === undefined) return undefined;
  if (member === undefined) return members; // the namespace object itself
  return members.has(ANY_EXPORT) || members.has(member) ? RUNNER : undefined;
}

function rootedAtRunner(node, scope) {
  return classify(node, scope) === RUNNER;
}

function hasExportModifier(node) {
  return (node.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

/**
 * The module graph of one file: what it imports, what it re-exports, and which
 * of its own exports are bound to something runner-shaped.
 *
 * Collected once and interpreted later, because none of the interesting
 * questions can be answered from a single file. Whether `import { broken } from
 * './helpers'` binds a test runner depends on what `helpers` exports, which
 * depends on what *it* imports; that is a property of the whole graph.
 */
function readModuleShape(sourceFile) {
  /** `{specifier, names: [{imported, local}]}`; `imported` may be `default`/`*`. */
  const imports = [];
  /** `export … from './x'`: `{specifier, names?}`, `all` for `export *`. */
  const reexports = [];
  /** `export { a as b }` with no module specifier. */
  const localAliases = [];
  /** `export const n = <expr>` and `export default <expr>`. */
  const exportedBindings = [];
  const specifiers = [];

  forEachNode(sourceFile, (node) => {
    if (ts.isImportDeclaration(node)) {
      const target = node.moduleSpecifier;
      const specifier = ts.isStringLiteralLike(target) ? target.text : '';
      specifiers.push(specifier);
      const clause = node.importClause;
      if (clause === undefined) return;
      const names = [];
      if (clause.name) names.push({ imported: 'default', local: clause.name.text });
      const named = clause.namedBindings;
      if (named !== undefined) {
        if (ts.isNamespaceImport(named))
          names.push({ imported: ANY_EXPORT, local: named.name.text });
        else
          for (const element of named.elements) {
            names.push({
              imported: (element.propertyName ?? element.name).text,
              local: element.name.text,
            });
          }
      }
      imports.push({ specifier, names });
      return;
    }
    if (ts.isExportDeclaration(node)) {
      const target = node.moduleSpecifier;
      const specifier =
        target !== undefined && ts.isStringLiteralLike(target) ? target.text : undefined;
      if (specifier !== undefined) specifiers.push(specifier);
      const clause = node.exportClause;
      if (clause !== undefined && ts.isNamedExports(clause)) {
        const names = clause.elements.map((element) => ({
          imported: (element.propertyName ?? element.name).text,
          exported: element.name.text,
        }));
        if (specifier === undefined) {
          for (const { imported, exported } of names)
            localAliases.push({ local: imported, exported });
        } else {
          reexports.push({ specifier, names });
        }
        return;
      }
      if (specifier === undefined) return;
      // `export * as ns from './x'` and `export * from './x'`.
      if (clause !== undefined && ts.isNamespaceExport(clause)) {
        reexports.push({ specifier, namespace: clause.name.text });
      } else {
        reexports.push({ specifier, all: true });
      }
      return;
    }
    if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (declaration.initializer === undefined) continue;
        if (ts.isIdentifier(declaration.name)) {
          exportedBindings.push({
            name: declaration.name.text,
            initializer: declaration.initializer,
          });
        } else if (ts.isObjectBindingPattern(declaration.name)) {
          // `export const { fails: broken } = it` — the annotation, exported.
          for (const element of declaration.name.elements) {
            if (ts.isIdentifier(element.name)) {
              exportedBindings.push({
                name: element.name.text,
                initializer: declaration.initializer,
              });
            }
          }
        }
      }
      return;
    }
    if (ts.isExportAssignment(node) && node.isExportEquals !== true) {
      exportedBindings.push({ name: 'default', initializer: node.expression });
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

  return { imports, reexports, localAliases, exportedBindings, specifiers };
}

/**
 * Names in one file that may denote a test runner.
 *
 * Seeded with Vitest's globals and extended with what is imported from `vitest`
 * itself, then — and this is the part round 5 narrows — with names imported from
 * a relative module *that are themselves bound to something runner-shaped over
 * there*, rather than with every name from any module that happens to reach
 * `vitest`.
 *
 * Round 4's rule was "an unknown helper is treated as suspect", which sounds
 * conservative and is not: a single module that both imports `vitest` and
 * exports domain code taints *all* of its exports, so
 *
 *     // lib.ts
 *     import { it } from 'vitest';
 *     export const knownBroken = it.fails;      // genuinely an annotation
 *     export const validate = () => ({ fails: 0 });   // a domain object
 *
 *     // x.test.ts
 *     expect(validate().fails).toBe(0);         // reported as an annotation
 *
 * went red, and a witness that fires on ordinary domain code is a witness
 * somebody switches off — the same defect as round 3's line matcher firing on
 * prose, one layer up. So `runnerExportsOf` answers per *name*, not per module.
 *
 * Nothing is lost by narrowing, because the annotation is found at the place it
 * is written: `it.fails` inside `lib.ts` roots at `it` and is reported there,
 * whether or not anyone imports it. The taint only decides whether a `.fails`
 * *in the importing file* counts, and for that "was this binding derived from
 * the runner" is the exact question.
 *
 * Then closed over local aliasing (`const t = test`) to a fixpoint, so a chain
 * of aliases is followed rather than only its first hop.
 *
 * ── ROUND 6: AND NAMESPACES ARE NOT ONE BINDING ─────────────────────────────
 * Round 5 narrowed the taint per name and then handed it all back for a
 * namespace import: `import * as helpers from './lib'` added `helpers` to the
 * root set outright when *anything* behind it was runner-derived, so a module
 * exporting one test helper beside ordinary code turned every `helpers.x.fails`
 * into a finding. That is the same false red as round 4's, one syntax over, and
 * it was undetected because the existing namespace fixture imported a module
 * whose exports were *all* runners. A namespace binds to its member set now, and
 * the member actually taken off it decides.
 */
function runnerScope(sourceFile, shape, runnerExportsOf) {
  const scope = { roots: new Set(RUNNER_GLOBALS), namespaces: new Map() };
  const bind = (local, kind) => {
    if (kind === RUNNER) scope.roots.add(local);
    else if (kind instanceof Set) scope.namespaces.set(local, kind);
  };

  for (const { specifier, names: bound } of shape.imports) {
    const fromRunner = isRunnerModule(specifier);
    const exported = fromRunner ? undefined : runnerExportsOf(specifier);
    for (const { imported, local } of bound) {
      if (fromRunner) {
        // Everything `vitest` exports is a runner, so a namespace import of it
        // is a namespace whose every member counts.
        bind(local, imported === ANY_EXPORT ? new Set([ANY_EXPORT]) : RUNNER);
        continue;
      }
      if (exported === undefined) continue;
      if (imported === ANY_EXPORT) {
        if (exported.size > 0) bind(local, namespaceMembers(exported));
        continue;
      }
      bind(local, exportedKind(exported, imported));
    }
  }

  for (let pass = 0; pass < 8; pass += 1) {
    const before = scope.roots.size + scope.namespaces.size;
    forEachNode(sourceFile, (node) => {
      if (!ts.isVariableDeclaration(node) || node.initializer === undefined) return;
      if (!ts.isIdentifier(node.name)) return;
      bind(node.name.text, classify(node.initializer, scope));
    });
    if (scope.roots.size + scope.namespaces.size === before) break;
  }

  return scope;
}

/**
 * Which of one module's exported names hand a test runner to whoever imports
 * them: anything bound to an expression rooted at a runner name here, anything
 * re-exported from a module (or from `vitest`) that exports it that way.
 *
 * A wrapper function — `export const brokenTest = (name, fn) => it(name, {fails:
 * true}, fn)` — is deliberately *not* one of these. It is not a runner binding;
 * it is a function that calls one, and the annotation it carries is found in the
 * file that defines it, where `it` is in scope and in the root set.
 */
function runnerExportMap(shape, scope, runnerExportsOf) {
  const exported = new Map();
  const put = (name, kind) => {
    if (kind !== undefined) exported.set(name, kind);
  };

  for (const { name, initializer } of shape.exportedBindings) {
    put(name, classify(initializer, scope));
  }
  for (const { local, exported: as } of shape.localAliases) {
    if (scope.roots.has(local)) put(as, RUNNER);
    else if (scope.namespaces.has(local)) put(as, scope.namespaces.get(local));
  }
  for (const entry of shape.reexports) {
    const fromRunner = isRunnerModule(entry.specifier);
    const target = fromRunner ? undefined : runnerExportsOf(entry.specifier);
    if (!fromRunner && target === undefined) continue;
    if (entry.all === true) {
      // `export * from 'vitest'` re-exports names this pass cannot enumerate.
      if (fromRunner) put(ANY_EXPORT, RUNNER);
      else for (const [name, kind] of target) put(name, kind);
      continue;
    }
    if (entry.namespace !== undefined) {
      // `export * as ns from './x'` hands on a namespace object, so it hands on
      // the member set with it rather than a single bit.
      if (fromRunner) put(entry.namespace, new Set([ANY_EXPORT]));
      else if (target.size > 0) put(entry.namespace, namespaceMembers(target));
      continue;
    }
    for (const { imported, exported: as } of entry.names) {
      put(as, fromRunner ? RUNNER : exportedKind(target, imported));
    }
  }

  return exported;
}

/** True when `node` sits anywhere inside a call whose callee roots at a runner. */
function insideRunnerCall(node, scope) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (!ts.isCallExpression(current)) continue;
    if (rootedAtRunner(current.expression, scope)) return true;
  }
  return false;
}

/**
 * Every expected-failure annotation in one already-parsed file.
 *
 * @param {ts.SourceFile} sourceFile
 * @param {string} file path, for messages
 * @param {{roots: Set<string>, namespaces: Map<string, Set<string>>}} scope
 */
export function findAnnotations(sourceFile, file, scope) {
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
      if (rootedAtRunner(node, scope)) {
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
        if (rootedAtRunner(node, scope)) record(node, "['fails']");
      }
      return;
    }
    // `const { fails } = it` / `const { fails: broken } = test`, which hands the
    // annotation a name of its own before it is ever called.
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      if (!ts.isObjectBindingPattern(node.name)) return;
      if (!rootedAtRunner(node.initializer, scope)) return;
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
      if (!explicitlyFalse && (explicitlyTrue || insideRunnerCall(node, scope))) {
        record(node, '{ fails: … }');
      }
      return;
    }
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'fails') {
      if (insideRunnerCall(node, scope) || scope.roots.has('fails')) record(node, '{ fails }');
    }
  });

  return findings;
}

/** Files this scanner can read at all. A stylesheet is not a blind spot. */
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

/**
 * Extension candidates for a relative import, TypeScript's `.js`-means-`.ts`
 * included.
 *
 * Every candidate is JS or TS. A relative import can just as easily name a
 * stylesheet or a JSON fixture, and following one of those would hand the
 * TypeScript parser something it cannot read — which this file, correctly,
 * treats as a blind spot and fails the gate over. Measured: pointed at the whole
 * repository, an earlier version of this resolver reached `design/tokens.css`
 * through `apps/web`'s layout and called it unparsable. A gate that goes red
 * because someone imported a `.module.css` into a component test is a gate
 * someone deletes, so the resolver never offers the parser a non-source file.
 */
function resolutionCandidates(base) {
  const candidates = SOURCE_FILE.test(base) ? [base] : [];
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

  // --- taint: which *bindings* can hand out a test runner --------------------
  //
  // Round 4 propagated a single bit per module — "reaches vitest" — and treated
  // every name imported from such a module as a runner root. That is why domain
  // code sitting in the same file as a test helper read as an annotation. What
  // propagates now is a set of names per module, grown to a fixpoint: the sets
  // only ever gain members, so the loop terminates, and the bound is generous
  // rather than load-bearing.
  const runnerExports = new Map([...modules.keys()].map((file) => [file, new Map()]));
  const lookup = (file) => (specifier) => {
    const target = modules.get(file).edges.get(specifier);
    return target === undefined ? undefined : runnerExports.get(target);
  };

  for (let pass = 0; pass <= modules.size + 1; pass += 1) {
    let grew = false;
    for (const [file, { sourceFile, shape }] of modules) {
      const runnerExportsOf = lookup(file);
      const scope = runnerScope(sourceFile, shape, runnerExportsOf);
      const current = runnerExports.get(file);
      for (const [name, kind] of runnerExportMap(shape, scope, runnerExportsOf)) {
        // Monotone by construction, which is what makes the loop terminate:
        // absent → a namespace or a runner, a namespace → a runner, and a
        // namespace's member set only ever gains names.
        const existing = current.get(name);
        if (existing === undefined) {
          current.set(name, kind instanceof Set ? new Set(kind) : kind);
          grew = true;
        } else if (existing !== RUNNER && kind === RUNNER) {
          current.set(name, RUNNER);
          grew = true;
        } else if (existing instanceof Set && kind instanceof Set) {
          for (const member of kind) {
            if (!existing.has(member)) {
              existing.add(member);
              grew = true;
            }
          }
        }
      }
    }
    if (!grew) break;
  }

  // --- pass 2: find annotations, now that roots can be decided --------------
  const findings = [];
  for (const [file, { sourceFile, shape }] of modules) {
    findings.push(
      ...findAnnotations(sourceFile, file, runnerScope(sourceFile, shape, lookup(file))),
    );
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
