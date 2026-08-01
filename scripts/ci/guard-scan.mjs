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
 * `isMainModule` must be the binding imported from `./main-module.mjs` by that
 * exact specifier and not a local redefinition or a lookalike beside it; the
 * call must not be optional (`?.` short-circuits to a falsy `undefined`); the
 * `if` must be a top-level statement, so one nested inside `if (false)` is not a
 * guard; the body must contain a statement that can do something, so `{}`,
 * `{ void 0; }` and `{ debugger; }` are not guards; and every other appearance
 * of `import.meta` anywhere in the file is a violation, whatever it is spelled
 * like. Denylisting evasions is unbounded — `&& false`, `&& process.env.CI ===
 * undefined`, `&& !process.env.SKIP`, and the next one nobody has thought of —
 * so this names the compliant form and refuses the complement. Parentheses are
 * not a spelling: `if ((isMainModule(import.meta.url)))` is the guard.
 *
 * ── AND WHO RUNS IT ─────────────────────────────────────────────────────────
 * Three callers, deliberately: `gate-selftest.mjs`, `workflow-policy-selftest.mjs`
 * — which check each other, so disarming one leaves the other scanning it — and
 * `packages/ci-guard`, a Vitest project that is not under `scripts/` at all and
 * therefore is not among this scanner's subjects. `checker-graph.mjs` asserts
 * that third caller keeps existing. A check whose only invoker is inside the set
 * of files it checks cannot be trusted, and that is now a property with a test
 * rather than a habit.
 *
 * ── THE SCOPE SENTENCE, WHICH IS WHERE ROUND 7 PUT THE DEFECT (#40 round 8) ──
 * Round 7 argued — in this file, in the comment on `exitProblem` — that
 * denylisting evasions is unbounded, and built an allowlist over the exit
 * *value*. It then scoped that allowlist to the guard body and wrote no sentence
 * saying so. A blind critic put one statement one line above the guard:
 *
 *     if (process.env.CI !== undefined) process.exit(0);   ← module top level
 *
 *     if (isMainModule(import.meta.url)) {
 *
 * Measured on `fix/deploy-serves-r7` as committed, under `CI=true`, which is how
 * GitHub runs both self-tests: `gate-selftest exit=0 bytes=0 ·
 * workflow-policy-selftest exit=0 bytes=0`, `mainGuardProblems: 0`, policy 0,
 * biome 0, vitest 0 (766). 184 gate cases and 197 policy mutations gone for two
 * files and one insertion each — the same price and the same result as round 5,
 * against the commit that fixed round 5. And one line further, deleting a row
 * from `ENFORCEMENT`, is then invisible too, because the README-size ratchet
 * that exists for exactly that deletion lives inside the file the insertion
 * silenced.
 *
 * The same defect had two more spellings *inside* the declared scope, which is
 * how little the scope was worth even where it applied:
 *
 *     process.on('exit', () => { process.exitCode = 0; });  ← node rewrites the
 *     process.exit(await main());                              status afterwards
 *
 *     const code = await main();                            ← a block-scoped
 *     if (process.env.CI) { const code = 0; process.exit(code); }  shadow, which
 *     process.exit(code);                                      is not a
 *                                                              reassignment
 *
 * So this round writes the scope down and then attacks the sentence:
 *
 *   **In every file this scanner reads, the exit status of the process is
 *   decided in exactly one way — `process.exit` carrying the result of the work
 *   or a non-zero literal — wherever in the file it is written, at any nesting
 *   depth, inside a function or outside one.**
 *
 * `exitMachineryProblems` is that sentence. Everything that can move the exit
 * status some other way is refused by not being the one allowed shape:
 * `process.exitCode`, every `process.on`/`once`/`addListener` registration
 * (whatever event it names — an `exit` listener rewrites the status a terminator
 * already chose, and enumerating the safe events would be a denylist), a
 * `process.exit` *reference* that is not a call (an alias is a call with the
 * name filed off), an assignment to `process.argv` (the guard's only input), and
 * the identifier `process` used as anything but the object of a member access,
 * which is what closes `const p = process; p.exit(0);`.
 *
 * ── AND WHERE *THAT* SENTENCE STOPS ─────────────────────────────────────────
 * It reads one directory. A script under `scripts/` that imports a module under
 * `packages/` inherits whatever that module does at load time, and nothing here
 * looks: `sharedModuleProblems` in checker-graph.mjs is what requires a shared
 * decision to have an outside witness, and it counts imports within `scripts/`.
 * It reads syntax, so `globalThis['pro' + 'cess'].exit(0)` is a computed access
 * this does not resolve. And it says nothing about whether the work the status
 * comes from does anything — a `main()` rewritten to `() => 0` satisfies every
 * rule here and always will. The backstop for all three is behavioural rather
 * than syntactic and it is new this round: `positive-control.mjs` runs the
 * shipped entry points against a deliberately broken world and requires each one
 * to go red. A file silenced by any means whatsoever fails that, including the
 * means nobody has thought of.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/** The one compliant spelling, for error messages. Never compared as text. */
export const CANONICAL_GUARD = [
  'if (isMainModule(import.meta.url)) {',
  '  process.exit(main());',
  '}',
].join('\n');

/**
 * Where `isMainModule` must come from for a guard to count.
 *
 * ── WHY THIS IS NOT `basename(specifier)` (found by a blind review of r6) ───
 * The first version of this file compared the basename, and a cross-lineage
 * review measured what that accepts:
 *
 *     import { isMainModule } from './vendor/main-module.mjs';   ← accepted
 *     import { isMainModule } from '/tmp/main-module.mjs';       ← accepted
 *     import { isMainModule } from '../attacker/main-module.mjs';← accepted
 *
 * A module at any of those paths that returns `false` restores the exact
 * fail-open this scanner exists to stop, with the scanner green — which is the
 * round-5 defect again, in the commit that fixed the round-5 defect, because a
 * *name* was checked where a *location* was meant. (Same class as
 * `VITEST_RUN_START=`: the rule was about the identifier, the meaning was in
 * the value.)
 *
 * So the specifier is normalised and must be the file itself, reached by `./`
 * or by `../` only. No sideways directory component, no absolute path, and no
 * bare specifier — a bare `main-module.mjs` is a *package* name in ESM, which is
 * a different module entirely and one an attacker controls through
 * `node_modules`. `../main-module.mjs` stays legal so a script may live in a
 * subdirectory of `scripts/ci/`.
 *
 * This is a path rule, not a proof. Replacing `scripts/ci/main-module.mjs`
 * itself still defeats *this file* — nothing here reads that module's body.
 *
 * ── AND THAT SENTENCE USED TO END "WHICH IS THE LOUD KIND OF CHANGE" ────────
 * It said so, and it was false. A blind critic added one statement to
 * `main-module.mjs`:
 *
 *     if (process.env.GITHUB_JOB === 'verify') return false;
 *
 * `GITHUB_JOB` is set by GitHub per job, so that kills the whole `verify` job
 * and leaves `deploy` working — 176 gate cases and 182 policy mutations gone,
 * eleven of twenty-one CI entry points down to `exit=0 bytes=0`, and every gate
 * green. Nothing anywhere went red, because round 6 had replaced fifteen copies
 * of a predicate with one and then tested the *shape of the guard in the
 * callers*. A claim about how loud a change is has to be a claim about something
 * that makes noise.
 *
 * It is loud now, and by a rule rather than by a hope: `checker-graph.mjs`
 * carries a row for `isMainModule` whose contract puts the predicate through
 * synthetic `argv` — a plain path, a path with a space in it, a symlink, a
 * missing entry point — and then asks the same questions again with every
 * variable GitHub sets, requiring the same answers. `packages/ci-guard` runs the
 * same table from outside `scripts/`, plus a real child process that must exit 3
 * when node is given the file and 0 when the file is imported. The statement
 * above fails eight assertions in a project whose floor ratchets against
 * origin/main. Adding a lookalike beside the module is still the quiet kind, and
 * still what the path rule below is for.
 */
const GUARD_MODULE = 'main-module.mjs';
const GUARD_SPECIFIER = /^(?:\.\/|(?:\.\.\/)+)main-module\.mjs$/;

/**
 * The other terminator a guard body may end on, and where it must come from.
 *
 * `report(what)` prints every recorded failure and exits 1, or prints "passed"
 * and exits 0 — so it is an exit status derived from the work, in the one
 * spelling six of the stack assertions here use. It is held to the same path
 * rule as the predicate for the same reason: a `report` imported from anywhere
 * else is an unconditional `process.exit(0)` under a reassuring name.
 */
const REPORTER = 'report';
const REPORTER_MODULE = 'stack-client.mjs';
const REPORTER_SPECIFIER = /^(?:\.\/|(?:\.\.\/)+)stack-client\.mjs$/;

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
 * `{}` passes any condition-only check, runs, asserts nothing and exits 0. This
 * is the cheapest shape of that and is kept as its own message because it is the
 * one a reader recognises; everything subtler is the exit-status rule below.
 */
function isEmptyBody(statement) {
  const body = ts.isBlock(statement) ? statement.statements : [statement];
  return body.every((child) => doesNothing(child));
}

/**
 * How the guard body ends, and with what status.
 *
 * ── THE DEFECT (#40 round 7, measured on r6 as committed) ───────────────────
 * Round 6 checked the body by *statement kind*: it required at least one
 * top-level statement that is not a branch and that calls something. A blind
 * critic moved the conjunct one level further in — into the argument of the exit
 * — and the whole family went through:
 *
 *     process.exit(process.env.CI === undefined ? await main() : 0);   accepted
 *     process.exit(process.env.CI === undefined && (await main()));    accepted
 *     const code = process.env.CI ? 0 : await main();                  accepted
 *     process.exit(code);
 *     console.info('starting');                                        accepted
 *     if (process.env.CI === undefined) { process.exit(await main()); }
 *     main().catch(() => {});                                          accepted
 *     process.exit(0);                                                 accepted
 *
 * Applied to `gate-selftest.mjs` and `workflow-policy-selftest.mjs` that is two
 * files and one insertion each: biome 0, gate 0 (0 bytes), wps 0 (0 bytes),
 * policy 0, ci-guard 0 (49 passed), `CI=true pnpm test` 0 (691 passed). Round 5
 * cost 316 assertions for two `&&` in two files; this is the same price for the
 * same two files, because the rule was about the *shape of a statement* and the
 * defect is about the *value the process exits with*. A statement-kind rule is
 * satisfied by an unconditional decoy written beside a fully gated body, which
 * is the cheapest evasion in the list and touches the gate not at all.
 *
 * ── THE RULE, AS AN ALLOWLIST OVER EXIT STATUS ──────────────────────────────
 * Denylisting evasions is unbounded — that is this file's own argument for the
 * condition, and round 6 failed to apply it to the body. So the body's *last*
 * top-level statement must be one of exactly two unconditional terminators:
 *
 *     process.exit(<work>)     `<work>` is `f(…)` or `await f(…)`, a call on a
 *                              plain identifier, or a name bound to one at the
 *                              body's top level and never reassigned
 *     report('<name>')         the reporter imported from ./stack-client.mjs,
 *                              which exits 1 on any recorded failure and 0
 *                              otherwise — the shape six of these scripts use
 *
 * and every `process.exit` anywhere in the body must carry either an allowed
 * `<work>` or a **non-zero integer literal**. `process.exit(2)` on a usage error
 * is a real failure exit and stays legal; `process.exit(0)`, a ternary, a `&&`,
 * a comparison, a `.catch(…)` chain, an unbound name, and a name bound to any of
 * those are all refused, because each is a way to spell "exit 0 on a machine
 * where nobody looks". A body whose last statement is an `if`, a `try`, a loop
 * or a `console.info` never reaches an unconditional terminator and is refused
 * for that reason rather than for its punctuation.
 *
 * ── WHERE THIS STOPS, EXACTLY ───────────────────────────────────────────────
 * `main()` itself replaced by `() => 0` is out of reach and always will be: this
 * reads one revision's syntax, and what the work *means* is the boundary the
 * SCOPE block in workflow-policy.mjs owns. Arguments passed to `main` are data
 * and are not read — `main(process.env.CI ? 'a' : 'b')` is accepted, because the
 * status still comes from `main`. What moved is that there is no longer a
 * spelling of "the exit status is 0 because of a condition in this file" that
 * this accepts.
 */
function exitProblem(statement, sourceFile) {
  const body = ts.isBlock(statement) ? statement.statements : [statement];
  const bindings = topLevelBindings(body);

  // Every exit in the body, wherever it sits: the terminator rule below governs
  // how the body *ends*, and this governs what any exit it does reach may say.
  let badStatus;
  const visit = (node) => {
    if (badStatus !== undefined) return;
    if (isProcessExit(node)) {
      const problem = statusProblem(node.arguments[0], bindings, sourceFile);
      if (problem !== undefined) badStatus = problem;
      return;
    }
    node.forEachChild(visit);
  };
  for (const child of body) visit(child);
  if (badStatus !== undefined) return badStatus;

  const last = body[body.length - 1];
  if (last === undefined) return undefined; // `isEmptyBody` owns that message
  if (ts.isExpressionStatement(last)) {
    const expression = unwrap(last.expression);
    if (isProcessExit(expression)) return undefined; // its status is checked above
    if (isReporterCall(expression)) return undefined;
  }
  return `it never reaches an unconditional exit: its last statement is \`${text(sourceFile, last).slice(0, 60)}\`, not \`process.exit(main())\` or \`report('…')\`. A body that ends in an \`if\`, a \`try\`, a loop or a log runs the gate and then decides whether to do the work — which is the round-5 conjunct moved one line further in, and the cheapest spelling of it is an unconditional harmless statement written above a fully gated body, which satisfies any rule about statement *kind* while touching the gate not at all`;
}

/** `process.exit(…)`, however it is parenthesised. */
function isProcessExit(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'process' &&
    node.expression.name.text === 'exit'
  );
}

/** `report('assert-x')` — the terminator the stack assertions use. */
function isReporterCall(node) {
  return (
    ts.isCallExpression(node) &&
    node.questionDotToken === undefined &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === REPORTER
  );
}

/**
 * The work whose result may become an exit status: a call on a plain identifier,
 * optionally awaited.
 *
 * A *plain* identifier, so a member chain is not one. That is what refuses
 * `process.exit(await main().catch(() => 0))` — a `.catch` handler that returns
 * a number turns every failure into that number, and enumerating the handler
 * shapes that do would be a denylist. `main()` and `await main(process.argv)`
 * are what the fifteen entry points here actually write.
 */
function isWorkExpression(node) {
  const inner = unwrap(node);
  if (ts.isAwaitExpression(inner)) return isWorkExpression(inner.expression);
  return (
    ts.isCallExpression(inner) &&
    inner.questionDotToken === undefined &&
    ts.isIdentifier(inner.expression)
  );
}

/**
 * Names a statement list binds at its own top level, and why each is or is not
 * an exit status this rule will accept.
 *
 * A name reassigned anywhere in the list is refused whatever it was bound to:
 * `let code = await main(); if (process.env.CI) code = 0; process.exit(code);`
 * is the ternary with more lines.
 *
 * ── AND A NAME *REDECLARED* ANYWHERE IN IT (#40 round 8, D4) ────────────────
 * Round 7 recorded only the list's own top-level declarations and recognised
 * only `=`. A blind critic wrote the shadow instead of the assignment:
 *
 *     const code = await main();
 *     if (process.env.CI !== undefined) { const code = 0; process.exit(code); }
 *     process.exit(code);
 *
 * The inner `code` is a different binding in a nested block, so it was neither a
 * top-level declaration nor a reassignment, and the `process.exit(code)` inside
 * the branch resolved against a name this map said was the work. Accepted, and
 * biome accepts it too. So the question this asks is no longer "was it
 * reassigned with `=`" but "is this name, anywhere in this list at any depth,
 * ever bound or written a second time" — a redeclaration, a destructuring, a
 * parameter, a `catch` binding, `+=`, `??=`, `++`. One write is a binding; two
 * is a decision, and a decision is what may not live between the work and the
 * exit.
 */
function topLevelBindings(body) {
  const bindings = new Map();
  for (const statement of body) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      bindings.set(
        declaration.name.text,
        declaration.initializer !== undefined && isWorkExpression(declaration.initializer)
          ? undefined
          : `binds \`${declaration.name.text}\` to something other than the result of the work, and then exits with it`,
      );
    }
  }
  const poison = (name, why) => {
    if (bindings.has(name)) bindings.set(name, why);
  };
  for (const statement of body) {
    const visit = (node) => {
      if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && isAssignment(node)) {
        poison(
          node.left.text,
          `reassigns \`${node.left.text}\` after binding it, so what it exits with is decided somewhere between the two`,
        );
      }
      if (
        (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
        ts.isIdentifier(node.operand) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        poison(
          node.operand.text,
          `reassigns \`${node.operand.text}\` after binding it, so what it exits with is decided somewhere between the two`,
        );
      }
      // Every *other* binding of the same name, at any depth: a nested `const`,
      // a destructured element, a parameter, a `catch (code)`. `node.parent` is
      // the declaration the name belongs to, so a top-level declaration this
      // map already recorded is not counted twice.
      for (const name of boundNames(node)) {
        if (name.node === node && isTopLevelDeclarationOf(node, body)) continue;
        poison(
          name.text,
          `declares \`${name.text}\` a second time — a nested \`const ${name.text}\`, a parameter or a destructured binding shadows the one bound to the work, and \`process.exit(${name.text})\` inside that scope exits with the shadow. A block-scoped redeclaration is not a reassignment and satisfies every rule about \`=\``,
        );
      }
      node.forEachChild(visit);
    };
    visit(statement);
  }
  return bindings;
}

