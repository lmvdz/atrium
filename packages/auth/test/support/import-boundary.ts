/**
 * An import-boundary checker that resolves what a module actually pulls in.
 *
 * ## Two halves, two different guarantees — read this before quoting either
 *
 * This file answers two questions, and round 9 exists because rounds 7 and 8
 * described them as one thing.
 *
 *  1. **The import half is an invariant.** "No file under a forbidden root can
 *     reach the forbidden binding by importing it" — through any specifier
 *     shape, any re-export chain, any wrapper in any package, resolved to a
 *     fixpoint over the whole module graph. Nothing about it is best-effort;
 *     where it cannot resolve something it *reports* rather than shrugging.
 *
 *  2. **The access half is a best-effort check, not an invariant.** It catches
 *     the table reached off a database handle — `db.query.memberships` and the
 *     shapes around it — which no import rule can observe. It finds the handle
 *     *syntactically*, and there are shapes it cannot follow. A clean run means
 *     "none of the shapes this check knows about are present". It does not mean
 *     "the table is not reached off a handle in this tree".
 *
 * The round-8 receipt said the access half traced a handle "through
 * assignments". It traces through *initializers* — which is less, and the
 * header below already admitted as much three paragraphs down, so the file
 * contradicted its own summary.
 *
 * **Round 9 then narrowed the claim to five shapes, and the narrowing was
 * itself inaccurate.** The round-9 delta produced a sixth —
 * `const db = cond ? createDatabase() : createDatabase()` — which no fixture
 * covered, because `isHandle` had no `ConditionalExpression` case. Best-effort
 * is acceptable only when its stated limits are true, so round 10 stopped
 * enumerating from the code and enumerated from the *grammar*: every expression
 * form that passes a value through, and every declaration form that carries
 * one. That found six more and closed all seven.
 *
 * ### What an initializer may be, and is now followed through
 *
 * Grouped by why each one is a pass-through rather than a new value:
 *
 *  - **Wrappers that erase**: parentheses, `await`, `!`, `as T`,
 *    `satisfies T`, `<T>x`, and a `PartiallyEmittedExpression`.
 *  - **Choices**: `cond ? a : b`, `a ?? b`, `a || b`, `a && b` — *either* side
 *    is enough, because a value that is a handle down one path is a handle.
 *  - **Sequences and assignments**: `(x, y)` and a comma list evaluate to the
 *    right operand — which is what `(0, createDatabase)()` relies on — and so
 *    do `=`, `??=`, `||=` and `&&=`.
 *  - **Everything else binary answers no.** `+`, `===`, `in`, `instanceof` and
 *    the rest build a new primitive, so a handle mentioned inside one is not a
 *    handle. Without that restriction this becomes "any expression mentioning a
 *    connection", which is the round-7 noise the receiver test removed.
 *  - **Calls**: a call yields a handle when the callee does (`createDatabase()`,
 *    `db()`, `handle().db`), plus `await import(…)` / `require(…)` of a module
 *    that exposes one — which covers an IIFE, since its callee is a function
 *    whose returns are asked.
 *  - **Declaration forms**: a variable initializer, an annotated parameter, a
 *    **parameter default**, a binding element and its **own default**, and a
 *    function declaration's return type or returned expressions. A default is
 *    an initializer written at the declaration site, which round 9 read only
 *    for variables — so `function load(db = createDatabase())` needed neither an
 *    annotation nor a second statement.
 *  - **Binding patterns in parameter position**: `collectAccesses` asked its
 *    destructuring question of variable declarations only, so
 *    `function load({ memberships }: Database)` took the table off a handle with
 *    nothing reported. A pattern is a pattern wherever it is written.
 *  - **`export default <expression>`** in the handle graph: `readModule`
 *    recorded named and star re-exports and not `ExportAssignment`, so one line
 *    in any package could launder a connection to every importer.
 *
 * **Four shapes still walk past it**, each with a fixture in
 * `room-access.test.ts` under "the access half does not see these, and says so":
 *
 *  - a handle held in a **class field** (`this.db.query.memberships`);
 *  - a handle held in an **object property** (`holder.db…`), however built;
 *  - a handle **assigned after its declaration** (`let d; d = createDatabase()`),
 *    where the declaration site has no initializer to read;
 *  - a handle in a **container** — an array element, a `Map` value;
 *  - a handle arriving as an **un-annotated parameter the caller supplies**,
 *    including a callback's. (Five bullets, four kinds: the first two and the
 *    container are one missing capability — a model of what an object holds.)
 *
 * Those fixtures assert that nothing is reported, so they go red the moment a
 * future round closes one — which forces this header to be corrected in the
 * same commit rather than quietly becoming false. They are also receiver
 * controls: `boundary-blind-receiver` and `r7-access-analysis` each fail on
 * them too, since a receiver-blind check reports every one.
 *
 * **Why these four are still open, and it is no longer a cost argument.** Round
 * 9 said the closable ones were merely more work and not worth the surface. The
 * ones left need something a syntactic pass does not have: a model of object and
 * container *values* for the first three, and a type checker for the last. What
 * makes the remainder worth keeping is the control beside those fixtures: every
 * gap is about *finding* the handle, and none is the check failing on one it has
 * found.
 *
 * ## Why this is not a grep
 *
 * Round 6 asserted "no file under `apps/` imports `memberships` from
 * `@atrium/db`" with a regex over `import { … } from '@atrium/db'`. That check
 * is the thing keeping the authorization class closed — the read has to stay in
 * `room-access.ts`, where it joins `workspace_members` — and the round-6
 * gauntlet pointed out it was defeatable by punctuation. Every one of these
 * walks straight past a regex:
 *
 *  - `import * as db from '@atrium/db'` — then `db.memberships`;
 *  - `import { memberships } from '@atrium/db/schema'` — a declared subpath;
 *  - `const { memberships } = await import('@atrium/db')`;
 *  - `export { memberships } from '@atrium/db'` in one app file, a plain
 *    relative import in the next;
 *  - a helper in some *other* package that queries the table itself and is
 *    re-exported, so the app never names `@atrium/db` at all.
 *
 * A rule that a rename or a formatter can switch off is not a rule. So this
 * parses with TypeScript's own parser, resolves specifiers to files, and
 * propagates *reachability* to a fixpoint: the question it answers is not "does
 * this line match" but "can this module get to the table from here".
 *
 * ## The model
 *
 * Each module carries a taint — the set of exported names that are, or derive
 * from, the forbidden binding — plus an `all` flag meaning *every* export is
 * suspect. Three rules, applied until nothing changes:
 *
 *  1. **Re-export propagates by name.** `export { memberships as m } from S`
 *     taints `m`; `export * from S` inherits S's whole set.
 *  2. **Importing the taint makes a module a toucher.** A toucher that is not on
 *     the allowlist has `all` set, because a module that holds the table can
 *     wrap it in a helper and export that instead — which is the evasion a
 *     name-only rule cannot see. This is the rule that costs the most and buys
 *     the most: it is why a hypothetical `packages/db/src/helpers.ts` could not
 *     launder the table through a function.
 *  3. **The allowlist is the point of the exercise.** A module on it may hold
 *     the table and still export safely, because a human decided that its reads
 *     are the joined ones and its writes are the locked ones. The list is short
 *     and each entry carries its reason at the call site (`room-access.test.ts`);
 *     it is the invariant stated positively — these files, and no others.
 *
 * A forbidden-root file is then an offender if it names a tainted export, or if
 * it takes a namespace / dynamic / `require` handle on a module with any taint
 * at all — those hand over the whole module object, so there is no name to check
 * and the conservative answer is the only sound one.
 *
 * ## Deliberate strictness, in two places
 *
 * **Type-only imports count.** They are erased, so `import type { memberships }`
 * genuinely cannot run a query — and it is still an offence here. An exemption
 * is a case every future reader has to hold in their head while deciding whether
 * a diff is safe, and a type-only import of a table object has no use that is
 * not a step towards the value import. The strict rule costs nothing real: no
 * app needs the type, and the row types it would want are exported by
 * `@atrium/auth`.
 *
 * **An unresolvable subpath resolves to its package root.** `@atrium/db/nope`
 * does not exist, so a lenient resolver would return null and wave it through —
 * inventing a subpath would be the cheapest evasion of the lot. It inherits the
 * package's taint instead.
 *
 * ## The one hole an import rule cannot see, and what closes it
 *
 * `packages/db/src/client.ts` takes `import * as appSchema from './schema.js'`
 * because that is how a drizzle handle is given its relational metadata, and it
 * is on the allowlist for that reason: what it hands out is a database
 * connection, which every app legitimately holds, rather than a wrapper around
 * one table. But registering the schema is also what makes `db.query.memberships`
 * exist — the table reached by *property name* off a handle, with no import
 * anywhere. No import-boundary rule can see that, so `forbiddenAccessName` adds a
 * second, narrower question to the same AST walk: does any file under a forbidden
 * root name the table at all.
 *
 * ## The access half: what round 7 got wrong in both directions
 *
 * Round 7 asked that question of *any* property access. Too narrow and too wide
 * at once, and the round-7 gauntlet said so on both counts.
 *
 * **Too narrow.** It looked at property and element access only, so two shapes
 * walked past it. `const { memberships: rows } = db().query` binds the table
 * without ever writing a property access — no forbidden import, no reported
 * access, and `rows.findMany()` reads unjoined membership in an app.
 * `db().query['member' + 'ships']` is the same read with the key computed, which
 * the literal-key test could not see either.
 *
 * **Too wide.** It flagged `anything.memberships` — a response body, a domain
 * object, a React prop — because it never asked *what the receiver was*. A check
 * that fails on `workspace.memberships` in a view teaches people to rename their
 * fields, and a rule people work around is not a rule.
 *
 * Both are the same missing question, so both have the same answer: follow the
 * handle. The access analysis now asks whether the receiver is rooted in a
 * **database handle** — a value this repository's own module graph says came out
 * of the package that declares the table — and reports:
 *
 *  - the table named as a property or a string index off such a receiver;
 *  - the table destructured out of one, renamed or nested;
 *  - *any* computed key off one, because `db.query[x]` cannot be resolved and a
 *    handle is not a thing an app should be indexing dynamically. This is the
 *    one conservative rule here, and it is affordable precisely because it is
 *    asked only of handles.
 *
 * A handle is tracked from where it enters a file — an import of the declaring
 * package, or of a module that exposes one — through every initializer form
 * enumerated at the top of this file. A module exposes a handle when it
 * re-exports one, when it exports a binding derived from one, when it exports a
 * function annotated as returning one (`apps/web/lib/db.ts`'s
 * `export function db(): Database`, which is how both apps actually get theirs),
 * or when its `export default` expression is one.
 *
 * Read "initializers", not "assignments", and see the top of this file for the
 * four kinds of shape that walk past that list. Round 8's receipt said
 * "assignments" and the round-8 delta was right to call it:
 * `let d; d = createDatabase()` is an assignment and is not followed. Round 9
 * corrected the wording; round 10 corrected the list the wording pointed at.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath, sep } from 'node:path';
import ts from 'typescript';

export interface BoundaryRule {
  /** Absolute path to the repository root. */
  root: string;
  /** Where the forbidden binding is declared, relative to `root`. */
  declaredIn: string;
  /** Its exported name in that file. */
  exportName: string;
  /** Directories, relative to `root`, whose files may not reach it. */
  forbiddenRoots: string[];
  /**
   * Directories, relative to `root`, that are parsed to build the module graph.
   * Wider than `forbiddenRoots`: the graph has to include the packages, or a
   * helper laundered through one of them would be invisible.
   */
  graphRoots: string[];
  /**
   * Modules, relative to `root`, that may hold the binding without tainting
   * what they export. The vetted readers.
   */
  allowed: string[];
  /** Directory names never descended into. */
  skipDirs?: string[];
  /** Package scope that maps onto `packages/<name>`. */
  workspaceScope?: string;
  /**
   * The table's name as a *property*, which forbidden-root files may not reach
   * off a database handle.
   *
   * The companion to the import analysis, for the table reached off a handle —
   * `db.query.memberships`, `db['query']['memberships']`,
   * `const { memberships } = db().query` — which no import rule can observe. See
   * the header for what counts as a handle and why the question is asked about
   * the receiver rather than about every property in the tree.
   */
  forbiddenAccessName?: string;
  /**
   * Type names that mean "this value is a database handle".
   *
   * The cheap half of the data flow, and the one that carries this repository:
   * `apps/web/lib/db.ts` exports `function db(): Database`, and a parameter
   * written `db: Database` is how every function here takes one. An annotation
   * is not proof, but it is a *statement by the author*, which is a better
   * signal than any heuristic available to a syntactic pass.
   */
  handleTypeNames?: string[];
}

