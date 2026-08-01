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

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
 * Every component `RoomFrame` composes, and where its props live.
 *
 * `ObjectRow` and `AttentionCompact` are reached THROUGH a composed component
 * rather than directly, so the frame cannot pass their props itself — what it
 * owes is a path, and the path is the parent's own handler. They are listed with
 * the parent that must forward them, so the chain is enumerated rather than
 * assumed to be complete at the first hop.
 */
const COMPOSED: readonly { readonly element: string; readonly source: string }[] = [
  { element: 'Rail', source: 'apps/web/src/components/frame/Rail.tsx' },
  { element: 'StateLens', source: 'apps/web/src/components/lens/StateLens.tsx' },
  { element: 'Pin', source: 'apps/web/src/components/attention/Pin.tsx' },
  { element: 'Timeline', source: 'apps/web/src/components/timeline/Timeline.tsx' },
  { element: 'Composer', source: 'apps/web/src/components/frame/Composer.tsx' },
  { element: 'SurfaceIndicators', source: 'apps/web/src/components/frame/SurfaceIndicators.tsx' },
  { element: 'CrossRoomJump', source: 'apps/web/src/components/attention/CrossRoomJump.tsx' },
];

/**
 * EVERY COMPONENT-TO-COMPONENT EDGE IN THE LIBRARY, DERIVED.
 *
 * This was a HAND-MAINTAINED list of six edges, inside a test whose entire
 * purpose is to replace a hand-maintained claim with a count — and the blind
 * cross-lineage review of round 6's own fix said so, naming four edges it did
 * not contain (`Pin → AttentionCard`, `StateLens → ObjectiveGroup`,
 * `Timeline → SinceYouLeftDivider`, `Timeline → RoutineCollapse`). A list of
 * edges is exactly the artifact that goes stale the day a component is added,
 * and it reports as thoroughly as a complete one.
 *
 * So the edges are read out of the source: every component file, every JSX
 * element in it whose tag names another component in the library, is an edge.
 * Adding a component to the library adds its edges on the day it is added.
 */
const COMPONENT_FILES: readonly { readonly name: string; readonly source: string }[] = [
  'frame/AppFrame',
  'frame/Composer',
  'frame/Rail',
  'frame/RoomHead',
  'frame/SurfaceIndicators',
  'timeline/Timeline',
  'timeline/TimelineRow',
  'timeline/SystemRow',
  'timeline/RoutineCollapse',
  'timeline/SinceYouLeftDivider',
  'lens/StateLens',
  'lens/ObjectiveGroup',
  'lens/ObjectRow',
  'lens/ReceiptView',
  'attention/Pin',
  'attention/AttentionCard',
  'attention/AttentionCompact',
  'attention/CrossRoomJump',
  'attention/Trailer',
  'primitives/HoldToAct',
  'primitives/Glyph',
  'primitives/ClaimText',
  'primitives/MessageBody',
  'primitives/Voice',
].map((path) => ({
  name: path.split('/')[1] as string,
  source: `apps/web/src/components/${path}.tsx`,
}));

const BY_NAME = new Map(COMPONENT_FILES.map((entry) => [entry.name, entry.source]));

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

const FRAME = 'apps/web/app/gallery/RoomFrame.tsx';

describe('the frame forwards every handler the library exposes', () => {
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