const ASSIGNMENT_OPERATORS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

function isAssignment(node) {
  return ASSIGNMENT_OPERATORS.has(node.operatorToken.kind);
}

/** Every identifier this node binds, as a declaration rather than a use. */
function boundNames(node) {
  const found = [];
  const add = (name) => {
    if (name === undefined) return;
    if (ts.isIdentifier(name)) {
      found.push({ text: name.text, node });
      return;
    }
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) add(element.name);
      }
    }
  };
  if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) {
    add(node.name);
  }
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) add(node.name);
  if (ts.isCatchClause(node)) add(node.variableDeclaration?.name);
  return found;
}

/** True when this declaration is one of `body`'s own top-level `const`s. */
function isTopLevelDeclarationOf(node, body) {
  if (!ts.isVariableDeclaration(node)) return false;
  const list = node.parent;
  return list !== undefined && list.parent !== undefined && body.includes?.(list.parent) === true;
}

/** Whether one `process.exit(x)` argument is a status this rule accepts. */
function statusProblem(argument, bindings, sourceFile) {
  const say = (what) =>
    `${what}. The exit status of an entry point must be the result of its work or a non-zero literal: \`process.exit(main())\`, \`process.exit(await main())\`, or \`process.exit(2)\` on a usage error. \`process.exit(0)\`, \`process.exit(cond ? await main() : 0)\` and \`process.exit(cond && main())\` all keep the sound predicate, keep an unconditional call in the body, satisfy every rule about statement *kind*, and exit 0 having asserted nothing`;
  if (argument === undefined) {
    return say('it calls `process.exit()` with no status at all, which is `process.exit(0)`');
  }
  const node = unwrap(argument);
  if (ts.isNumericLiteral(node)) {
    return node.text === '0' || Number(node.text) === 0
      ? say('it exits with the literal `0`, unconditionally')
      : undefined;
  }
  if (ts.isIdentifier(node)) {
    if (!bindings.has(node.text)) {
      return say(
        `it exits with \`${node.text}\`, which this rule cannot follow to the work: bind it at the guard body's own top level, as \`const ${node.text} = main();\``,
      );
    }
    const problem = bindings.get(node.text);
    return problem === undefined ? undefined : say(`it ${problem}`);
  }
  if (isWorkExpression(node)) return undefined;
  return say(
    `it exits with \`${text(sourceFile, node)}\`, whose value is decided by something other than the work`,
  );
}