export type OffenceKind =
  | 'named-import'
  | 'default-import'
  | 'namespace-import'
  | 'dynamic-import'
  | 'require'
  | 'import-equals'
  | 'named-reexport'
  | 'star-reexport'
  | 'namespace-reexport';

export interface BoundaryOffence {
  /** The offending file, relative to `root`. */
  file: string;
  /** The specifier as written. */
  specifier: string;
  /** The module it resolved to, relative to `root`. */
  via: string;
  /** The name it named, or `*` where it took the whole module. */
  binding: string;
  kind: OffenceKind;
  line: number;
}

/** A dynamic `import()` / `require()` whose specifier is not a literal. */
export interface ComputedSpecifier {
  file: string;
  kind: 'dynamic-import' | 'require';
  line: number;
}

/** How a forbidden-root file reached the table off a database handle. */
export type AccessKind =
  /** `db.query.memberships` */
  | 'property'
  /** `db.query['memberships']` */
  | 'string-index'
  /** `const { memberships } = db().query`, renamed or nested */
  | 'destructured'
  /** `db.query['member' + 'ships']` — a key this analysis cannot resolve */
  | 'computed-key';

/** A forbidden-root file reaching the table off a database handle. */
export interface MemberAccess {
  file: string;
  line: number;
  kind: AccessKind;
  /** The access as written, for the failure message. */
  text: string;
}

