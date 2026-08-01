/**
 * An import-boundary checker that resolves what a module actually pulls in.
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
 * root name the table as a property at all. Between them there is no way to name
 * the table under `apps/`.
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
   * A property name that forbidden-root files may not write, at all.
   *
   * The companion to the import analysis, for the table reached off a handle —
   * `db.query.memberships`, `db['query']['memberships']` — which no import rule
   * can observe. See the header.
   */
  forbiddenAccessName?: string;
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

/** A forbidden-root file naming the table as a property. */
export interface MemberAccess {
  file: string;
  line: number;
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

interface Module {
  /** Relative to `root`. */
  path: string;
  absolute: string;
  imports: Reference[];
  reexports: Reference[];
  computed: ComputedSpecifier[];
  accesses: MemberAccess[];
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

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/** Everything one file pulls in or passes on, as an AST question. */
function readModule(absolute: string, path: string, accessName: string | undefined): Module {
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
    imports: [],
    reexports: [],
    computed: [],
    accesses: [],
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const line = lineOf(source, statement);
      const clause = statement.importClause;
      // A bare `import 'x'` binds nothing, so it cannot reach the table.
      if (!clause) continue;
      if (clause.name) {
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
        module.imports.push({
          specifier,
          kind: 'namespace-import',
          names: [],
          whole: true,
          line,
        });
      } else if (bindings && ts.isNamedImports(bindings)) {
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
        // holds, so rule 2 (any toucher taints everything) covers it; there is
        // no specifier to resolve here.
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
  // a function, a ternary, a template. The whole tree gets walked for them.
  const visit = (node: ts.Node): void => {
    if (accessName !== undefined) {
      const named =
        (ts.isPropertyAccessExpression(node) && node.name.text === accessName) ||
        (ts.isElementAccessExpression(node) &&
          ts.isStringLiteral(node.argumentExpression) &&
          node.argumentExpression.text === accessName);
      if (named) {
        module.accesses.push({
          file: path,
          line: lineOf(source, node),
          text: node.getText(source),
        });
      }
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
    modules.set(path, readModule(absolute, path, rule.forbiddenAccessName));
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

  const offences: BoundaryOffence[] = [];
  const computed: ComputedSpecifier[] = [];
  const accesses: MemberAccess[] = [];
  const forbidden = rule.forbiddenRoots.map((root) => `${root}/`);

  for (const module of modules.values()) {
    if (!forbidden.some((root) => module.path.startsWith(root))) continue;
    computed.push(...module.computed);
    accesses.push(...module.accesses);

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
