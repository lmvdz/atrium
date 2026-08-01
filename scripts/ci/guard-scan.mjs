/**
 * The main-module guard, checked by parsing rather than by reading the file as a
 * string.
 *
 * ── THE DEFECT THIS FILE EXISTS FOR (#40 round 6) ───────────────────────────
 * Round 5 enforced the guard with two text tests over the whole source:
 *
 *     if (MENTIONS_ENTRY.test(source) && !source.includes(CANONICAL_GUARD)) …
 *
 * `String.includes` does not know where in a file it found something. It found
 * `CANONICAL_GUARD` in `gate-selftest.mjs` at line 1607, where the string sat as
 * a *fixture*:
 *
 *     const CANONICAL_GUARD_LINE = 'if (isMainModule(import.meta.url)) {';
 *
 * so `gate-selftest.mjs` satisfied the check no matter what its real guard on
 * line 1951 said. And `mainGuardProblems` was invoked in exactly one place in
 * the repository — line 1407 of that same file. Sole enforcer, sole exception.
 *
 * Measured on `fix/deploy-serves-r5` as committed: change the real guard to
 *
 *     if (isMainModule(import.meta.url) && process.env.CI === undefined) {
 *
 * and `node scripts/ci/gate-selftest.mjs` still prints "142 cases", the scanner
 * still reports 0 problems, biome is clean, the workflow policy is clean — and
 * under `CI=true`, which is how GitHub runs it, the file exits 0 having printed
 * nothing and asserted nothing. `workflow-policy-selftest.mjs` then takes the
 * same edit unopposed, because the only thing that would have noticed was the
 * file just disarmed. Two `&&` insertions, 316 assertions gone, every gate
 * green.
 *
 * The exemption list was the same shape of mistake one level up:
 * `NOT_ENTRY_POINTS` held `main-module.mjs`, because that file has to *say* the
 * words it forbids. A test suite necessarily contains examples of what it
 * refuses, so any rule enforced by scanning file text will exempt its own tests
 * — by an explicit list, or by a fixture that accidentally satisfies it.
 *
 * ── WHAT THIS DOES INSTEAD ──────────────────────────────────────────────────
 * It parses. A string literal is a string literal, a comment is a comment, and a
 * statement has a position — none of which a substring test can see. The rule is
 * an allowlist over the *only* thing `import.meta` may be used for in a script
 * under `scripts/`:
 *
 *     if (isMainModule(import.meta.url)) {   ← top level, exactly this condition
 *       process.exit(main());                ← and it must actually exit
 *     }
 *
 * `isMainModule` must be the binding imported from `scripts/ci/main-module.mjs`
 * and not a local redefinition; the `if` must be a top-level statement, so one
 * nested inside `if (false)` is not a guard; the consequent must call
 * `process.exit`, so an empty block is not a guard; and every other appearance
 * of `import.meta` anywhere in the file is a violation, whatever it is spelled
 * like. Denylisting evasions is unbounded — `&& false`, `&& process.env.CI ===
 * undefined`, `&& !process.env.SKIP`, and the next one nobody has thought of —
 * so this names the compliant form and refuses the complement.
 *
 * ── AND WHO RUNS IT ─────────────────────────────────────────────────────────
 * Three callers, deliberately: `gate-selftest.mjs`, `workflow-policy-selftest.mjs`
 * — which check each other, so disarming one leaves the other scanning it — and
 * `packages/ci-guard`, a Vitest project that is not under `scripts/` at all and
 * therefore is not among this scanner's subjects. `checker-graph.mjs` asserts
 * that third caller keeps existing. A check whose only invoker is inside the set
 * of files it checks cannot be trusted, and that is now a property with a test
 * rather than a habit.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import ts from 'typescript';

/** The one compliant spelling, for error messages. Never compared as text. */
export const CANONICAL_GUARD = [
  'if (isMainModule(import.meta.url)) {',
  '  process.exit(main());',
  '}',
].join('\n');