/**
 * Every property of `process` that can decide what this run exited with.
 *
 * `exit` is the one allowed shape and is checked by `statusProblem`. The rest
 * have no allowed position at all in a file under `scripts/`, which is what
 * makes this an allowlist rather than a list of the tricks somebody has already
 * played: `exitCode` sets the status without terminating, and *any* listener
 * registration can run code after the terminator chose — an `exit` listener that
 * writes `process.exitCode = 0` turns a red run green while the annotations it
 * already printed stay on the page, which is louder than round 5's silence and
 * exactly as green.
 */
const STATUS_WRITE = new Set(['exitCode']);
const LISTENER_REGISTRATION = new Set([
  'on',
  'once',
  'addListener',
  'prependListener',
  'prependOnceListener',
]);

/** The property `node` accesses, when it is a member access with a fixed name. */
function memberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) {
    const argument = unwrap(node.argumentExpression);
    return argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : undefined;
  }
  return undefined;
}

/** The `process` object, however it is reached: `process`, `globalThis.process`. */
function isProcessObject(node) {
  const inner = unwrap(node);
  if (ts.isIdentifier(inner)) return inner.text === 'process';
  if (!ts.isPropertyAccessExpression(inner) && !ts.isElementAccessExpression(inner)) return false;
  if (memberName(inner) !== 'process') return false;
  const object = unwrap(inner.expression);
  return ts.isIdentifier(object) && object.text === 'globalThis';
}

