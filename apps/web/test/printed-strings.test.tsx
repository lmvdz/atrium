/* ---------------------------------------------------------------------------
 * EVERY CALLER-SUPPLIED STRING THE PAGE PRINTS GOES THROUGH A DOOR — COUNTED,
 * AND THE COUNT DOES NOT COME FROM THE CLAIM.
 *
 * The recurring shape, now at its fifth address in five rounds:
 *
 *   r3  `systemStatement` was checked at the constructor and not at the parser.
 *   r5  checked at both and not at the renderer; `statementText()` was written.
 *   r6  applied to ONE page-authored string type; `rationaleText()` was written.
 *   r6, blind review  a sweep of every element carrying `data-voice="system"`
 *       found three more sinks inside those elements.
 *   r7, blind review  the sweep's DENOMINATOR was the set of elements the page
 *       had marked, and four sinks sat outside it — `ProvenanceEntry.note`
 *       rendered inside the same `<button>` as a resolved quotation on the line
 *       immediately after the quoted words, `CorrectionEntry.heading` in the
 *       exact layout slot round 6 deleted `HappenedLine.who` from,
 *       `RowTag.label` welded onto the end of a person's own sentence, and
 *       `AttentionItem.facts`.
 *
 * `test/system-voice.test.tsx`'s own header names the failure — "the address came
 * from a receipt instead of from a count" — and then commits it: a denominator
 * taken from `data-voice="system"` is a denominator supplied by the claim, which
 * is the exact thing CONVENTIONS' harness section condemns.
 *
 * So the denominator here is EVERY PLACE A STRING REACHES A READER: every JSX
 * child interpolation and every announced-text attribute, in every component file
 * and every app file, with the file list read off the filesystem rather than
 * written down. See `test/printed.ts` for the analysis and its limits.
 * ------------------------------------------------------------------------- */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { TAG_SCOPED_TEXT_ATTRIBUTES } from '../src/components/model/printed-surface';
import {
  ANNOUNCED_ATTRIBUTES,
  analyseSource,
  attributesPrintedByCss,
  CONTROL_TAGS,
  offeredCallSites,
  type PrintedFinding,
  setCssPrintedAttributes,
} from './printed';

function find(path: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = resolve(dir, path);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`${path} not found above ${process.cwd()}`);
}

const WEB = find('apps/web/package.json').replace(/\/package\.json$/, '');

/* ---------------------------------------------------------------------------
 * THE FILE SET — r8 D5, AND THE FOURTH SUBSYSTEM IN THIS REPO TO SHIP A CORRECT
 * ANALYSIS OVER AN INCOMPLETE INPUT SET.
 *
 * RETRO.md records the other three. This one shipped in round 7, inside the file
 * written to end exactly this defect class: the list was "`*.tsx` under two named
 * directories", and the only guard on it was `SOURCES.length > 24`. Measured on
 * r7: adding `src/components/primitives/Leak.jsx` and `src/widgets/Leak2.tsx`,
 * each rendering `<span title={note}>{note}</span>` off an untraced prop, left
 * the sweep at 226 sites — UNCHANGED and GREEN — while `tsconfig` sets
 * `allowJs: true` and Next compiles and ships both.
 *
 * A directory list and an extension list are both a claim about what runs. So the
 * enumeration is tied to the three things that actually decide it, and the
 * DIFFERENCES ARE ASSERTED EMPTY rather than assumed:
 *
 *   1. THE BUNDLER'S REACH — every file under `apps/web` with an extension Next
 *      compiles, outside the directories that are not the app. This is the walk
 *      below, and it is the widest of the three.
 *   2. THE COMPILER'S `include` — `tsconfig.json`, read and parsed by TypeScript
 *      itself rather than by a regex over the JSON. Asserted equal to (1), in
 *      BOTH directions: a file tsc roots that the walk missed is a hole in the
 *      walk, and a file the walk finds that tsc never roots is a file Next ships
 *      and nothing typechecks — which is what `allowJs: true` beside a tsconfig
 *      `include` naming only the two TypeScript globs had arranged.
 *   3. THE MODULE GRAPH — every source file the built program actually pulled in
 *      from under `apps/web`. A module the app imports from a directory this walk
 *      skipped shows up here and nowhere else.
 *   4. NEXT'S ROUTE CONVENTIONS — `page`/`layout`/`route`/`error`/… under `app/`
 *      are entry points whether or not anything imports them, so the graph in (3)
 *      cannot see a route nobody links to.
 *
 * WHAT THIS ENUMERATES FROM, AND WHAT EXECUTES THAT IT DOES NOT LIST: it
 * enumerates from the filesystem, cross-checked against tsc's parse of the
 * project and the resulting module graph. What executes and is NOT listed: the
 * CSS (handled separately — see `CSS_PRINTED_ATTRIBUTES`), the `design/` token
 * sheet, and code in `packages/*` that this app imports, which is enumerated by
 * its own package's tests and reaches the page as a value rather than as JSX.
 * ------------------------------------------------------------------------- */

/**
 * Extensions Next compiles into the app. `allowJs` is on, so the JavaScript ones
 * are not hypothetical — a `.jsx` beside a `.tsx` is bundled identically.
 */
const COMPILED_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
];

/**
 * Directories under `apps/web` that are not the shipped app. Everything else is,
 * including any directory nobody has created yet — which is the point of naming
 * the exclusions rather than the inclusions.
 */
const NOT_THE_APP: ReadonlySet<string> = new Set(['node_modules', 'test', 'e2e', 'public']);

function isCompiled(name: string): boolean {
  if (name.endsWith('.d.ts')) return false;
  return COMPILED_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/** Every file under `apps/web` that Next can compile into the app. */
function appSources(): readonly string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      if (NOT_THE_APP.has(name) || name.startsWith('.')) continue;
      const full = join(current, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (isCompiled(name)) out.push(full);
    }
  };
  walk(WEB);
  return out;
}