/** Where `isMainModule` must come from for a guard to count. */
const GUARD_MODULE = 'main-module.mjs';

const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

const BROKEN_GUARD_ADVICE =
  '`import.meta.url` percent-encodes anything that is not URL-safe and has already been resolved through any symlink on the way; `process.argv[1]` is a path, encoded nowhere and resolved not at all. Measured: `node "/tmp/g/with space/g.mjs"` exits 0 where `node /tmp/g/g.mjs` exits 3, and an invocation through a symlink does the same — the script prints nothing, asserts nothing, and exits 0. Use `isMainModule(import.meta.url)` from scripts/ci/main-module.mjs.';

/**
 * Every extension this scanner reads.
 *
 * `.mjs` is the only one under `scripts/` today, and "the only one today" is the
 * assumption that made the original defect latent. Adding `scripts/ci/foo.js`
 * with the round-4 comparison in it would have been invisible to a `.mjs`-only
 * scan, and nothing anywhere would have said so.
 */
const SCANNED = /\.[cm]?[jt]sx?$/;

function scriptKind(path) {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return /\.[cm]?ts$/.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

function parse(path, source) {
  return ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, true, scriptKind(path));
}

/** `import.meta`, wherever it appears. */
function isImportMeta(node) {
  return (
    ts.isMetaProperty(node) &&
    node.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.name.text === 'meta'
  );
}

/** `import.meta.url`, and nothing else off `import.meta`. */
function isImportMetaUrl(node) {
  return (
    ts.isPropertyAccessExpression(node) && node.name.text === 'url' && isImportMeta(node.expression)
  );
}

/**
 * A body that does something.
 *
 * Deliberately weak, and the weakness is the honest boundary. Six of the
 * fifteen entry points here do their whole job inside the guard and exit
 * through `report()` or `check()` rather than through a literal
 * `process.exit(main())`, so "must call `process.exit`" would be a rule about
 * this repository's punctuation rather than about the defect. What *is*
 * checkable is that the branch is not empty: `if (isMainModule(import.meta.url))
 * {}` passes any condition-only check, runs, asserts nothing and exits 0.
 * Whether a non-empty body asserts anything is semantics, and semantics is the
 * boundary the SCOPE block in workflow-policy.mjs owns — a `main()` replaced
 * with `() => 0` is out of reach of every check that reads this revision.
 */
function isEmptyBody(statement) {
  const body = ts.isBlock(statement) ? statement.statements : [statement];
  return body.every((child) => ts.isEmptyStatement(child));
}

/**
 * The compliant guard, as a shape.
 *
 * @returns {undefined|{ node: ts.IfStatement, reason?: string }} `reason` is set
 *   when this *is* the guard being attempted and is wrong in a nameable way, so
 *   the message can say which half failed rather than "not the canonical line".
 */
function guardShape(statement) {
  if (!ts.isIfStatement(statement)) return undefined;
  const condition = statement.expression;
  // Is this an attempt at the guard at all? Anything whose condition mentions
  // `isMainModule` is, including `isMainModule(import.meta.url) && false`.
  const mentionsPredicate = (function walk(node) {
    if (ts.isIdentifier(node) && node.text === 'isMainModule') return true;
    return node.forEachChild(walk) ?? false;
  })(condition);
  if (!mentionsPredicate) return undefined;

  if (
    !(
      ts.isCallExpression(condition) &&
      ts.isIdentifier(condition.expression) &&
      condition.expression.text === 'isMainModule' &&
      condition.arguments.length === 1 &&
      condition.arguments[0] !== undefined &&
      isImportMetaUrl(condition.arguments[0])
    )
  ) {
    return {
      node: statement,
      reason:
        'its condition is not exactly `isMainModule(import.meta.url)`. Anything conjoined to the predicate can make it false on a machine where nobody looks: `&& false` and `&& process.env.CI === undefined` both keep the sound predicate, satisfy every text test ever written for this, and exit 0 having asserted nothing — the second is silent precisely under CI',
    };
  }
  if (statement.elseStatement !== undefined) {
    return { node: statement, reason: 'it has an `else` branch, which the guard does not have' };
  }
  if (isEmptyBody(statement.thenStatement)) {
    return {
      node: statement,
      reason:
        'its body is empty, so the script establishes that it was run and then does nothing and exits 0 — which passes any check that reads the condition alone',
    };
  }
  return { node: statement };
}