/** The member access this node is the object of, looking through parentheses. */
function accessOf(node) {
  let current = node;
  while (current.parent !== undefined && ts.isParenthesizedExpression(current.parent)) {
    current = current.parent;
  }
  const parent = current.parent;
  if (parent === undefined) return undefined;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === current) return parent;
  if (ts.isElementAccessExpression(parent) && parent.expression === current) return parent;
  return undefined;
}

/** The call this node is the callee of, looking through parentheses. */
function calleeOf(node) {
  let current = node;
  while (current.parent !== undefined && ts.isParenthesizedExpression(current.parent)) {
    current = current.parent;
  }
  const parent = current.parent;
  return parent !== undefined && ts.isCallExpression(parent) && parent.expression === current
    ? parent
    : undefined;
}

/** The nearest statement list around `node`, which is where its names are bound. */
function enclosingStatements(node) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isBlock(current) || ts.isSourceFile(current)) return current.statements;
    if (ts.isCaseClause(current) || ts.isDefaultClause(current)) return current.statements;
  }
  return [];
}

/**
 * The exit status of the whole file, wherever in it the decision is written.
 *
 * ── THE SCOPE, AS A SENTENCE (#40 round 8, D1/D2) ───────────────────────────
 * *Every node of this file, at every nesting depth, inside functions and outside
 * them.* Not "the guard body" — which is the scope round 7 gave the same
 * allowlist and did not write down, and which one statement one line above the
 * guard walks straight past for the price of round 5 and the result of round 5.
 *
 * `skip` is the guard bodies whose status `exitProblem` has already reported on,
 * so a body ending `process.exit(0)` is one message rather than two.
 */