const SOURCES: readonly string[] = appSources();

/** The project as TypeScript itself parses it — not as a regex over the JSON. */
function parsedProject(): ts.ParsedCommandLine {
  const configPath = join(WEB, 'tsconfig.json');
  const raw = ts.readConfigFile(configPath, (p) => readFileSync(p, 'utf8'));
  return ts.parseJsonConfigFileContent(raw.config, ts.sys, WEB);
}

/** Files the compiler roots from this app's own tree, on the same terms. */
function compilerRoots(parsed: ts.ParsedCommandLine): readonly string[] {
  return parsed.fileNames.filter((path) => insideTheApp(path));
}

function insideTheApp(path: string): boolean {
  const rel = relative(WEB, path);
  if (rel.startsWith('..') || rel.startsWith('/')) return false;
  if (!isCompiled(rel)) return false;
  return !rel.split('/').some((segment) => NOT_THE_APP.has(segment) || segment.startsWith('.'));
}

/** Next's file-based entry points: reachable by URL, not by import. */
const ROUTE_FILES: readonly string[] = [
  'page',
  'layout',
  'route',
  'error',
  'global-error',
  'not-found',
  'template',
  'default',
  'loading',
];

function routeEntryPoints(): readonly string[] {
  return SOURCES.filter((path) => {
    const rel = relative(WEB, path);
    if (!rel.startsWith('app/')) return false;
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    return ROUTE_FILES.some((name) => COMPILED_EXTENSIONS.some((ext) => base === `${name}${ext}`));
  });
}

/* ---------------------------------------------------------------------------
 * THE ATTRIBUTE SET IS ONLY CLOSED RELATIVE TO A STYLESHEET.
 *
 * `content: attr(data-x)` prints ANY attribute — the r8 review named `data-*` as
 * a sink the sweep could not see, and the honest fix is not to add every
 * `data-*` to a list (which would report `data-hold-progress` as caller text and
 * teach the next round to trust a list again). Whether a `data-*` reaches a
 * reader is a fact about the CSS, so it is READ FROM THE CSS.
 *
 * Today the derived set is EMPTY: no rule in this app uses `attr()`. That is a
 * measurement, not an assumption — the derivation runs on every commit, and the
 * day a rule adds one the sweep picks the attribute up without anyone editing a
 * list. `stylesheetsOf` is exercised against synthetic CSS in the self-test
 * below, because an enumerator whose current answer is "none" is exactly the
 * enumerator that can be broken without anyone noticing.
 * ------------------------------------------------------------------------- */
const REPO = dirname(dirname(WEB));

function cssFiles(): readonly string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const full = join(current, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (name.endsWith('.css')) out.push(full);
    }
  };
  walk(WEB);
  walk(join(REPO, 'design'));
  return out;
}

const CSS_PRINTED_ATTRIBUTES: readonly string[] = [
  ...new Set(cssFiles().flatMap((path) => attributesPrintedByCss(readFileSync(path, 'utf8')))),
].sort();

setCssPrintedAttributes(CSS_PRINTED_ATTRIBUTES);

const PARSED = parsedProject();

function program(): ts.Program {
  return ts.createProgram({
    rootNames: [...SOURCES],
    options: {
      ...PARSED.options,
      noEmit: true,
      incremental: false,
      composite: false,
      jsx: ts.JsxEmit.ReactJSX,
      skipLibCheck: true,
    },
  });
}

/**
 * Can this expression carry a string a caller chose?
 *
 * A CLOSED UNION OF STRING LITERALS IS NOT CALLER TEXT. `Glyph`,
 * `'here' | 'idle' | 'away'`, `'true' | undefined` — the set of values is
 * enumerable from the type, so no sentence can arrive through one. `string`,
 * a template-literal type, `any` and `unknown` all can.
 *
 * AND SO CAN A BRANDED ONE — r8 D2, and the narrowing that missed it was
 * narrowing past the exact type this whole sweep was written about.
 *
 * `Rationale = string & { readonly [rationaleBrand]: 'rationale' }` is an
 * INTERSECTION. `type.isUnion()` is false, so the old version tested the
 * intersection's own flags — `Intersection`, none of `Any | Unknown | String |
 * TemplateLiteral` — and answered NO. Every `Rationale` site in the library was
 * therefore COUNTED and never TRACED: measured, adding `title={item.rationale}`
 * to `AttentionCard`'s `<article>` moved the sweep from `226 sites · 126 traced`
 * to `227 sites · 126 traced` with no new finding, and the suite stayed green.
 *
 * `Rationale` is the only branded string in the library and it is precisely the
 * type whose RAW RENDER was round 5's finding — `AttentionCard` and
 * `AttentionCompact` printed `{item.rationale}` directly, including into two
 * `title=` attributes. The sweep's stated job is that defect AT ANY ADDRESS; for
 * the type it was written about it caught it at zero, and the only thing standing
 * between the library and a repeat was a hand-written test in
 * `attention.test.tsx` naming the two addresses that already existed.
 *
 * A brand is a type-level marker; it does not stop a `JSON.parse`, a cast, or a
 * `String()` from putting a sentence in one. The type question the sweep asks is
 * "can a free string be in here", and for `string & Brand` the answer is yes.
 */
function typeIsFree(type: ts.Type): boolean {
  const parts = type.isUnion() ? type.types : [type];
  return parts.some((part) => partIsFree(part, 0));
}

