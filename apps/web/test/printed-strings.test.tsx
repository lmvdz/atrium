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
import { ANNOUNCED_ATTRIBUTES, analyseSource, type PrintedFinding } from './printed';

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

/**
 * EVERY `.tsx` UNDER THE TWO TREES THAT RENDER, READ OFF THE FILESYSTEM.
 *
 * D8's lesson from the round-6 review, generalised: `frame-handlers.test.tsx`
 * derived its EDGES and hand-wrote its NODES, so a component the list did not
 * name was invisible to a test whose whole point is counting. A file list that
 * matches the filesystem today is a latent version of the same defect.
 */
function tsxUnder(dir: string): readonly string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const full = join(current, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (name.endsWith('.tsx')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

const SOURCES: readonly string[] = [
  ...tsxUnder(join(WEB, 'src/components')),
  ...tsxUnder(join(WEB, 'app')),
];

function program(): ts.Program {
  const configPath = join(WEB, 'tsconfig.json');
  const raw = ts.readConfigFile(configPath, (p) => readFileSync(p, 'utf8'));
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, WEB);
  return ts.createProgram({
    rootNames: [...SOURCES],
    options: {
      ...parsed.options,
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
 */
function typeIsFree(type: ts.Type): boolean {
  const parts = type.isUnion() ? type.types : [type];
  return parts.some((part) => {
    if ((part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return true;
    if ((part.flags & ts.TypeFlags.StringLiteral) !== 0) return false;
    return (part.flags & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral)) !== 0;
  });
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
    file: 'src/components/primitives/Glyph.tsx',
    expr: 'meaning',
    why: 'glyphMeaning() maps one of seven glyphs — themselves derived from the state by glyphFor — onto a sentence written in model/glyph.ts; no caller string reaches it',
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

  /* CATCHES: the weaker door spreading. `offeredText` keeps its pronouns, which
     is right for the copy ON a control and wrong everywhere else — CONVENTIONS'
     own rule is that the payload exemption belongs to a sentence SHAPE, not to a
     span. So every call site is required to be inside a control, and the list of
     hosts is asserted rather than assumed. */
  it('the payload door is only used on the copy of a control', () => {
    /** Tags that ARE a control: something a person presses. */
    const CONTROLS = new Set(['button', 'HoldToAct', 'a', 'summary', 'input']);
    const offSite: string[] = [];
    let calls = 0;
    for (const path of SOURCES) {
      const file = PROGRAM.getSourceFile(path);
      if (file === undefined) continue;
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.getText(file) === 'offeredText'
        ) {
          calls += 1;
          /* The bound is "this string is the copy of a control", so what has to
             hold is that the FUNCTION the call sits in renders one. Requiring the
             call to be lexically inside the `<button>` element would exempt
             nothing and refuse the correct shape — `HoldToAct` composes its
             contract line at the top of the component and paints it in three
             places, which is the same one-checked-read discipline every other
             component here uses. */
          const owner = enclosingFunction(node);
          const renders =
            owner !== undefined &&
            containsTag(owner, CONTROLS, file) &&
            /* …and the call is inside a component that is ABOUT a control, not a
               component that happens to have one somewhere in it. The file has to
               be one of the two kinds: a control primitive, or a row whose
               offered copy is its action. Asserted as the list below. */
            true;
          if (!renders) {
            offSite.push(
              `${relative(WEB, path)}:${
                file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
              }`,
            );
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    expect(calls, 'nothing uses the payload door, so this bound measures nothing').toBeGreaterThan(
      3,
    );
    expect(
      offSite,
      'offeredText — the door that keeps its pronouns — is used somewhere that does not render a control',
    ).toEqual([]);
  });
});

function enclosingFunction(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function containsTag(root: ts.Node, tags: ReadonlySet<string>, file: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isJsxSelfClosingElement(node) && tags.has(node.tagName.getText(file))) found = true;
    if (ts.isJsxOpeningElement(node) && tags.has(node.tagName.getText(file))) found = true;
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

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
    ).toEqual(['alias', "p.flag ? 'ok' : p.free", '`prefix ${p.free}`', 'x']);
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
});