function exitMachineryProblems(sourceFile, path, skip = []) {
  const problems = [];
  const inSkipped = (node) => {
    for (let current = node; current !== undefined; current = current.parent) {
      if (skip.includes(current)) return true;
    }
    return false;
  };
  const say = (node, what) => problems.push(`${path}:${line(sourceFile, node)} ${what}`);

  // `import proc from 'node:process'` binds the same object under a name this
  // rule cannot follow, which is the aliasing hole one import further out.
  // Found attacking this round's own fix: the identifier rule below closes
  // `const p = process`, and closing it there and not here would be a rule about
  // one of the two ways to spell the same thing.
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) continue;
    if (specifier.text === 'node:process' || specifier.text === 'process') {
      say(
        statement,
        `imports \`${specifier.text}\`, which binds the process object under a name of this file's choosing. Every rule here about how the exit status may be spelled reads \`process.exit\`; a second name for the same object walks past all of them. The global is always available in a module — reach for it there.`,
      );
    }
  }

  const visit = (node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === 'process' &&
      accessOf(node) === undefined &&
      // `globalThis.process` and `{ process: … }` spell the word in a position
      // that is a *name*, not a reference to the object.
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
      !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
      !ts.isImportSpecifier(node.parent) &&
      !ts.isExportSpecifier(node.parent)
    ) {
      // Not the object of a member access, so it is the object itself changing
      // hands: `const p = process;`, `f(process)`, `const { exit } = process;`.
      // The rule above is about `process.exit`; a rule about a *spelling* is
      // defeated by a second name for the same object, which is the
      // lookalike-module defect with no import in it.
      say(
        node,
        'names `process` as a value rather than as the object of a member access. `const p = process; p.exit(0);` is `process.exit(0)` with the name filed off, and every rule about how the exit status is spelled is defeated by a second name for the same object. Reach for `process.env`, `process.argv` and the rest through `process` itself.',
      );
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = memberName(node);
      if (name !== undefined && isProcessObject(node.expression)) {
        if (STATUS_WRITE.has(name)) {
          say(
            node,
            `writes the exit status through \`process.${name}\`, which no file under scripts/ may. It sets what the run exited with *without* terminating, so it survives every rule about what \`process.exit\` may carry — \`process.on('exit', () => { process.exitCode = 0; })\` was measured to leave a self-test printing three \`::error::\` lines about a real regression and exiting 0. The status of an entry point is \`process.exit(main())\` and nothing else.`,
          );
        } else if (LISTENER_REGISTRATION.has(name)) {
          say(
            node,
            `registers a \`process.${name}\` listener. A listener runs after the terminator has already chosen a status and can replace it — that is node's documented behaviour for \`exit\`, and naming the events that cannot would be a denylist of exactly the kind this file refuses. A script under scripts/ decides its status once, in \`process.exit(main())\`.`,
          );
        } else if (name === 'exit') {
          const call = calleeOf(node);
          if (call === undefined) {
            say(
              node,
              'refers to `process.exit` without calling it. A reference is an alias waiting for a name — `const done = process.exit; done(0);` — and the status allowlist can only read a call it can see.',
            );
          } else if (!inSkipped(call)) {
            const problem = statusProblem(
              call.arguments[0],
              topLevelBindings(enclosingStatements(call)),
              sourceFile,
            );
            if (problem !== undefined) say(call, problem);
          }
        } else if (name === 'argv' && writesTo(node)) {
          say(
            node,
            'assigns to `process.argv`, which is the only input the main-module guard has. Rewriting it above the guard makes `isMainModule(import.meta.url)` false with the guard untouched and every rule about the guard satisfied.',
          );
        }
      }
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return problems;
}