function partIsFree(part: ts.Type, depth: number): boolean {
  if ((part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return true;
  /* A BRAND IS AN INTERSECTION, and it is free when any member of it is. Bounded
     because a type graph is not; three is far past every brand in this library,
     which is `string & { readonly [b]: 'x' }` — one level. */
  if (part.isIntersection() && depth < 3) {
    return part.types.some((member) => partIsFree(member, depth + 1));
  }
  if ((part.flags & ts.TypeFlags.StringLiteral) !== 0) return false;
  return (part.flags & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral)) !== 0;
}

/**
 * A `Slot`, which is the one boundary this sweep can see through: `slot()` is
 * the only constructor, it walks the tree it is handed, and it puts every RAW
 * STRING in that tree through `systemText`. So a slot is a door with a walk
 * behind it rather than a hole — see `model/slot.ts`.
 */
/**
 * Does this type hold a free string ANYWHERE a composer could reach — itself, an
 * element of it, a property of it? A count does not; `readonly string[]` does;
 * an `Attribution` does. Bounded, because a record graph is not.
 */
function typeHoldsString(type: ts.Type, checker: ts.TypeChecker, depth = 0): boolean {
  if (typeIsFree(type)) return true;
  if (depth > 2) return false;
  const parts = type.isUnion() ? type.types : [type];
  for (const part of parts) {
    const element = checker.getIndexTypeOfType(part, ts.IndexKind.Number);
    if (element !== undefined && typeHoldsString(element, checker, depth + 1)) return true;
    for (const property of part.getProperties()) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (declaration === undefined) continue;
      const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
      if (typeHoldsString(propertyType, checker, depth + 1)) return true;
    }
  }
  return false;
}

function typeIsSlot(type: ts.Type): boolean {
  const parts = type.isUnion() ? type.types : [type];
  return parts.some(
    (part) => part.getSymbol()?.getName() === 'Slot' || part.aliasSymbol?.getName() === 'Slot',
  );
}

const PROGRAM = program();
const CHECKER = PROGRAM.getTypeChecker();

const RESULTS = SOURCES.map((path) => {
  const file = PROGRAM.getSourceFile(path);
  if (file === undefined) throw new Error(`the program does not hold ${path}`);
  return analyseSource(file, {
    relative: relative(WEB, path),
    isFreeString: (node) => typeIsFree(CHECKER.getTypeAtLocation(node)),
    isSlot: (node) => typeIsSlot(CHECKER.getTypeAtLocation(node)),
    holdsString: (node) => typeHoldsString(CHECKER.getTypeAtLocation(node), CHECKER),
  });
});

const SITES = RESULTS.reduce((n, r) => n + r.sites, 0);
const TRACED = RESULTS.reduce((n, r) => n + r.traced, 0);
const FINDINGS: readonly PrintedFinding[] = RESULTS.flatMap((r) => r.findings);

/**
 * Printed strings this analysis cannot trace and that are nonetheless checked,
 * each with the reason. Checked exhaustive in BOTH directions: an entry matching
 * nothing is a carve-out that outlived its subject and reports exactly like one
 * doing its job.
 *
 * Keep it SHORT. Every entry is a place the count stops counting.
 */
const EXEMPT: readonly { readonly file: string; readonly expr: string; readonly why: string }[] = [
  {
    file: 'src/components/primitives/Voice.tsx',
    expr: 'part.text',
    why: '<SystemVoice> IS the door: it snapshots the spans into plain data, validates the snapshot with statementText, and paints the snapshot it validated',
  },
  {
    file: 'src/components/primitives/MessageBody.tsx',
    expr: 'words',
    why: 'a message body is A PERSON’S OWN WORDS, and `segmentText` is the same function `messageEntry` and `TimelineRow` use to prove `bodyText(body) === record.text` before a name is printed over them — holding it to the system’s voice would be refusing the one string on the page that is supposed to be somebody’s sentence',
  },
  {
    file: 'app/error.tsx',
    expr: 'error.message',
    why: 'the error boundary’s whole job is printing the refusal VERBATIM; every throw in this model is written to be read by a person, and holding it to the system-voice bans would refuse the evidence (messageLedger’s own message contains quotation marks) and replace it with a second refusal',
  },
  {
    file: 'app/global-error.tsx',
    expr: 'error.message',
    why: 'the same, at the root layout — the one boundary that has no boundary above it',
  },
];

function key(finding: { file: string; expr: string }): string {
  return `${finding.file} {${finding.expr}}`;
}

const EXEMPT_KEYS = new Set(EXEMPT.map(key));
const UNCHECKED = FINDINGS.filter((finding) => !EXEMPT_KEYS.has(key(finding)));