/** Every `isMainModule` binding this file imports, and where from. */
function importedPredicateSources(sourceFile) {
  const sources = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (clause?.namedBindings === undefined || !ts.isNamedImports(clause.namedBindings)) continue;
    for (const element of clause.namedBindings.elements) {
      if (element.name.text !== 'isMainModule') continue;
      const specifier = statement.moduleSpecifier;
      sources.push(ts.isStringLiteral(specifier) ? specifier.text : '(computed)');
    }
  }
  return sources;
}

/** A local `isMainModule` — the predicate replaced by one that says what you like. */
function declaresPredicateLocally(sourceFile) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    const named =
      ts.isFunctionDeclaration(node) ||
      ts.isVariableDeclaration(node) ||
      ts.isClassDeclaration(node);
    if (named && node.name !== undefined && ts.isIdentifier(node.name)) {
      if (node.name.text === 'isMainModule') {
        found = true;
        return;
      }
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return found;
}

/**
 * Every problem with one file's decision about whether it was run.
 *
 * @param {string} path repo-relative, for the message
 * @param {string} source
 * @returns {string[]}
 */
export function guardProblems(path, source) {
  const problems = [];
  let sourceFile;
  try {
    sourceFile = parse(path, source);
  } catch (error) {
    return [`${path} could not be parsed (${error.message}), so its guard cannot be checked.`];
  }
  // A parse that silently produced garbage is worse than one that threw.
  if (sourceFile.parseDiagnostics?.length > 0) {
    const first = sourceFile.parseDiagnostics[0];
    return [
      `${path} does not parse as JavaScript (${ts.flattenDiagnosticMessageText(first.messageText, ' ')}), so nothing here can tell whether its guard is sound. Fix the file; a scanner that skips what it cannot read is a scanner with a hole shaped like a syntax error.`,
    ];
  }

  const guards = [];
  // `import.meta` nodes that have already been spoken for: the argument of a
  // sound guard, and everything in the condition of an unsound one, which has
  // just been reported by name. Without the second the same line is reported
  // twice, once as a bad guard and once as a stray `import.meta`.
  const accounted = new Set();
  for (const statement of sourceFile.statements) {
    const shape = guardShape(statement);
    if (shape === undefined) continue;
    if (shape.reason === undefined) {
      guards.push(shape.node);
      continue;
    }
    problems.push(
      `${path}:${line(sourceFile, shape.node)} attempts the main-module guard but ${shape.reason}. Write it exactly:\n${CANONICAL_GUARD}`,
    );
    const claim = (node) => {
      if (isImportMeta(node)) accounted.add(node);
      node.forEachChild(claim);
    };
    claim(shape.node.expression);
  }

  for (const guard of guards) {
    const argument = guard.expression.arguments[0];
    accounted.add(argument.expression); // the `import.meta` of `import.meta.url`
  }
  const offenders = [];
  const visit = (node) => {
    if (isImportMeta(node) && !accounted.has(node)) offenders.push(node);
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);

  for (const node of offenders) {
    const comparison = enclosingEqualityAgainstEntryPath(node);
    problems.push(
      comparison === undefined
        ? `${path}:${line(sourceFile, node)} uses \`import.meta\` outside the one place a script here may: as the single argument of a top-level \`isMainModule(import.meta.url)\` guard. Found \`${text(sourceFile, node.parent ?? node)}\`. ${BROKEN_GUARD_ADVICE}`
        : `${path}:${line(sourceFile, node)} decides whether it was run by comparing \`import.meta.url\` against a \`file://\` path (\`${text(sourceFile, comparison)}\`). ${BROKEN_GUARD_ADVICE}`,
    );
  }

  // The same comparison written without naming `import.meta` at all.
  const argvVisit = (node) => {
    if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
      for (const side of [node.left, node.right]) {
        if (isEntryArgv(side)) {
          problems.push(
            `${path}:${line(sourceFile, node)} compares \`process.argv[1]\` for equality (\`${text(sourceFile, node)}\`). Whatever it is compared against, that is the round-4 guard with the other half renamed. ${BROKEN_GUARD_ADVICE}`,
          );
        }
      }
    }
    node.forEachChild(argvVisit);
  };
  sourceFile.forEachChild(argvVisit);

  // The predicate has to be the shared one.
  if (guards.length > 0) {
    const sources = importedPredicateSources(sourceFile);
    if (sources.length === 0) {
      problems.push(
        `${path} uses \`isMainModule\` in a guard without importing it from scripts/ci/${GUARD_MODULE}. A locally defined predicate of the same name is the fifteen-copies problem this file exists to end.`,
      );
    } else if (!sources.every((specifier) => basename(specifier) === GUARD_MODULE)) {
      problems.push(
        `${path} imports \`isMainModule\` from ${sources.join(', ')} rather than from a path ending in ${GUARD_MODULE}.`,
      );
    }
    if (declaresPredicateLocally(sourceFile)) {
      problems.push(
        `${path} declares its own \`isMainModule\`, shadowing the imported predicate. The guard then means whatever this file wants it to.`,
      );
    }
  }

  return problems;
}