/** True when this expression is written to rather than read. */
function writesTo(node) {
  let current = node;
  while (current.parent !== undefined) {
    const parent = current.parent;
    if (ts.isBinaryExpression(parent) && isAssignment(parent) && parent.left === current)
      return true;
    if (
      (ts.isPostfixUnaryExpression(parent) || ts.isPrefixUnaryExpression(parent)) &&
      parent.operand === current
    ) {
      return true;
    }
    // `process.argv[1] = x` writes through an element access on this node.
    if (ts.isElementAccessExpression(parent) && parent.expression === current) {
      current = parent;
      continue;
    }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === current) {
      current = parent;
      continue;
    }
    return false;
  }
  return false;
}

/** An empty `catch` in an entry point turns every failure into exit 0. */
function swallowsFailure(statement) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isCatchClause(node) && node.block.statements.length === 0) {
      found = true;
      return;
    }
    node.forEachChild(visit);
  };
  visit(statement);
  return found;
}

/**
 * A statement that cannot have an effect however it is reached.
 *
 * `{}` was the only shape the first version refused; a blind review pointed out
 * that `{ void 0; }`, `{ debugger; }` and `{ 0; }` are the same guard with
 * punctuation in it. This is still a *syntactic* claim and stops well short of
 * "the body asserts something" — `process.exit(0)` is a real statement with a
 * real effect and this accepts it, which is the semantics boundary the SCOPE
 * block owns and not something a scanner can take from it.
 */