describe('every caller-supplied string the page prints goes through a door', () => {
  /* CATCHES: the enumeration going blind. A sweep that finds no printed sites
     reports exactly like one that finds them all clean — which is how
     `graphicsChecked > 10` survived, and how the `data-voice="system"` sweep
     reported six regions while four sinks sat outside it. */
  it('there are printed strings to enumerate, in files read off the filesystem', () => {
    expect(SOURCES.length, 'the sweep found almost no component files').toBeGreaterThan(24);
    expect(SITES, 'the sweep found almost no printed sites').toBeGreaterThan(120);
    expect(
      TRACED,
      'no printed site could carry a free string, which cannot be true',
    ).toBeGreaterThan(40);
    /* The two trees are both in scope. A sweep of the library that skips the app
       is "a route is not the app" one level in. */
    expect(SOURCES.some((path) => path.includes('/src/components/'))).toBe(true);
    expect(SOURCES.some((path) => path.includes('/app/'))).toBe(true);
    console.info(
      `printed strings: ${SITES} sites · ${TRACED} traced · ${FINDINGS.length} findings`,
    );
  });

  /* CATCHES the r8 D5 defect and its whole class: a correct analysis over an
     incomplete input set. Three independent authorities on "what is the app",
     and the DIFFERENCES are the assertion — a count of files proves nothing,
     because the wrong denominator is a number too. */
  describe('the file set is what executes, and the difference is empty', () => {
    const SOURCE_SET = new Set(SOURCES);

    /* THE COMPILER, BOTH DIRECTIONS. Left-to-right: a file tsc roots that the
       walk missed is a hole in the walk. Right-to-left: a file the walk finds
       that tsc never roots is a file Next ships and NOTHING TYPECHECKS — which
       is exactly what `allowJs: true` beside a `tsconfig` include naming only
       the two TypeScript globs had arranged: a `.jsx` was invisible twice. */
    it('every file the compiler roots from this app is swept', () => {
      const roots = compilerRoots(PARSED);
      expect(roots.length, 'the tsconfig parse yielded no files from this app').toBeGreaterThan(24);
      expect(
        roots.filter((path) => !SOURCE_SET.has(path)).map((path) => relative(WEB, path)),
        'the compiler roots a file this sweep does not read',
      ).toEqual([]);
    });

    it('every file this sweep reads is a file the compiler roots', () => {
      const roots = new Set(compilerRoots(PARSED));
      expect(
        SOURCES.filter((path) => !roots.has(path)).map((path) => relative(WEB, path)),
        'Next compiles this file and the tsconfig `include` never roots it, so nothing typechecks what ships',
      ).toEqual([]);
    });

    /* THE MODULE GRAPH. A file the app imports from a directory the walk skipped
       is in the program and nowhere else — the "two named directories" defect,
       caught by the compiler's own resolution rather than by a second list. */
    it('every module the app pulls in from its own tree is swept', () => {
      const pulled = PROGRAM.getSourceFiles()
        .map((file) => file.fileName)
        .filter((path) => insideTheApp(path))
        .filter((path) => !SOURCE_SET.has(path));
      expect(
        pulled.map((path) => relative(WEB, path)),
        'the app imports a file from its own tree that this sweep does not read',
      ).toEqual([]);
    });

    /* NEXT'S ROUTE CONVENTIONS. A route is an entry point by NAME — no import
       reaches it — so the module graph above cannot see one that nothing links
       to. `/gallery/pin/[n]` is the shipped case. */
    it('every route entry point Next serves is swept', () => {
      const routes = routeEntryPoints().map((path) => relative(WEB, path));
      expect(routes, 'no route entry points found, so this bound measures nothing').not.toEqual([]);
      expect(routes).toContain('app/page.tsx');
      expect(routes).toContain('app/layout.tsx');
      expect(routes.some((path) => path.includes('/pin/'))).toBe(true);
    });

    /* AND THE EXTENSION LIST IS THE OTHER HALF OF THE DENOMINATOR. `.tsx` alone
       was half a claim: `allowJs` is on, and the r8 review shipped a `.jsx` past
       the r7 sweep to prove it. */
    it('sweeps every extension Next compiles, not only the one this app happens to use', () => {
      expect(COMPILED_EXTENSIONS).toContain('.jsx');
      expect(COMPILED_EXTENSIONS).toContain('.js');
      expect(PARSED.options.allowJs, 'allowJs decides whether .js/.jsx ship').toBe(true);
      /* AND THE `include` COVERS EVERY ONE OF THEM. With no `.jsx` in the tree
         today, "the sweep reads what the compiler roots" is vacuously true — so
         the guarantee is stated against the CONFIG rather than against the
         current file list, which is the difference between a rule and a
         coincidence. `allowJs: true` beside an include of only the TypeScript
         globs is a file Next ships that nothing typechecks. */
      const include = (ts.readConfigFile(join(WEB, 'tsconfig.json'), (p) => readFileSync(p, 'utf8'))
        .config.include ?? []) as readonly string[];
      expect(
        COMPILED_EXTENSIONS.filter(
          (extension) => !include.some((glob) => glob.endsWith(`*${extension}`)),
        ),
        'Next compiles this extension and the tsconfig `include` does not root it',
      ).toEqual([]);
      /* The walk covers the whole app tree, not a list of directories inside it:
         `src/widgets/` is the shape the r8 review used, and it never existed. */
      expect(SOURCES.some((path) => relative(WEB, path).startsWith('src/components/'))).toBe(true);
      expect(SOURCES.some((path) => relative(WEB, path).startsWith('app/'))).toBe(true);
      expect(
        SOURCES.every(
          (path) =>
            !relative(WEB, path)
              .split('/')
              .some((s) => NOT_THE_APP.has(s)),
        ),
        'the sweep is reading its own test tree',
      ).toBe(true);
    });
  });

  /* CATCHES the recurring defect at ANY address rather than at the one a critic
     names: a caller-supplied string reaching a reader without passing a check on
     the render path. The four the round-6 review found by hand are four members
     of this set; so are the ones nobody has looked for. */
  it('no caller-supplied string reaches a reader untraced', () => {
    expect(
      UNCHECKED.map(
        (finding) =>
          `${finding.file}:${finding.line} [${finding.where}] {${finding.expr}} — ${finding.why}`,
      ),
      'a string the page prints cannot be traced back to a literal, the record register, or a door',
    ).toEqual([]);
  });

  /* BOTH DIRECTIONS. */
  it('every exemption still applies to something', () => {
    const found = new Set(FINDINGS.map(key));
    expect(
      EXEMPT.filter((entry) => !found.has(key(entry))).map(key),
      'an exemption in EXEMPT matched nothing in the library',
    ).toEqual([]);
  });

  /* ---------------------------------------------------------------------------
   * THE PAYLOAD DOOR'S BOUND — r8 D3.
   *
   * Round 7 asked `containsTag(enclosingFunction(call), CONTROLS)`: "does the
   * function this call sits in render a control ANYWHERE" — a question about the
   * file, not about the string. Measured on r7,
   * `title={offeredText(item.title, 'AttentionCard summary')}` on the `<article>`
   * passed, including the test named "the payload door is only used on the copy
   * of a control", suite green at 408; and 23 of the 52 strong-door call sites
   * sat in a function the predicate would have accepted just as readily.
   *
   * The bound is now a question about the string's DESTINATION — see
   * `offeredCallSites` in `test/printed.ts`, which is self-tested against
   * synthetic source below, both for what it accepts and for what it refuses.
   *
   * And this is THE LIST THE OLD COMMENT PROMISED. It said "Asserted as the list
   * below" under a dangling `&& true`; there was no list below, and `&& true` is
   * what a deleted clause leaves behind. Here it is, in both directions: a new
   * call site is a diff, and a host that stops existing is a diff too.
   * ------------------------------------------------------------------------- */
  const OFFERED_HOSTS: readonly string[] = [
    'src/components/attention/AttentionCard.tsx <button>',
    'src/components/attention/AttentionCard.tsx <button>',
    'src/components/attention/AttentionCompact.tsx <button>',
    'src/components/primitives/HoldToAct.tsx <button>',
    'src/components/primitives/HoldToAct.tsx <button> + <span id={describeId}> named by a control',
    'src/components/timeline/TimelineRow.tsx <button>',
  ];

  it('the payload door is only used on the copy of a control', () => {
    const sites = SOURCES.flatMap((path) => {
      const file = PROGRAM.getSourceFile(path);
      if (file === undefined) return [];
      return offeredCallSites(file).map((site) => ({ ...site, file: relative(WEB, path) }));
    });
    expect(
      sites.length,
      'nothing uses the payload door, so this bound measures nothing',
    ).toBeGreaterThan(3);
    expect(
      sites
        .filter((site) => site.host === null)
        .map((site) => `${site.file}:${site.line} {${site.expr}}`),
      'offeredText — the door that keeps its pronouns — is used on a string that is not a control’s copy',
    ).toEqual([]);
  });

  /* THE LIST, BOTH DIRECTIONS. A call site added anywhere shows up here with the
     control it claims, and a host named here that no longer exists shows up as a
     missing row — which is the check the r7 comment described and did not have. */
  it('every payload-door call site is on the list, and every entry on the list is real', () => {
    const found = SOURCES.flatMap((path) => {
      const file = PROGRAM.getSourceFile(path);
      if (file === undefined) return [];
      return offeredCallSites(file).map((site) => `${relative(WEB, path)} ${site.host}`);
    }).sort();
    expect(found, 'the payload door’s call sites and their controls').toEqual([...OFFERED_HOSTS]);
  });
});