interface Taint {
  names: Set<string>;
  all: boolean;
}

interface Reference {
  specifier: string;
  kind: OffenceKind;
  /** Imported/re-exported source names; empty when the whole module is taken. */
  names: { source: string; exported: string }[];
  /** True when the reference hands over the module object rather than names. */
  whole: boolean;
  line: number;
}

/**
 * What a file says about database handles, collected in one walk.
 *
 * Separate from `Reference` on purpose: the import half has five rounds of tests
 * behind it and answers a different question (which *names* arrive here), while
 * this one needs the local identifier a namespace or default import binds so a
 * receiver can be traced back to it.
 */
interface HandleFacts {
  /** Local binding name → the module and export it came from (`*` = the module). */
  imported: Map<string, { specifier: string; name: string }>;
  /** Local binding name → the node that declares it. */
  declared: Map<string, ts.Node>;
  /** Exported name → the local binding behind it. */
  exportedLocals: Map<string, string>;
  /**
   * `export default <expression>`, which binds no local name at all.
   *
   * Kept apart from `exportedLocals` for exactly that reason: there is nothing
   * to look up, so the expression itself has to be asked. Without it a package
   * could launder a connection in one line — `export default createDatabase()`
   * — and the importing app's `handle.query.memberships` had no handle to be
   * rooted in.
   */
  defaultExport?: ts.Expression;
}

interface Module {
  /** Relative to `root`. */
  path: string;
  absolute: string;
  source: ts.SourceFile;
  imports: Reference[];
  reexports: Reference[];
  computed: ComputedSpecifier[];
  handles: HandleFacts;
}

const DEFAULT_SKIP = [
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
  'test-results',
  'test',
  'e2e',
  'drizzle',
];

const SOURCE = /\.(?:tsx?|mts|cts)$/;

/** See {@link BoundaryRule.handleTypeNames}. */
const DEFAULT_HANDLE_TYPES = ['Database'];

function collectSourceFiles(dir: string, skip: string[], out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skip.includes(entry.name)) continue;
      collectSourceFiles(path, skip, out);
    } else if (SOURCE.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
}