function doesNothing(statement) {
  if (ts.isEmptyStatement(statement) || statement.kind === ts.SyntaxKind.DebuggerStatement) {
    return true;
  }
  if (!ts.isExpressionStatement(statement)) return false;
  const expression = unwrap(statement.expression);
  if (ts.isVoidExpression(expression)) return true;
  return (
    ts.isIdentifier(expression) ||
    ts.isLiteralExpression(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword
  );
}

/**
 * Parentheses are not a spelling. `if ((isMainModule(import.meta.url)))` is the
 * guard; refusing it was a false red a blind review measured.
 */
function unwrap(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
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
  const condition = unwrap(statement.expression);
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
      // `isMainModule?.(…)` short-circuits to `undefined` — falsy — if the
      // binding is ever not a function, which is a guard with a fuse in it.
      condition.questionDotToken === undefined &&
      ts.isIdentifier(condition.expression) &&
      condition.expression.text === 'isMainModule' &&
      condition.arguments.length === 1 &&
      condition.arguments[0] !== undefined &&
      isImportMetaUrl(unwrap(condition.arguments[0]))
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
  // From here the body's own statuses are this function's business, so the
  // file-wide pass is told not to report them a second time.
  const checkedBody = statement.thenStatement;
  const exit = exitProblem(statement.thenStatement, statement.getSourceFile());
  if (exit !== undefined) {
    return { node: statement, reason: exit, checkedBody };
  }
  if (swallowsFailure(statement.thenStatement)) {
    return {
      node: statement,
      reason:
        'it has an empty `catch` in its body, which turns every failure the script can have into exit 0 — the fail-open this whole file is about, spelled as error handling',
    };
  }
  // The unwrapped call, not `statement.expression`: with parentheses round the
  // condition those are different nodes, and the caller needs the one that has
  // `arguments` on it.
  return { node: statement, call: condition, checkedBody };
}

/** Every binding of `name` this file imports, and where from. */
function importedSources(sourceFile, name) {
  const sources = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (clause?.namedBindings === undefined || !ts.isNamedImports(clause.namedBindings)) continue;
    for (const element of clause.namedBindings.elements) {
      // `import { report as r }` binds `r`; `import { x as report }` binds
      // `report` to whatever `x` is. The *local* name is what the guard body
      // calls, so that is the one this asks about.
      if (element.name.text !== name) continue;
      const specifier = statement.moduleSpecifier;
      sources.push(ts.isStringLiteral(specifier) ? specifier.text : '(computed)');
    }
  }
  return sources;
}