/* ---------------------------------------------------------------------------
 * THE ENUMERATOR'S OWN SELF-TEST.
 *
 * CONVENTIONS: "an enumerator gets a self-test — an instrument with no self-test
 * is a claim, not a measurement", and "three of round 6's ten self-found defects
 * were holes in the enumerators it wrote, because the enumerators are the round's
 * product". This one is exercised against a synthetic file carrying one instance
 * of every shape it has to get right AND every shape it has to refuse, with the
 * type question stubbed to "everything could be a string" so the DATAFLOW is what
 * is under test.
 * ------------------------------------------------------------------------- */
describe('the analysis sees every shape it claims to', () => {
  function analyse(source: string): readonly string[] {
    const file = ts.createSourceFile(
      'probe.tsx',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    return analyseSource(file, { relative: 'probe.tsx', isFreeString: () => true }).findings.map(
      (finding) => finding.expr,
    );
  }

  it('passes literals, doors, register lookups, aliases and local components', () => {
    expect(
      analyse(`
        import { systemText } from './x';
        function Label({ text }: { text: string }) { return <span>{text}</span>; }
        export function Ok({ entry }: { entry: { note: string } }) {
          const excerpt = useAttribution(entry.excerpt, 'Ok');
          const note = systemText(entry.note, 'Ok');
          const both = \`\${excerpt.actor} · \${note}\`;
          return (
            <div title={systemText(entry.note, 'Ok')}>
              {'a literal'}
              {excerpt.text}
              {note}
              {both}
              {excerpt.room === null ? 'here' : \`in #\${excerpt.room}\`}
              {entry.rows.length}
              <Label text="written here" />
              {entry.rows.map((row) => (<span key={row.id}>{systemText(row.at, 'Ok')}</span>))}
            </div>
          );
        }
      `),
    ).toEqual([]);
  });

  it('refuses the four shapes the round-6 review found by hand', () => {
    expect(
      analyse(`
        export function Row({ entry, item }: { entry: any; item: any }) {
          const note = text(entry.note);
          const facts = list(item.facts);
          return (
            <button>
              <span>{entry.heading} · {entry.at}</span>
              {note}
              {facts}
              <span>{entry.tag.label}</span>
            </button>
          );
        }
      `),
    ).toEqual(['entry.heading', 'entry.at', 'note', 'facts', 'entry.tag.label']);
  });

  it('refuses an alias, a branch, a template span and a map element that are not traced', () => {
    expect(
      analyse(`
        export function A({ p }: { p: any }) {
          const alias = p.free;
          return (
            <div>
              {alias}
              {p.flag ? 'ok' : p.free}
              {\`prefix \${p.free}\`}
              {p.items.map((x) => (<span>{x}</span>))}
            </div>
          );
        }
      `),
    ).toEqual([
      'alias',
      "p.flag ? 'ok' : p.free",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the analyser's rendering of a template it REFUSED, quoted back verbatim — the curly is the evidence, not a template written by mistake.
      '`prefix ${p.free}`',
      'x',
    ]);
  });

  it('refuses a prop of an EXPORTED component even when this file only passes literals', () => {
    /* The call sites in this file are not all the call sites: an exported
       component is reachable from anywhere. Reading the local ones and passing is
       exactly the "a route is not the app" mistake, one scope in. */
    expect(
      analyse(`
        export function Chip({ label }: { label: string }) { return <span>{label}</span>; }
        export function Host() { return <Chip label="safe" />; }
      `),
    ).toEqual(['label']);
  });

  it('refuses a local component rendered with a spread, and one never rendered here', () => {
    expect(
      analyse(`
        function Spread({ label }: { label: string }) { return <span>{label}</span>; }
        function Orphan({ label }: { label: string }) { return <span>{label}</span>; }
        export function Host(props: any) { return <Spread {...props} />; }
      `),
    ).toEqual(['label', 'label']);
  });

  it('follows a local component whose prop is a literal at every call site', () => {
    expect(
      analyse(`
        function Section({ label, children }: { label: string; children: any }) {
          return <div><span>{label}</span>{children}</div>;
        }
        export function Host() {
          return <><Section label="WHAT HAPPENED">{'x'}</Section><Section label="PROVENANCE">{'y'}</Section></>;
        }
      `),
    ).toEqual([]);
  });

  it('reports a caller value passed into a local component, at the component', () => {
    expect(
      analyse(`
        function Section({ label }: { label: string }) { return <span>{label}</span>; }
        export function Host({ receipt }: { receipt: any }) { return <Section label={receipt.title} />; }
      `),
    ).toEqual(['label']);
  });

  it('traces a caller RECORD through a local component to the property it prints', () => {
    /* CATCHES the hole round 7's own sweep shipped with and found by running
       itself against r6: the call-site value is a CONTAINER — `<Row entry={entry}/>`
       passes a record, not a string — and checking it in value mode asked "can a
       record be a string", found that it cannot, and passed. That emptied the
       sweep of EVERY local component, which is where all four of the sinks this
       file exists for live. It reported 53 findings on r6 where it should have
       reported 68, and every one of the four named ones was among the fifteen. */
    expect(
      analyse(`
        function Row({ entry }: { entry: { note: string } }) {
          const note = text(entry.note);
          return <div>{note}<span>{entry.heading}</span></div>;
        }
        export function Host({ receipt }: { receipt: any }) {
          return <div>{receipt.provenance.map((entry) => (<Row entry={entry} key={entry.id} />))}</div>;
        }
      `),
    ).toEqual(['note', 'entry.heading']);
  });

  it('refuses rather than passing when it runs out of shapes it understands', () => {
    const findings = analyse(`
      export function A({ p }: { p: any }) { return <div>{p.a ?? unknownCall(p.b)}</div>; }
    `);
    expect(findings).toEqual(['p.a ?? unknownCall(p.b)']);
  });

  it('sees announced-text attributes, not only rendered children', () => {
    expect(
      analyse(`
        export function A({ p }: { p: any }) {
          return <button aria-label={p.free} title={p.free} placeholder={p.free} alt={p.free}>x</button>;
        }
      `),
    ).toEqual(['p.free', 'p.free', 'p.free', 'p.free']);
    expect(ANNOUNCED_ATTRIBUTES).toContain('aria-label');
  });

  it('reads the property that is printed, not the whole object literal', () => {
    /* CATCHES the analysis's own over-refusal, which is a real cost rather than
       a false alarm: the first version reported the gallery's hand-written
       captions because the object holding them ALSO holds a spread, and forcing
       editorial prose through the system-voice door refused the word "says" —
       round 4's mistake, reproduced by round 7's instrument. */
    expect(
      analyse(`
        const FRAMES = [
          { id: 'a', title: 'a caption typed here', props: { ...base, label: 'x' } },
          { id: 'b', title: 'another caption', props: { ...base } },
        ];
        export function Host() {
          return <div>{FRAMES.map((frame) => (<h2 key={frame.id}>{frame.title}</h2>))}</div>;
        }
      `),
    ).toEqual([]);
    /* …and it still refuses the property that IS caller text. */
    expect(
      analyse(`
        export function Host({ p }: { p: any }) {
          const FRAMES = [{ id: 'a', title: p.free, props: { ...base } }];
          return <div>{FRAMES.map((frame) => (<h2 key={frame.id}>{frame.title}</h2>))}</div>;
        }
      `),
    ).toEqual(['frame.title']);
  });

  it('does not mistake an attribute that is not announced for one that is', () => {
    expect(
      analyse(`
        export function A({ p }: { p: any }) { return <div className={p.free} data-x={p.free}>y</div>; }
      `),
    ).toEqual([]);
  });

  /* ---------------------------------------------------------------------------
   * THE NODE-TYPE DENOMINATOR — r8 D4, each shape measured against the r7
   * analyser and found unreported. The control the review ran alongside them,
   * `title={p.free}`, WAS reported — so this was a hole in the SHAPE LIST, not
   * in the dataflow, which is why every one of them gets a row here.
   * ------------------------------------------------------------------------- */

  it('sees `children` written as an attribute, which React renders as children', () => {
    expect(
      analyse(`
        export function A({ p }: { p: any }) { return <div children={p.free} />; }
      `),
    ).toEqual(['p.free']);
  });

  /* THE WIDEST SINK ON THE PLATFORM, and it was outside the count while being
     LIVE at `app/layout.tsx:39` — benign there only because the value happens to
     be a module constant, which is a fact about today's code and not a guard. */
  it('sees dangerouslySetInnerHTML, and reads the __html it writes', () => {
    expect(
      analyse(`
        export function A({ p }: { p: any }) {
          return <div dangerouslySetInnerHTML={{ __html: p.free }} />;
        }
      `),
    ).toEqual(['p.free']);
    /* …and a literal written here is still a literal. */
    expect(
      analyse(`
        const BOOT = 'document.documentElement.dataset.theme = "dark"';
        export function A() { return <script dangerouslySetInnerHTML={{ __html: BOOT }} />; }
      `),
    ).toEqual([]);
  });

  /* THREE MORE STRINGS A SCREEN READER SPEAKS. Driven off the shared list, so
     this fails if an attribute is dropped from `printed-surface.ts` rather than
     only if it is dropped from a copy of it. */
  it.each([...ANNOUNCED_ATTRIBUTES])('sees %s', (attribute) => {
    expect(
      analyse(`
        export function A({ p }: { p: any }) { return <div ${attribute}={p.free}>y</div>; }
      `),
    ).toEqual(['p.free']);
  });

  it('sees the announced attributes the round-8 review named, by name', () => {
    for (const attribute of ['aria-roledescription', 'aria-placeholder', 'aria-keyshortcuts']) {
      expect(ANNOUNCED_ATTRIBUTES, `${attribute} is a string a reader receives`).toContain(
        attribute,
      );
    }
  });

  /* TAG-SCOPED, IN BOTH DIRECTIONS. `label` on an `<optgroup>` is painted by the
     user agent; `label` on a component is an ordinary prop, and `value` on a
     context provider is not text at all — a universal entry would report
     `<LedgerContext.Provider value={ledger}>` and teach the next round that the
     sweep cries wolf. */
  it.each([
    ['optgroup', 'label'],
    ['option', 'label'],
    ['option', 'value'],
    ['input', 'value'],
  ])('sees <%s %s>', (tag, attribute) => {
    expect(
      analyse(`
        export function A({ p }: { p: any }) { return <${tag} ${attribute}={p.free} />; }
      `),
    ).toEqual(['p.free']);
  });

  it('does not read a component’s `label` or `value` prop as painted text', () => {
    expect(
      analyse(`
        export function A({ p }: { p: any }) {
          return <Ctx.Provider value={p.ledger}><Section label={p.heading} /></Ctx.Provider>;
        }
      `),
    ).toEqual([]);
    expect([...TAG_SCOPED_TEXT_ATTRIBUTES.keys()].sort()).toEqual(['input', 'optgroup', 'option']);
  });

  /* THE SAME TREE, WRITTEN THE OTHER WAY. The whole analysis keyed on JSX
     syntax, so a file reaching for the function form was outside the count. */
  it('sees React.createElement, in children and in props', () => {
    expect(
      analyse(`
        export function A({ p }: { p: any }) {
          return createElement('div', null, p.free);
        }
      `),
    ).toEqual(['p.free']);
    expect(
      analyse(`
        export function A({ p }: { p: any }) {
          return React.createElement('span', { title: p.free, className: p.free }, 'literal');
        }
      `),
    ).toEqual(['p.free']);
    expect(
      analyse(`
        export function A({ p }: { p: any }) {
          return createElement('optgroup', { label: p.free });
        }
      `),
    ).toEqual(['p.free']);
    /* …and a literal tree built the function way is still literal. */
    expect(
      analyse(`
        export function A() { return createElement('div', { title: 'written here' }, 'literal'); }
      `),
    ).toEqual([]);
  });

  /* CSS IS THE ONE AUTHORITY THIS LIST CANNOT HOLD. `content: attr(data-x)`
     prints any attribute at all, so the `data-*` sink set is derived from the
     stylesheets — and this exercises the derivation, because an enumerator whose
     current answer is "none" is the one that can break silently. */
  it('derives the CSS-printed attributes from the stylesheets, not from a list', () => {
    expect(attributesPrintedByCss('.x::after { content: attr(data-route); }')).toEqual([
      'data-route',
    ]);
    expect(
      attributesPrintedByCss('.a::before{content:attr( data-A )}.b::after{content:attr(title)}'),
    ).toEqual(['data-a', 'title']);
    expect(attributesPrintedByCss('.x { color: red; }')).toEqual([]);
    /* The measurement on this app, today. If a rule adds an `attr()`, the
       attribute becomes a printed site with no edit to any list here. */
    expect(
      CSS_PRINTED_ATTRIBUTES,
      'a stylesheet prints an attribute; it is a sink now and this list is how the sweep learned it',
    ).toEqual([]);
  });

  /* ---------------------------------------------------------------------------
   * THE PAYLOAD DOOR'S BOUND, SELF-TESTED — r8 D3.
   *
   * The r7 bound was implemented inline in the test with no self-test at all,
   * which is how a predicate that answers a different question than its name
   * says survived a round. It answers the question now, and the shapes it has to
   * accept and the shapes it has to refuse are both written down.
   * ------------------------------------------------------------------------- */
  function offered(source: string): readonly (string | null)[] {
    const file = ts.createSourceFile(
      'probe.tsx',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    return offeredCallSites(file).map((site) => site.host);
  }

  /* ---------------------------------------------------------------------------
   * THE TYPE PREDICATE'S OWN SELF-TEST — r8 D2.
   *
   * The dataflow self-tests stub the type question out (`isFreeString: () =>
   * true`), which is right for exercising the dataflow and means `typeIsFree`
   * itself is exercised by NOTHING except the library as it happens to be
   * written today. Running the r8 ledger against r8's own fix proved that:
   * deleting the intersection branch changed no number and no test, because
   * there is currently no site that prints a `Rationale` raw. The sweep's job is
   * the defect AT ANY ADDRESS, so the predicate needs a check that does not
   * depend on the library having the defect right now.
   *
   * So the predicate gets asked directly, about a program written here. This
   * builds a real `ts.Program` over an in-memory file — the checker is the whole
   * point, and a stubbed checker would be testing the stub.
   * ------------------------------------------------------------------------- */
  function typesIn(source: string): ReadonlyMap<string, boolean> {
    const name = '/probe-types.ts';
    const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const host: ts.CompilerHost = {
      fileExists: (path) => path === name,
      getCanonicalFileName: (path) => path,
      getCurrentDirectory: () => '/',
      getDefaultLibFileName: () => 'lib.d.ts',
      getNewLine: () => '\n',
      getSourceFile: (path) => (path === name ? file : undefined),
      readFile: (path) => (path === name ? source : undefined),
      useCaseSensitiveFileNames: () => true,
      writeFile: () => undefined,
    };
    const program = ts.createProgram({
      host,
      options: { noLib: true, noResolve: true },
      rootNames: [name],
    });
    const checker = program.getTypeChecker();
    const out = new Map<string, boolean>();
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        out.set(node.name.getText(file), typeIsFree(checker.getTypeAtLocation(node.name)));
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return out;
  }

  it('reads a branded string as a free string, because a brand is not a check', () => {
    const answers = typesIn(`
      declare const brand: unique symbol;
      type Rationale = string & { readonly [brand]: 'rationale' };
      type Glyph = '✓' | '◆' | '■';
      declare const branded: Rationale;
      declare const plain: string;
      declare const closed: Glyph;
      declare const optionalClosed: Glyph | undefined;
      declare const anything: any;
      declare const count: number;
      declare const brandedOrNothing: Rationale | undefined;
      const a = branded;
      const b = plain;
      const c = closed;
      const d = optionalClosed;
      const e = anything;
      const f = count;
      const g = brandedOrNothing;
    `);
    /* THE DEFECT: `Rationale = string & {…}` is an INTERSECTION, so
       `type.isUnion()` is false and the old predicate tested the intersection's
       own flags — none of which are `String`. The one branded string in this
       library was counted and never traced, and it is exactly the type whose raw
       render was round 5's finding. */
    expect(answers.get('a'), 'a branded string is a string a cast can fill').toBe(true);
    expect(answers.get('g'), 'a branded string beside undefined is still one').toBe(true);
    expect(answers.get('b')).toBe(true);
    expect(answers.get('e')).toBe(true);
    /* BOTH DIRECTIONS: a closed union of literals is still not caller text, or
       the sweep reports every `Glyph` on the page and stops being read. */
    expect(answers.get('c'), 'a closed union of string literals is not caller text').toBe(false);
    expect(answers.get('d')).toBe(false);
    expect(answers.get('f'), 'a count is not text').toBe(false);
  });

  it('refuses the exact shape the round-7 bound accepted', () => {
    /* A control somewhere in the same function is not the string's destination.
       This source is the r8 review's measurement, reduced. */
    expect(
      offered(`
        export function Card({ item }: { item: any }) {
          return (
            <article title={offeredText(item.title, 'Card summary')}>
              <button>{offeredText(item.action.label, 'Card label')}</button>
            </article>
          );
        }
      `),
    ).toEqual([null, '<button>']);
  });

  it.each([...CONTROL_TAGS])('accepts the copy inside a <%s>', (tag) => {
    expect(
      offered(`
        export function A({ p }: { p: any }) {
          return <${tag} title={offeredText(p.why, 'A')}>x</${tag}>;
        }
      `),
    ).toEqual([`<${tag}>`]);
  });

  /* THE SECOND ACCEPTED SHAPE, which a purely lexical rule would refuse and
     which refusing would make the page worse: `HoldToAct` paints its contract
     line into an `.srOnly` span the button points at, so that span's text IS
     that button's accessible description. */
  it('accepts copy in an element a control names through aria-describedby', () => {
    expect(
      offered(`
        export function Hold({ describe }: { describe: string }) {
          const contract = \`\${offeredText(describe, 'Hold')} — press and hold\`;
          return (
            <>
              <button aria-describedby={describeId} title={contract}>press</button>
              <span id={describeId}>{contract}</span>
            </>
          );
        }
      `),
    ).toEqual(['<button> + <span id={describeId}> named by a control']);
  });

  /* …and follows the const to EVERY use. One unchecked use is an alias that
     launders the door, so the whole call site is refused. */
  it('refuses a const whose uses do not all land on a control', () => {
    expect(
      offered(`
        export function A({ p }: { p: any }) {
          const copy = offeredText(p.why, 'A');
          return (
            <div>
              <button>{copy}</button>
              <p>{copy}</p>
            </div>
          );
        }
      `),
    ).toEqual([null]);
  });

  it('refuses a const nothing in this function reads', () => {
    expect(
      offered(`
        export function A({ p }: { p: any }) {
          const copy = offeredText(p.why, 'A');
          return <button>press</button>;
        }
      `),
    ).toEqual([null]);
  });

  /* AND AN ID A CONTROL DOES NOT POINT AT IS NOT A CONTROL'S COPY — otherwise
     "put it in a span with an id" would be the new loophole. */
  it('refuses an element whose id no control references', () => {
    expect(
      offered(`
        export function A({ p }: { p: any }) {
          return (
            <>
              <button>press</button>
              <span id={loose}>{offeredText(p.why, 'A')}</span>
            </>
          );
        }
      `),
    ).toEqual([null]);
  });

  it('reports an attribute a stylesheet prints, once one does', () => {
    setCssPrintedAttributes(['data-route']);
    try {
      expect(
        analyse(`
          export function A({ p }: { p: any }) { return <div data-route={p.free}>y</div>; }
        `),
      ).toEqual(['p.free']);
    } finally {
      setCssPrintedAttributes(CSS_PRINTED_ATTRIBUTES);
    }
  });
});