function scriptKind(file: string): ts.ScriptKind {
  return file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/** Does this declaration carry an `export` modifier? */
function isExported(node: ts.Node | undefined): boolean {
  if (!node || !ts.canHaveModifiers(node)) return false;
  return (ts.getModifiers(node) ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

/** Does this declaration carry a `default` modifier? */
function isDefaultExported(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return (ts.getModifiers(node) ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
  );
}

/** Does this type annotation name one of the handle types? */
function referencesHandleType(type: ts.TypeNode | undefined, names: readonly string[]): boolean {
  if (!type) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isTypeReferenceNode(node)) {
      const name = ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.right.text;
      if (names.includes(name)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(type);
  return found;
}

/** The `return` expressions of a function, ignoring any nested inside it. */
function returnedExpressions(fn: ts.SignatureDeclaration): ts.Expression[] {
  const out: ts.Expression[] = [];
  const body = (fn as { body?: ts.Node }).body;
  if (!body) return out;
  if (!ts.isBlock(body)) {
    // A concise arrow body is one big return expression.
    out.push(body as ts.Expression);
    return out;
  }
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) out.push(node.expression);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return out;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/** Everything one file pulls in or passes on, as an AST question. */
function readModule(absolute: string, path: string): Module {
  const text = readFileSync(absolute, 'utf8');
  const source = ts.createSourceFile(
    absolute,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(absolute),
  );
  const module: Module = {
    path,
    absolute,
    source,
    imports: [],
    reexports: [],
    computed: [],
    handles: { imported: new Map(), declared: new Map(), exportedLocals: new Map() },
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const line = lineOf(source, statement);
      const clause = statement.importClause;
      // A bare `import 'x'` binds nothing, so it cannot reach the table.
      if (!clause) continue;
      if (clause.name) {
        module.handles.imported.set(clause.name.text, { specifier, name: 'default' });
        module.imports.push({
          specifier,
          kind: 'default-import',
          names: [{ source: 'default', exported: clause.name.text }],
          whole: false,
          line,
        });
      }
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        module.handles.imported.set(bindings.name.text, { specifier, name: '*' });
        module.imports.push({
          specifier,
          kind: 'namespace-import',
          names: [],
          whole: true,
          line,
        });
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          module.handles.imported.set(element.name.text, {
            specifier,
            name: (element.propertyName ?? element.name).text,
          });
        }
        module.imports.push({
          specifier,
          kind: 'named-import',
          names: bindings.elements.map((element) => ({
            source: (element.propertyName ?? element.name).text,
            exported: element.name.text,
          })),
          whole: false,
          line,
        });
      }
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      const line = lineOf(source, statement);
      const from = statement.moduleSpecifier;
      if (!from || !ts.isStringLiteral(from)) {
        // A local `export { a, b }`. It re-exports bindings this file already
        // holds, so rule 2 (any toucher taints everything) covers it for the
        // *table*; there is no specifier to resolve here. For handles it does
        // matter which local binding is behind which exported name, because a
        // module that exports a handle it holds is a module the next one gets a
        // handle from.
        const local = statement.exportClause;
        if (local && ts.isNamedExports(local)) {
          for (const element of local.elements) {
            module.handles.exportedLocals.set(
              element.name.text,
              (element.propertyName ?? element.name).text,
            );
          }
        }
        continue;
      }
      const specifier = from.text;
      const clause = statement.exportClause;
      if (!clause) {
        module.reexports.push({ specifier, kind: 'star-reexport', names: [], whole: true, line });
      } else if (ts.isNamespaceExport(clause)) {
        module.reexports.push({
          specifier,
          kind: 'namespace-reexport',
          names: [{ source: '*', exported: clause.name.text }],
          whole: true,
          line,
        });
      } else {
        module.reexports.push({
          specifier,
          kind: 'named-reexport',
          names: clause.elements.map((element) => ({
            source: (element.propertyName ?? element.name).text,
            exported: element.name.text,
          })),
          whole: false,
          line,
        });
      }
      continue;
    }

    if (ts.isExportAssignment(statement) && statement.isExportEquals !== true) {
      module.handles.defaultExport = statement.expression;
      if (ts.isIdentifier(statement.expression)) {
        module.handles.exportedLocals.set('default', statement.expression.text);
      }
      continue;
    }

    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      ts.isStringLiteral(statement.moduleReference.expression)
    ) {
      module.imports.push({
        specifier: statement.moduleReference.expression.text,
        kind: 'import-equals',
        names: [],
        whole: true,
        line: lineOf(source, statement),
      });
    }
  }

  // `import()` and `require()` are expressions, so they can be anywhere — inside
  // a function, a ternary, a template. The whole tree gets walked for them, and
  // for the declarations the handle analysis needs.
  const visit = (node: ts.Node): void => {
    /**
     * Every name this file binds, flat.
     *
     * Flat, and therefore blind to shadowing: a file that rebinds `db` inside a
     * block to something that is not a handle would be read as still holding
     * one. That errs towards reporting, which is the right direction for a
     * boundary check, and no file in this repository does it.
     */
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      module.handles.declared.set(node.name.text, node);
      if (isExported(node.parent?.parent)) {
        module.handles.exportedLocals.set(node.name.text, node.name.text);
      }
    }
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      module.handles.declared.set(node.name.text, node);
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      module.handles.declared.set(node.name.text, node);
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      module.handles.declared.set(node.name.text, node);
      if (isExported(node)) {
        module.handles.exportedLocals.set(node.name.text, node.name.text);
        // `export default function db(): Database {}` — one declaration under
        // two exported names, and only the second one an importer can name.
        if (isDefaultExported(node)) module.handles.exportedLocals.set('default', node.name.text);
      }
    }
    if (ts.isFunctionDeclaration(node) && !node.name && isDefaultExported(node)) {
      // `export default function (): Database {}` — anonymous, so there is no
      // local name; the expression path handles it.
      module.handles.defaultExport = node as unknown as ts.Expression;
    }
    if (ts.isCallExpression(node)) {
      const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamic || isRequire) {
        const kind = isDynamic ? 'dynamic-import' : 'require';
        const [argument] = node.arguments;
        const line = lineOf(source, node);
        if (argument && ts.isStringLiteral(argument)) {
          module.imports.push({ specifier: argument.text, kind, names: [], whole: true, line });
        } else if (argument) {
          // Not resolvable, and not ignorable: a computed specifier is the one
          // shape this analysis cannot follow, so it is reported rather than
          // skipped. The invariant test asserts there are none.
          module.computed.push({ file: path, kind, line });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);

  return module;
}

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** `./room-access.js` → `./room-access.ts`, `./thing` → `./thing/index.ts`. */
function resolveFilePath(base: string): string | null {
  const withoutJs = base.replace(/\.(m|c)?js$/, '');
  const candidates: string[] = [];
  for (const extension of EXTENSIONS) {
    candidates.push(withoutJs + extension);
    candidates.push(join(withoutJs, `index${extension}`));
  }
  candidates.push(base);
  return firstExisting(candidates);
}