/** A local declaration of `name` — the shared thing replaced by a local one. */
function declaresLocally(sourceFile, name) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    const named =
      ts.isFunctionDeclaration(node) ||
      ts.isVariableDeclaration(node) ||
      ts.isClassDeclaration(node);
    if (named && node.name !== undefined && ts.isIdentifier(node.name)) {
      if (node.name.text === name) {
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
 * Where a shared binding a guard depends on must come from.
 *
 * The same path rule as `GUARD_SPECIFIER`, and for the same reason: a *name* was
 * checked where a *location* was meant once already in this file, and `report`
 * is now load-bearing — it is the terminator six of these scripts end on, and a
 * `report` from somewhere else is `process.exit(0)` with a friendly name.
 */
function sharedBindingProblems(sourceFile, path, name, module, specifierPattern) {
  const problems = [];
  const sources = importedSources(sourceFile, name);
  if (sources.length === 0) {
    problems.push(
      `${path} calls \`${name}\` in its main-module guard without importing it from scripts/ci/${module}. Whatever it resolves to then, it is not the shared one, and the guard body's whole meaning rests on it.`,
    );
  } else if (!sources.every((specifier) => specifierPattern.test(specifier))) {
    problems.push(
      `${path} imports \`${name}\` from ${sources.join(', ')}, which is not the shared module. It must be \`./${module}\` — or \`../\`-prefixed for a script in a subdirectory — and nothing else: \`./vendor/${module}\`, \`/tmp/${module}\` and a bare \`${module}\` (a *package* name in ESM) are all different modules that can return whatever they like, and a guard over one of them is green here and silent in CI.`,
    );
  }
  if (declaresLocally(sourceFile, name)) {
    problems.push(
      `${path} declares its own \`${name}\`, shadowing the imported one. The guard then means whatever this file wants it to.`,
    );
  }
  return problems;
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
  /** Guard bodies whose exit statuses `exitProblem` has already reported on. */
  const checkedBodies = [];
  // `import.meta` nodes that have already been spoken for: the argument of a
  // sound guard, and everything in the condition of an unsound one, which has
  // just been reported by name. Without the second the same line is reported
  // twice, once as a bad guard and once as a stray `import.meta`.
  const accounted = new Set();
  for (const statement of sourceFile.statements) {
    const shape = guardShape(statement);
    if (shape === undefined) continue;
    if (shape.checkedBody !== undefined) checkedBodies.push(shape.checkedBody);
    if (shape.reason === undefined) {
      guards.push(shape.call);
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

  for (const call of guards) {
    // `unwrap`, because `isMainModule((import.meta.url))` reaches the same node
    // through a ParenthesizedExpression and it is the same `import.meta`.
    accounted.add(unwrap(call.arguments[0]).expression);
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
        if (isEntryArgv(unwrap(side), sourceFile)) {
          problems.push(
            `${path}:${line(sourceFile, node)} compares an \`argv\` element for equality (\`${text(sourceFile, node)}\`). Whatever it is compared against, that is the round-4 guard with the other half renamed. ${BROKEN_GUARD_ADVICE}`,
          );
        }
      }
    }
    node.forEachChild(argvVisit);
  };
  sourceFile.forEachChild(argvVisit);

  // And the whole file, not just the twelve lines the guard happens to be in.
  problems.push(...exitMachineryProblems(sourceFile, path, checkedBodies));

  // The predicate has to be the shared one — and so does the reporter, when the
  // guard body ends on it. `report` from anywhere else is `process.exit(0)`
  // wearing the name of the thing that decides the exit status for six of these
  // scripts, which is the lookalike-module defect one function over.
  if (guards.length > 0) {
    problems.push(
      ...sharedBindingProblems(sourceFile, path, 'isMainModule', GUARD_MODULE, GUARD_SPECIFIER),
    );
    if (usesReporterAsTerminator(guards)) {
      problems.push(
        ...sharedBindingProblems(sourceFile, path, REPORTER, REPORTER_MODULE, REPORTER_SPECIFIER),
      );
    }
  }

  return problems;
}

/** True when some sound guard's body ends on `report('…')`. */
function usesReporterAsTerminator(guards) {
  return guards.some((call) => {
    const body = call.parent.thenStatement;
    const statements = ts.isBlock(body) ? body.statements : [body];
    const last = statements[statements.length - 1];
    return (
      last !== undefined &&
      ts.isExpressionStatement(last) &&
      isReporterCall(unwrap(last.expression))
    );
  });
}

/**
 * An element of *some* `argv`, however it is reached.
 *
 * Stated plainly: this half is a **denylist**, and a denylist has a bound. The
 * allowlist above — `import.meta` may appear in exactly one place — is the real
 * rule and needs no help; this exists only so that the round-4 comparison
 * rewritten to avoid naming `import.meta` is still refused. The first version
 * matched `process.argv[1]` literally, and a blind review measured the four
 * spellings that walks past: `process['argv'][1]`, `process.argv[1+0]`,
 * `globalThis.process.argv[1]`, `process.argv["1"]`. Rather than list four more,
 * the object side is now "anything whose text names `argv`" and the index is not
 * read at all — inside an equality comparison, that is never a thing anyone
 * should be writing.
 */
function isEntryArgv(node, sourceFile) {
  if (!ts.isElementAccessExpression(node)) return false;
  // The *object*, not the index. `process.argv[1 + 0]` and `process.argv["1"]`
  // both reach the entry path and constant-folding an index is a road with no
  // end; a comparison against any element of `process.argv` is the shape.
  // Rooted at `process` specifically, which is what keeps the twelve legitimate
  // `argv[0] !== 'node'` comparisons in this repository's own shell parser out
  // of it — measured: widening this to "anything naming argv" reported all
  // twelve, which is how a denylist becomes a nuisance and then gets deleted.
  return PROCESS_ARGV.test(node.expression.getText(sourceFile).replace(/\s+/g, ''));
}

const PROCESS_ARGV = /(?:^|\.)process(?:\.argv|\[['"]argv['"]\])$/;

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