/** `process.argv[1]`, as an expression. */
function isEntryArgv(node) {
  return (
    ts.isElementAccessExpression(node) &&
    ts.isNumericLiteral(node.argumentExpression) &&
    node.argumentExpression.text === '1' &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'argv' &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'process'
  );
}

/**
 * The `x === 'file://…'` this `import.meta` sits inside, if it does.
 *
 * Only used to pick the better of two messages; the violation is already
 * established by the node being outside a compliant guard.
 */
function enclosingEqualityAgainstEntryPath(node) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isBinaryExpression(current) && EQUALITY.has(current.operatorToken.kind)) return current;
    if (ts.isStatement(current)) return undefined;
  }
  return undefined;
}

function line(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function text(sourceFile, node) {
  const raw = node.getText(sourceFile).replace(/\s+/g, ' ');
  return raw.length > 120 ? `${raw.slice(0, 117)}…` : raw;
}

/**
 * Every file under `directory` whose main-module decision is not the sound one.
 *
 * There is no exemption list. `main-module.mjs` names the shapes it forbids in
 * prose and in an error message, and this scanner reads neither comments nor
 * string literals, so it needs no permission to say them — which is the whole
 * argument for parsing. If a file ever legitimately needs `import.meta` for
 * something else, that is a conversation to have in a diff, not a name to add to
 * a set.
 *
 * @param {string} directory
 * @param {(path: string) => string} [read] injectable so the self-tests can hand
 *   this a fixture without writing files
 * @returns {string[]} human-readable problems; empty means every guard is sound
 */
export function mainGuardProblems(directory, read = (path) => readFileSync(path, 'utf8')) {
  const problems = [];
  // Recursive, because "the directory happens to be flat today" is the same kind
  // of assumption as "the checkout path happens to have no space in it" — which
  // is what made the original defect latent rather than absent.
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      problems.push(...mainGuardProblems(full, read));
      continue;
    }
    if (!SCANNED.test(entry.name)) continue;
    problems.push(...guardProblems(full, read(full)));
  }
  return problems;
}