/**
 * Every way a file reaches the forbidden name off a database handle.
 *
 * Four shapes, and the reason there are four is that round 7 handled two of them
 * and the round-7 gauntlet demonstrated both of the others as working evasions.
 * The receiver test is what all four share, and what keeps a domain object's
 * `.memberships` out of the results.
 *
 * The destructuring question is asked of a binding pattern in either position it
 * can occupy — a variable declaration and a parameter. Round 9 asked it of
 * variable declarations only, which made `function load({ memberships }:
 * Database)` a one-line evasion.
 */
function collectAccesses(
  module: Module,
  accessName: string,
  classifier: {
    isHandle: (node: ts.Expression) => boolean;
    isHandleDeclaration: (node: ts.Declaration) => boolean;
  },
): MemberAccess[] {
  const found: MemberAccess[] = [];
  const { source, path } = module;
  const record = (node: ts.Node, kind: AccessKind): void => {
    found.push({ file: path, line: lineOf(source, node), kind, text: node.getText(source) });
  };

  /** A key written as a string, if it is written as one at all. */
  const literalKey = (node: ts.Expression): string | null => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    return null;
  };

  /**
   * `const { memberships: rows } = <handle>` and every nesting of it.
   *
   * Recursion carries the "rooted in a handle" fact down through nested
   * patterns, which is what makes `const { query: { memberships } } = db()`
   * fire — the inner element's receiver is the outer one's value.
   */
  const walkPattern = (pattern: ts.BindingPattern): void => {
    for (const element of pattern.elements) {
      if (!ts.isBindingElement(element)) continue;
      const property = element.propertyName;
      if (property) {
        if (ts.isComputedPropertyName(property)) {
          const key = literalKey(property.expression);
          if (key === accessName) record(element, 'destructured');
          else if (key === null) record(element, 'computed-key');
        } else if (
          (ts.isIdentifier(property) || ts.isStringLiteral(property)) &&
          property.text === accessName
        ) {
          record(element, 'destructured');
        }
      } else if (ts.isIdentifier(element.name) && element.name.text === accessName) {
        record(element, 'destructured');
      }
      if (!ts.isIdentifier(element.name)) walkPattern(element.name);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      if (node.name.text === accessName && classifier.isHandle(node.expression)) {
        record(node, 'property');
      }
    } else if (ts.isElementAccessExpression(node)) {
      if (classifier.isHandle(node.expression)) {
        const key = literalKey(node.argumentExpression);
        if (key === accessName) record(node, 'string-index');
        else if (key === null) {
          /**
           * `db.query['member' + 'ships']`, `db.query[name]`. The key cannot be
           * resolved, so "we could not tell" is reported rather than waved
           * through — the same rule the computed *specifier* half already
           * follows. It costs nothing in practice because it is asked only of a
           * database handle, which no app has a reason to index dynamically.
           */
          record(node, 'computed-key');
        }
      }
    } else if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      !ts.isIdentifier(node.name) &&
      classifier.isHandleDeclaration(node)
    ) {
      /**
       * `const { memberships } = db().query` — and the parameter form of it.
       *
       * Round 9 asked this of variable declarations only, so
       * `function load({ memberships }: Database['query'])` and
       * `function load({ memberships } = createDatabase().query)` destructured
       * the table straight out of a handle with nothing reported. A binding
       * pattern is a binding pattern wherever it is written; the question is
       * only whether what it destructures is a handle, which
       * `isHandleDeclaration` answers for both positions the same way.
       */
      walkPattern(node.name);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

export interface BoundaryAnalysis {
  offences: BoundaryOffence[];
  computed: ComputedSpecifier[];
  /** Forbidden-root files naming the table as a property. */
  accesses: MemberAccess[];
  /** Every file parsed, relative to `root`. */
  scanned: string[];
  /** What a module exposes, for the premise assertions. */
  exposureOf: (path: string) => { names: string[]; all: boolean };
  /** Specifier resolution, exposed so a test can prove the resolver works. */
  resolveSpecifier: (specifier: string, fromPath: string) => string | null;
}

export function analyzeImportBoundary(rule: BoundaryRule): BoundaryAnalysis {
  const skip = rule.skipDirs ?? DEFAULT_SKIP;
  const scope = rule.workspaceScope ?? '@atrium/';

  const absoluteFiles: string[] = [];
  for (const graphRoot of rule.graphRoots) {
    const dir = join(rule.root, graphRoot);
    if (existsSync(dir)) collectSourceFiles(dir, skip, absoluteFiles);
  }

  const rel = (absolute: string) => relative(rule.root, absolute).split(sep).join('/');

  const modules = new Map<string, Module>();
  for (const absolute of absoluteFiles) {
    const path = rel(absolute);
    modules.set(path, readModule(absolute, path));
  }

  /**
   * A specifier to a file in this repository, or null for a real dependency.
   *
   * Two shapes matter. A relative specifier is a path, written with the `.js`
   * extension NodeNext wants and living on disk as `.ts`. A workspace specifier
   * is `@atrium/<pkg>[/<sub>]`, where the subpath is looked for under `src/` and
   * falls back to the package root rather than to nothing — see the header.
   */
  const resolveSpecifier = (specifier: string, fromPath: string): string | null => {
    if (specifier.startsWith('.')) {
      const base = resolvePath(dirname(join(rule.root, fromPath)), specifier);
      const found = resolveFilePath(base);
      return found ? rel(found) : null;
    }
    if (!specifier.startsWith(scope)) return null;
    const rest = specifier.slice(scope.length);
    const slash = rest.indexOf('/');
    const packageName = slash === -1 ? rest : rest.slice(0, slash);
    const subpath = slash === -1 ? '' : rest.slice(slash + 1);
    const packageDir = join(rule.root, 'packages', packageName);
    if (!existsSync(packageDir)) return null;
    const root = resolveFilePath(join(packageDir, 'src', 'index'));
    if (!subpath) return root ? rel(root) : null;
    const found =
      resolveFilePath(join(packageDir, 'src', subpath)) ??
      resolveFilePath(join(packageDir, subpath));
    if (found) return rel(found);
    return root ? rel(root) : null;
  };

  const allowed = new Set(rule.allowed);
  const taint = new Map<string, Taint>();
  const taintOf = (path: string): Taint => {
    let value = taint.get(path);
    if (!value) {
      value = { names: new Set(), all: false };
      taint.set(path, value);
    }
    return value;
  };

  taintOf(rule.declaredIn).names.add(rule.exportName);

  const exposes = (path: string, name: string): boolean => {
    const value = taint.get(path);
    if (!value) return false;
    return value.all || value.names.has(name);
  };
  const exposesAnything = (path: string): boolean => {
    const value = taint.get(path);
    return value !== undefined && (value.all || value.names.size > 0);
  };

  // Fixpoint. Bounded by the module count because each pass can only ever add,
  // and `all` is absorbing — so it terminates on any graph, cycles included.
  let changed = true;
  let passes = 0;
  while (changed && passes <= modules.size + 2) {
    changed = false;
    passes += 1;
    for (const module of modules.values()) {
      const before = taintOf(module.path);
      const sizeBefore = before.names.size;
      const allBefore = before.all;

      for (const reference of module.reexports) {
        const target = resolveSpecifier(reference.specifier, module.path);
        if (!target || !exposesAnything(target)) continue;
        const source = taintOf(target);
        if (reference.kind === 'star-reexport') {
          if (source.all) before.all = true;
          for (const name of source.names) before.names.add(name);
        } else if (reference.kind === 'namespace-reexport') {
          // `export * as db from '@atrium/db'` puts the whole module object
          // behind one name, so that name carries everything.
          for (const { exported } of reference.names) before.names.add(exported);
        } else {
          for (const { source: from, exported } of reference.names) {
            if (source.all || source.names.has(from)) before.names.add(exported);
          }
        }
      }

      if (!allowed.has(module.path)) {
        const touches = module.imports.some((reference) => {
          const target = resolveSpecifier(reference.specifier, module.path);
          if (!target) return false;
          if (reference.whole) return exposesAnything(target);
          return reference.names.some(({ source }) => exposes(target, source));
        });
        // Rule 2: a module that holds the binding can wrap it in anything, so
        // everything it exports is suspect from here on.
        if (touches) before.all = true;
      }

      if (before.names.size !== sizeBefore || before.all !== allBefore) changed = true;
    }
  }

  /**
   * ## The handle graph
   *
   * A second, independent fixpoint over the same modules, answering a different
   * question: which exported names hand out a **database handle**. The table
   * taint above says who can name the table; this says who can reach it off a
   * connection, which is the half no import rule can see.
   *
   * The seed is the package that declares the table. Everything under it is
   * assumed to expose handles, because that is what such a package is for and
   * `createDatabase` lives there — assuming *more* here is the conservative
   * direction, since the only consequence is that a receiver is followed.
   */
  const handleTypeNames = rule.handleTypeNames ?? DEFAULT_HANDLE_TYPES;
  const declaringPackage = (() => {
    const parts = rule.declaredIn.split('/');
    // `packages/db/src/schema.ts` → `packages/db/`
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}/` : `${parts[0]}/`;
  })();

  const handleExports = new Map<string, Taint>();
  const handlesOf = (path: string): Taint => {
    let value = handleExports.get(path);
    if (!value) {
      value = { names: new Set(), all: path.startsWith(declaringPackage) };
      handleExports.set(path, value);
    }
    return value;
  };
  for (const path of modules.keys()) handlesOf(path);

  const exposesHandle = (path: string, name: string): boolean => {
    const value = handleExports.get(path);
    if (!value) return false;
    return value.all || name === '*' ? value.all || value.names.size > 0 : value.names.has(name);
  };

  /**
   * Is this expression rooted in a database handle?
   *
   * One memo per module, because the answer depends on that module's bindings.
   * The walk is deliberately short: assignment, `await`, casts, calls, member
   * access and destructuring are the ways a handle travels inside a file, and
   * anything else answers no.
   */
  function handleClassifier(module: Module) {
    const memo = new Map<string, boolean>();
    const inProgress = new Set<string>();

    const bindingIsHandle = (name: string): boolean => {
      const cached = memo.get(name);
      if (cached !== undefined) return cached;
      // Cycles (`const a = b; const b = a;`) answer no rather than recursing.
      if (inProgress.has(name)) return false;
      inProgress.add(name);
      const answer = computeBinding(name);
      inProgress.delete(name);
      memo.set(name, answer);
      return answer;
    };

    const computeBinding = (name: string): boolean => {
      const imported = module.handles.imported.get(name);
      if (imported) {
        const target = resolveSpecifier(imported.specifier, module.path);
        return target !== null && exposesHandle(target, imported.name);
      }
      const declaration = module.handles.declared.get(name);
      if (!declaration) return false;
      if (ts.isVariableDeclaration(declaration)) {
        if (referencesHandleType(declaration.type, handleTypeNames)) return true;
        return declaration.initializer ? isHandle(declaration.initializer) : false;
      }
      if (ts.isParameter(declaration)) {
        // An annotation is the author saying so. Without one there is nothing
        // syntactic to go on *for a value the caller supplies*, and guessing
        // would be the noise the round-7 gauntlet objected to.
        if (referencesHandleType(declaration.type, handleTypeNames)) return true;
        /**
         * A **default** is not the caller's value, it is an initializer written
         * right here — `function load(db = createDatabase())`. The header's
         * promise is "initializers are followed", and this is one; reading only
         * the annotation made `db = createDatabase()` the cheapest evasion in
         * the file, because it needs no annotation and no second statement.
         */
        return declaration.initializer ? isHandle(declaration.initializer) : false;
      }
      if (ts.isBindingElement(declaration)) return bindingElementIsHandle(declaration);
      if (ts.isFunctionDeclaration(declaration)) return functionYieldsHandle(declaration);
      return false;
    };

    /** A name destructured off a handle is still a handle: `const { query } = db`. */
    const bindingElementIsHandle = (element: ts.BindingElement): boolean => {
      // Its own default is an initializer in its own right:
      // `const { db = createDatabase() } = options`.
      if (element.initializer && isHandle(element.initializer)) return true;
      let pattern: ts.Node = element.parent;
      while (ts.isBindingElement(pattern.parent)) pattern = pattern.parent.parent;
      const owner = pattern.parent;
      if (ts.isVariableDeclaration(owner)) {
        if (referencesHandleType(owner.type, handleTypeNames)) return true;
        return owner.initializer ? isHandle(owner.initializer) : false;
      }
      if (ts.isParameter(owner)) {
        if (referencesHandleType(owner.type, handleTypeNames)) return true;
        return owner.initializer ? isHandle(owner.initializer) : false;
      }
      return false;
    };

    const functionYieldsHandle = (fn: ts.SignatureDeclaration): boolean => {
      if (referencesHandleType(fn.type, handleTypeNames)) return true;
      return returnedExpressions(fn).some((expression) => isHandle(expression));
    };

    /**
     * The binary operators that can *pass a value through*, and only those.
     *
     * `a ?? b`, `a || b` and `a && b` each evaluate to one of their operands, so
     * either operand being a handle makes the whole expression one. A comma
     * sequence and an assignment both evaluate to their right-hand side —
     * `(0, createDatabase)()` and `(cached = createDatabase())` are the two
     * shapes that actually turn up. Every other operator (`+`, `===`, `in`,
     * `instanceof`…) produces a new primitive, so it answers no, which keeps
     * this from becoming "any expression mentioning a handle".
     */
    const binaryIsHandle = (node: ts.BinaryExpression): boolean => {
      const operator = node.operatorToken.kind;
      if (
        operator === ts.SyntaxKind.QuestionQuestionToken ||
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        return isHandle(node.left) || isHandle(node.right);
      }
      if (operator === ts.SyntaxKind.CommaToken) return isHandle(node.right);
      if (
        operator === ts.SyntaxKind.EqualsToken ||
        operator === ts.SyntaxKind.QuestionQuestionEqualsToken ||
        operator === ts.SyntaxKind.BarBarEqualsToken ||
        operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken
      ) {
        return isHandle(node.right);
      }
      return false;
    };

    const isHandle = (node: ts.Expression): boolean => {
      if (ts.isParenthesizedExpression(node)) return isHandle(node.expression);
      if (ts.isAwaitExpression(node)) return isHandle(node.expression);
      if (ts.isNonNullExpression(node)) return isHandle(node.expression);
      if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
        return referencesHandleType(node.type, handleTypeNames) || isHandle(node.expression);
      }
      if (ts.isTypeAssertionExpression(node)) {
        return referencesHandleType(node.type, handleTypeNames) || isHandle(node.expression);
      }
      if (ts.isPartiallyEmittedExpression(node)) return isHandle(node.expression);
      /**
       * `cond ? createDatabase() : createDatabase()`, and every one-armed
       * version of it. **Either branch is enough**, which is the only sound
       * answer: a value that is a handle down one path is a handle, and the
       * check's job is to notice the path, not to prove it is always taken.
       */
      if (ts.isConditionalExpression(node)) {
        return isHandle(node.whenTrue) || isHandle(node.whenFalse);
      }
      if (ts.isBinaryExpression(node)) return binaryIsHandle(node);
      // Synthesized by the parser in a few positions; treated like a comma.
      if (ts.isCommaListExpression(node)) {
        return node.elements.some((element) => isHandle(element));
      }
      if (ts.isIdentifier(node)) return bindingIsHandle(node.text);
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        return isHandle(node.expression);
      }
      if (ts.isCallExpression(node)) {
        // `await import('@atrium/db')` and `require('@atrium/db')` hand over the
        // module object, which for the declaring package is a handle source.
        const dynamic =
          node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require');
        const [argument] = node.arguments;
        if (dynamic && argument && ts.isStringLiteral(argument)) {
          const target = resolveSpecifier(argument.text, module.path);
          return target !== null && exposesHandle(target, '*');
        }
        // Otherwise the call yields a handle when the thing being called does —
        // `createDatabase()`, `db()`, `handle().db`.
        return isHandle(node.expression);
      }
      if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
        return functionYieldsHandle(node);
      }
      return false;
    };

    /**
     * Does this declaration's *source* hand out a handle?
     *
     * The same question `computeBinding` asks, but about the declaration node
     * rather than a name, so it answers for a binding *pattern* — which binds
     * several names and therefore has none of its own to look up.
     */
    const isHandleDeclaration = (node: ts.Declaration): boolean => {
      if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
        if (referencesHandleType(node.type, handleTypeNames)) return true;
        return node.initializer ? isHandle(node.initializer) : false;
      }
      return false;
    };

    return { isHandle, bindingIsHandle, isHandleDeclaration };
  }

  // Fixpoint over the handle graph, same shape and same termination argument as
  // the taint one above.
  let handlesChanged = true;
  let handlePasses = 0;
  while (handlesChanged && handlePasses <= modules.size + 2) {
    handlesChanged = false;
    handlePasses += 1;
    for (const module of modules.values()) {
      const before = handlesOf(module.path);
      const sizeBefore = before.names.size;
      const allBefore = before.all;
      const { bindingIsHandle, isHandle } = handleClassifier(module);

      for (const reference of module.reexports) {
        const target = resolveSpecifier(reference.specifier, module.path);
        if (!target) continue;
        const source = handlesOf(target);
        if (reference.kind === 'star-reexport') {
          if (source.all) before.all = true;
          for (const name of source.names) before.names.add(name);
        } else if (reference.kind === 'namespace-reexport') {
          if (source.all || source.names.size > 0) {
            for (const { exported } of reference.names) before.names.add(exported);
          }
        } else {
          for (const { source: from, exported } of reference.names) {
            if (source.all || source.names.has(from)) before.names.add(exported);
          }
        }
      }

      for (const [exported, local] of module.handles.exportedLocals) {
        const declaration = module.handles.declared.get(local);
        const yieldsHandle = declaration
          ? bindingIsHandle(local)
          : (() => {
              const imported = module.handles.imported.get(local);
              if (!imported) return false;
              const target = resolveSpecifier(imported.specifier, module.path);
              return target !== null && exposesHandle(target, imported.name);
            })();
        if (yieldsHandle) before.names.add(exported);
      }

      // `export default createDatabase()`: no local name to look up, so the
      // exported expression is asked directly.
      const { defaultExport } = module.handles;
      if (defaultExport && !before.names.has('default') && isHandle(defaultExport)) {
        before.names.add('default');
      }

      if (before.names.size !== sizeBefore || before.all !== allBefore) handlesChanged = true;
    }
  }

  const offences: BoundaryOffence[] = [];
  const computed: ComputedSpecifier[] = [];
  const accesses: MemberAccess[] = [];
  const forbidden = rule.forbiddenRoots.map((root) => `${root}/`);

  for (const module of modules.values()) {
    if (!forbidden.some((root) => module.path.startsWith(root))) continue;
    computed.push(...module.computed);
    if (rule.forbiddenAccessName !== undefined) {
      accesses.push(...collectAccesses(module, rule.forbiddenAccessName, handleClassifier(module)));
    }

    for (const reference of [...module.imports, ...module.reexports]) {
      const target = resolveSpecifier(reference.specifier, module.path);
      if (!target) continue;
      if (reference.whole) {
        if (!exposesAnything(target)) continue;
        offences.push({
          file: module.path,
          specifier: reference.specifier,
          via: target,
          binding: '*',
          kind: reference.kind,
          line: reference.line,
        });
        continue;
      }
      for (const { source } of reference.names) {
        if (!exposes(target, source)) continue;
        offences.push({
          file: module.path,
          specifier: reference.specifier,
          via: target,
          binding: source,
          kind: reference.kind,
          line: reference.line,
        });
      }
    }
  }

  offences.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  accesses.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  return {
    offences,
    computed,
    accesses,
    scanned: [...modules.keys()].sort(),
    exposureOf: (path) => {
      const value = taint.get(path);
      return { names: [...(value?.names ?? [])].sort(), all: value?.all ?? false };
    },
    resolveSpecifier,
  };
}

/** One-line renderings, so a failure names the evasion rather than a path list. */
export function describeOffence(offence: BoundaryOffence): string {
  const what = offence.binding === '*' ? 'the whole module' : `\`${offence.binding}\``;
  return `${offence.file}:${offence.line} takes ${what} from '${offence.specifier}' (${offence.kind}, resolves to ${offence.via})`;
}
