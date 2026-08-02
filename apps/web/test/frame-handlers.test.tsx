/* ---------------------------------------------------------------------------
 * EVERY HANDLER THE LIBRARY EXPOSES IS FORWARDED — COUNTED, NOT ASSERTED.
 *
 * `app/gallery/RoomFrame.tsx` has carried that sentence as a COMMENT since round
 * 2, when the gauntlet found `/` rendering the whole component library and
 * forwarding none of it: "a screen of controls that did nothing when clicked."
 * Round 2's fix added the handlers round 2 named. Round 6's critic clicked all
 * 53 visible controls and found 17 still dead — the four rail room chips, both
 * objective disclosure triangles, all ten state-object rows — because `Rail`
 * declares `onSelectRoom`, `StateLens` declares `onToggleObjective` and
 * `onOpenReceipt`, `ObjectRow` declares `onOpenReceipt`, and `RoomFrameHandlers`
 * declared none of the three.
 *
 * CONVENTIONS recorded round 2 as HISTORY. History does not fail a build. This
 * is the standing rule with a counting test behind it: every `on*` prop declared
 * by a component the frame composes is enumerated from that component's own
 * source, and the frame must pass a value for it. The enumeration is mechanical,
 * so a component that grows a seventh seam next month is covered on the day it
 * grows it rather than on the day somebody remembers.
 *
 * PARSED, NOT GREPPED (D2's corollary): props are read from the TypeScript AST,
 * and a JSX attribute is matched on the element it is attached to, because an
 * opening tag in this codebase routinely runs to eight lines and a line scan
 * would attribute a prop to whichever element happened to be nearest.
 * ------------------------------------------------------------------------- */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { cleanup, fireEvent, render } from '@testing-library/react';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as f from '../app/gallery/fixtures';
import { RoomFrame } from '../app/gallery/RoomFrame';

afterEach(cleanup);

function find(relative: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = resolve(dir, relative);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`${relative} not found above ${process.cwd()}`);
}

function parse(relative: string): ts.SourceFile {
  const path = find(relative);
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
}

/**
 * Every `on*` member of every `*Props` type in a component file.
 *
 * `*Props` and not every type, because a component file also declares value
 * types: `RowAction` carries an `onSelect` that reaches the row inside an
 * `actions` array rather than as a JSX attribute, and demanding a JSX attribute
 * for it would make this check fail on correct code. Narrowing to the props type
 * is the honest scope — "what does a caller pass to this component" — rather
 * than "what identifier in this file starts with on".
 */
function handlersDeclaredBy(relative: string): readonly string[] {
  const file = parse(relative);
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    const named =
      (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
      node.name.getText(file).endsWith('Props');
    const members = !named
      ? undefined
      : ts.isInterfaceDeclaration(node)
        ? node.members
        : ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)
          ? node.type.members
          : ts.isTypeAliasDeclaration(node) && ts.isIntersectionTypeNode(node.type)
            ? node.type.types.flatMap((t) => (ts.isTypeLiteralNode(t) ? [...t.members] : []))
            : undefined;
    if (members !== undefined) {
      for (const member of members) {
        const name = member.name?.getText(file);
        if (name !== undefined && /^on[A-Z]/.test(name)) out.add(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...out];
}

/** Every JSX tag name a file renders. */
function jsxTagsIn(relative: string): readonly string[] {
  const file = parse(relative);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxSelfClosingElement(node)) out.push(node.tagName.getText(file));
    if (ts.isJsxOpeningElement(node)) out.push(node.tagName.getText(file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/** Every prop of every `*Props` type in a component file whose type is `Slot`. */
function slotPropsIn(relative: string): readonly string[] {
  const file = parse(relative);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertySignature(node) && node.type !== undefined) {
      const printed = node.type.getText(file).replace(/\s+/g, ' ');
      if (/^Slot(\s*\|\s*undefined)?$/.test(printed)) out.push(node.name.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/** Every `<X …/>` handed to `slot(...)` in a file. */
function slotFillsIn(relative: string): readonly string[] {
  const file = parse(relative);
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'slot') {
      const inner = (child: ts.Node): void => {
        if (ts.isJsxSelfClosingElement(child)) out.add(child.tagName.getText(file));
        if (ts.isJsxOpeningElement(child)) out.add(child.tagName.getText(file));
        ts.forEachChild(child, inner);
      };
      for (const argument of node.arguments) inner(argument);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...out];
}

/** Which props the frame passes to `<Name …>`, by reading the JSX element. */
function propsPassedTo(relative: string, element: string): readonly string[] {
  const file = parse(relative);
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    const opening = ts.isJsxSelfClosingElement(node)
      ? node
      : ts.isJsxElement(node)
        ? node.openingElement
        : undefined;
    if (opening !== undefined && opening.tagName.getText(file) === element) {
      for (const attribute of opening.attributes.properties) {
        if (ts.isJsxAttribute(attribute)) out.add(attribute.name.getText(file));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...out];
}

/**
 * EVERY COMPONENT FILE IN THE LIBRARY, READ OFF THE FILESYSTEM.
 *
 * ROUND 7, D8 AND THE HALF OF D3 THAT MADE IT INVISIBLE. Round 6 derived the
 * EDGES and left the NODES hand-written — a 24-path list inside the test whose
 * entire purpose is to replace a hand-maintained claim with a count.
 * `harness-integrity.test.ts` asserted the edges were derived and never asked
 * where the node set came from, so the derivation was exactly as complete as
 * somebody's memory. It matched the filesystem on the day it was written, which
 * is what "latent" means.
 */
function componentFiles(): readonly { readonly name: string; readonly source: string }[] {
  const root = find('apps/web/src/components');
  const out: { name: string; source: string }[] = [];
  for (const area of readdirSync(root).sort()) {
    const dir = join(root, area);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith('.tsx')) continue;
      out.push({
        name: file.replace(/\.tsx$/, ''),
        source: `apps/web/src/components/${area}/${file}`,
      });
    }
  }
  return out;
}

const COMPONENT_FILES = componentFiles();

/**
 * The component modules the library's own barrel re-exports — the SECOND
 * authority on "what is a component of this library", and the one the app
 * actually imports through.
 *
 * `./model` is a directory of value modules rather than a component, and its one
 * `.tsx` (`ledger.tsx`) is reached through it; it is named here so the
 * comparison is between two complete sets rather than two sets with a hole in
 * the same place.
 */
const BARREL_MODULES: ReadonlySet<string> = new Set(
  [
    ...readFileSync(find('apps/web/src/components/index.ts'), 'utf8').matchAll(
      /from '\.\/([\w-]+)\/([\w-]+)'/g,
    ),
  ]
    .map((hit) => hit[2] as string)
    .concat('ledger'),
);

const BY_NAME = new Map(COMPONENT_FILES.map((entry) => [entry.name, entry.source]));

const FRAME_SOURCE = 'apps/web/app/gallery/RoomFrame.tsx';

/**
 * Every component `RoomFrame` composes, DERIVED from the frame rather than
 * listed. Round 6 wrote seven of them down by hand; the same argument that made
 * the edge list a derivation makes this one.
 *
 * `ObjectRow` and `AttentionCompact` are reached THROUGH a composed component
 * rather than directly, so the frame cannot pass their props itself — what it
 * owes is a path, and the path is the parent's own handler. The second-hop check
 * below covers those.
 */
const COMPOSED: readonly { readonly element: string; readonly source: string }[] = [
  ...new Set(jsxTagsIn(FRAME_SOURCE)),
]
  .filter((tag) => BY_NAME.has(tag))
  .map((tag) => ({ element: tag, source: BY_NAME.get(tag) as string }))
  .sort((a, b) => a.element.localeCompare(b.element));

/**
 * A COMPONENT REACHED THROUGH AN OPAQUE VALUE IS INVISIBLE TO JSX DERIVATION —
 * SO IT IS ENUMERATED FROM THE TYPE OF THE HOLE INSTEAD.
 *
 * ROUND 7, D3. `ReceiptView` was in neither of round 6's hand-written lists AND
 * COULD NOT BE: it reaches the screen through a `Slot` (`StateLens` renders
 * `receipt.node`), so no `<ReceiptView>` JSX exists in any file the edge
 * derivation scanned, and the two files that do render it — `RoomSession` and
 * `gallery/page` — were not in the scan set. Its `onBack`, `onReopen` and
 * `onJump` were required by nothing. Deleting `onJump` from `RoomSession`'s
 * `<ReceiptView>` killed five visible controls with `tsc` at 0, 675 unit tests
 * green and 73 e2e green.
 *
 * The general rule, which now belongs in CONVENTIONS: when a component is
 * reached through an opaque value — a `Slot`, a render prop, `cloneElement`, a
 * dynamic import — JSX derivation cannot see the edge, so ENUMERATE IT FROM THE
 * TYPE OF THE HOLE. Every prop in the library declared `Slot` is a hole; every
 * `slot(<X …/>)` in the app is something filling one; and the filler owes `X`
 * every handler `X` declares, exactly as a parent owes its child.
 */
const SLOT_HOLES: readonly { readonly component: string; readonly prop: string }[] =
  COMPONENT_FILES.flatMap((entry) =>
    slotPropsIn(entry.source).map((prop) => ({
      component: entry.name,
      prop,
    })),
  );

/** Files that can fill a hole: everything under `app` that renders. */
function appFiles(): readonly string[] {
  const root = find('apps/web/app');
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (name.endsWith('.tsx')) out.push(full.slice(full.indexOf('apps/web/')));
    }
  };
  walk(root);
  return out;
}

const APP_FILES = appFiles();

/** Every `slot(<X …/>)` in the app, where X is a library component. */
const SLOT_FILLS: readonly {
  readonly filler: string;
  readonly child: string;
  readonly childSource: string;
}[] = APP_FILES.flatMap((source) =>
  slotFillsIn(source)
    .filter((child) => BY_NAME.has(child))
    .map((child) => ({ filler: source, child, childSource: BY_NAME.get(child) as string })),
);

/** Every `<Child …>` a component file renders, where Child is in the library. */
function edgesFrom(parent: { name: string; source: string }): readonly {
  parent: string;
  parentSource: string;
  child: string;
  childSource: string;
}[] {
  const file = parse(parent.source);
  const seen = new Set<string>();
  const visit = (node: ts.Node): void => {
    const opening = ts.isJsxSelfClosingElement(node)
      ? node
      : ts.isJsxElement(node)
        ? node.openingElement
        : undefined;
    if (opening !== undefined) {
      const tag = opening.tagName.getText(file);
      if (BY_NAME.has(tag) && tag !== parent.name) seen.add(tag);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...seen].map((child) => ({
    parent: parent.name,
    parentSource: parent.source,
    child,
    childSource: BY_NAME.get(child) as string,
  }));
}

const FORWARDED = COMPONENT_FILES.flatMap(edgesFrom);

/**
 * Handlers a parent legitimately does not forward, each with the reason.
 *
 * Checked exhaustive in BOTH directions, like every other exemption list this
 * round added: an entry matching nothing is a carve-out that outlived its
 * subject and reports exactly like one doing its job.
 */
const NOT_FORWARDED: readonly {
  readonly edge: string;
  readonly handler: string;
  readonly why: string;
}[] = [];

const FRAME = FRAME_SOURCE;

describe('the frame forwards every handler the library exposes', () => {
  /* CATCHES: the NODE SET going stale — the half round 6 left hand-written
     inside the test whose purpose is counting, and the half that made
     `ReceiptView` structurally invisible. Both lists are derivations now, so a
     component added to the library is covered on the day it is added. */
  it('the component list is the filesystem, and the frame’s children are read off the frame', () => {
    const onDisk = COMPONENT_FILES.map((entry) => entry.name);
    /* A SECOND AUTHORITY, NOT THE SAME FUNCTION TWICE — r8, the critic's one
       soft spot in an otherwise honest ledger. This line used to read
       `expect(COMPONENT_FILES…).toEqual(componentFiles()…)`: the same function
       on both sides of the equals, which catches a post-hoc FILTER (and the
       ledger has a row for exactly that) and cannot catch a WEAKENED ENUMERATOR
       — narrow `readdirSync` to one directory, or the extension to `.ts`, and
       both sides move together and agree.
       The barrel is a genuinely different authority: `src/components/index.ts`
       is the module the app imports from, maintained by hand for a different
       reason, and every component module is named in it. Both directions, so a
       file that stops being exported and a file that stops being enumerated are
       each a diff. */
    expect(
      onDisk.filter((name) => !BARREL_MODULES.has(name)),
      'a component file the library’s own barrel does not export',
    ).toEqual([]);
    expect(
      [...BARREL_MODULES].filter((name) => !onDisk.includes(name)).sort(),
      'the barrel exports a module this enumeration cannot see',
    ).toEqual([]);
    expect(onDisk.length, 'the component sweep found almost no files').toBeGreaterThan(20);
    expect(onDisk, 'the component sweep cannot see the receipt').toContain('ReceiptView');
    expect(COMPOSED.length, 'the frame composes almost nothing').toBeGreaterThan(5);
    /* …and the derivation is not a spelling of the old hand-written list: it
       found what the list found, from the frame. */
    expect(COMPOSED.map((c) => c.element)).toContain('Rail');
    expect(COMPOSED.map((c) => c.element)).toContain('CrossRoomJump');
  });

  /* CATCHES: the enumeration going blind. If no component declares a handler,
     every assertion below is vacuous — and a vacuous check reports exactly like
     a passing one, which is how `graphicsChecked > 10` survived. */
  it('there is something to enumerate', () => {
    const total = COMPOSED.reduce((n, c) => n + handlersDeclaredBy(c.source).length, 0);
    expect(total, 'no composed component declares a handler at all').toBeGreaterThan(20);
  });

  /* CATCHES the round-2 defect at any address, including the three it kept for
     four more rounds. */
  it.each(COMPOSED)('$element gets every handler it declares', ({ element, source }) => {
    const declared = handlersDeclaredBy(source);
    const passed = new Set(propsPassedTo(FRAME, element));
    expect(
      declared.filter((handler) => !passed.has(handler)),
      `${element} declares handlers the frame never passes`,
    ).toEqual([]);
  });

  /* CATCHES the same defect ONE HOP IN. A frame that forwards to `StateLens` and
     a `StateLens` that drops the prop on the way to `ObjectRow` is a dead
     control with a live prop table, which is exactly what the ten object rows
     were. The chain is what has to be complete, not the first link. */
  it('there are edges to enumerate, and more than the six a person listed', () => {
    expect(
      FORWARDED.length,
      'the edge derivation found almost no component-to-component edges',
    ).toBeGreaterThan(10);
  });

  /* CATCHES an exemption that outlived its subject. The list is empty today —
     every derived edge forwards everything — and it is asserted empty-or-used
     rather than merely declared, because an entry matching nothing reports
     exactly like one doing its job. */
  it('every forwarding exemption still applies to something', () => {
    const edges = new Set(FORWARDED.map((link) => `${link.parent}→${link.child}`));
    expect(
      NOT_FORWARDED.filter(
        (entry) =>
          !edges.has(entry.edge) ||
          !handlersDeclaredBy(
            FORWARDED.find((link) => `${link.parent}→${link.child}` === entry.edge)?.childSource ??
              '',
          ).includes(entry.handler),
      ).map((entry) => `${entry.edge}.${entry.handler}`),
      'a forwarding exemption names an edge or a handler that no longer exists',
    ).toEqual([]);
  });

  /* ---------------------------------------------------------------------------
   * THE EDGE JSX DERIVATION CANNOT SEE.
   *
   * ROUND 7, D3. `StateLens` renders `receipt.node` — an opaque value — so there
   * is no `<ReceiptView>` anywhere in the library for `edgesFrom` to find, and
   * the app files that DO render one were outside the scan. The receipt's three
   * seams were therefore required by nothing: deleting `onJump` from
   * `RoomSession`'s `<ReceiptView>` took the receipt's only outbound navigation
   * — five visible controls — dead, with tsc 0, 675 unit tests green and 73 e2e
   * green. The browser backstop missed it too, because `e2e/smoke.spec.ts` swept
   * `/` in its initial state, where `receiptId === null`.
   * ------------------------------------------------------------------------- */
  it('every Slot-typed hole in the library is filled by something this sweep can see', () => {
    expect(SLOT_HOLES.length, 'the library declares no composition holes').toBeGreaterThan(4);
    expect(
      SLOT_HOLES.map((hole) => `${hole.component}.${hole.prop}`),
      'the receipt’s hole is not enumerated',
    ).toContain('StateLens.receipt');
    /* And something actually fills them. A hole with no known filler is a
       component nothing in this sweep can reach — report it rather than let the
       edge derivation quietly return an empty set. */
    expect(SLOT_FILLS.length, 'no app file fills a Slot with a library component').toBeGreaterThan(
      3,
    );
    expect(
      SLOT_FILLS.map((fill) => fill.child),
      'nothing in the app is seen filling a hole with the receipt',
    ).toContain('ReceiptView');
    expect(APP_FILES.length, 'the app sweep found almost no files').toBeGreaterThan(3);
  });

  it.each(SLOT_FILLS)('$filler fills a slot with $child and passes its handlers', (fill) => {
    const declared = handlersDeclaredBy(fill.childSource);
    const passed = new Set(propsPassedTo(fill.filler, fill.child));
    expect(
      declared.filter((handler) => !passed.has(handler)),
      `${fill.filler} hands ${fill.child} across a slot and drops handlers on the way`,
    ).toEqual([]);
  });

  it.each(FORWARDED)('$parent forwards every handler $child declares', (link) => {
    const declared = handlersDeclaredBy(link.childSource);
    const passed = new Set(propsPassedTo(link.parentSource, link.child));
    const key = `${link.parent}→${link.child}`;
    const missing = declared.filter(
      (handler) =>
        !passed.has(handler) &&
        !NOT_FORWARDED.some((entry) => entry.edge === key && entry.handler === handler),
    );
    expect(missing, `${link.parent} drops handlers on the way to ${link.child}`).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------
 * AND THE FORWARDING IS REAL, not a prop name that reaches a component and dies.
 * Rendered, clicked, observed — the source sweep above cannot tell a wired
 * handler from a named one.
 * ------------------------------------------------------------------------- */
describe('the three seams round 6 found dead are live', () => {
  function frame(handlers: Parameters<typeof RoomFrame>[0]['handlers']) {
    return render(
      <RoomFrame
        attention={f.ATTENTION}
        binding={f.FREE}
        composerNote="note"
        entries={f.QUIET_TIMELINE}
        filtered={false}
        focused="conversation"
        handlers={handlers}
        humans={f.HUMANS}
        lastCheck="12:29"
        messages={f.RECORDS}
        objectives={f.OBJECTIVES}
        objects={f.OBJECTS}
        room={f.ROOM}
        rooms={f.ROOMS}
        trailer={f.TRAILER}
        updatedAt="13:41"
        viewer={f.VIEWER}
        viewerNote="here"
      />,
    );
  }

  it('a rail room chip selects a room', () => {
    const onSelectRoom = vi.fn();
    const { container } = frame({ onSelectRoom });
    const chip = container.querySelector('nav button');
    expect(chip, 'the rail renders no room chips').not.toBeNull();
    fireEvent.click(chip as Element);
    expect(onSelectRoom).toHaveBeenCalledWith(f.ROOMS[0]?.id);
  });

  it('an objective triangle toggles the objective that is collapsed', () => {
    const onToggleObjective = vi.fn();
    const { container } = frame({ onToggleObjective });
    /* The COLLAPSED one specifically: it hid four objects, two of which need
       this person, behind a control nothing was wired to. */
    const collapsed = container.querySelector('[data-objective-id="o2"] button[aria-expanded]');
    expect(collapsed?.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(collapsed as Element);
    expect(onToggleObjective).toHaveBeenCalledWith('o2');
  });

  it('every state-object row opens its receipt', () => {
    const onOpenReceipt = vi.fn();
    const { container } = frame({ onOpenReceipt });
    const rows = [...container.querySelectorAll('[data-object-id]')];
    expect(rows.length, 'the lens renders no object rows').toBeGreaterThan(0);
    for (const row of rows) {
      fireEvent.click(row);
      expect(
        onOpenReceipt,
        `the row for ${row.getAttribute('data-object-id')} opened nothing`,
      ).toHaveBeenCalledWith(row.getAttribute('data-object-id'));
    }
    expect(onOpenReceipt).toHaveBeenCalledTimes(rows.length);
  });

  it('the trailer’s lead is a control, and it shows what is outside the pin', () => {
    const onShowRest = vi.fn();
    const { container } = frame({ onShowRest });
    const lead = container.querySelector('[data-trailer-lead]');
    expect(lead?.tagName, 'the trailer lead is not a control').toBe('BUTTON');
    fireEvent.click(lead as Element);
    expect(onShowRest).toHaveBeenCalled();
  });
});
