/* ---------------------------------------------------------------------------
 * COMPOSITION SLOTS — the hole the round-1 gauntlet found in the no-synthesized-
 * speech enforcement.
 *
 * `AppFrame` took four `ReactNode` props, `StateLens` took a `receipt`, and
 * `ClaimText` took `children`. `ReactNode` is the widest type in React: a
 * consumer could hand `<q>words priya never wrote</q>` straight through a slot
 * with no cast and no constructor, and every quotation guarantee in
 * model/quotation.ts would be beside the point.
 *
 * Slots are now `Slot` values rather than `ReactNode`, and `slot()` is the only
 * constructor. Two layers, and it is worth being precise about which is which:
 *
 *   TYPE LEVEL — `Slot` carries a phantom brand keyed by a module-private
 *   `unique symbol`, so `<AppFrame rail={<div/>} …>` does not compile. You have
 *   to go through `slot()`. Like every brand in this codebase that only stops a
 *   TypeScript author; it is a convention with teeth, not a guarantee.
 *
 *   RUNTIME — `slot()` walks the element tree it was handed and throws on
 *   attributed markup: a `<q>`, a `<blockquote>`, a `cite`, a `data-quoted`
 *   attribute, or a `dangerouslySetInnerHTML`. It puts every raw string it can
 *   reach — as content, and as an ANNOUNCED ATTRIBUTE (`title`, `alt`,
 *   `aria-label`, an `<optgroup label>` …) — through `systemText`. And the walk
 *   is TOTAL: every shape `ReactNode` can be is answered, and anything else is
 *   refused rather than returned on. That is what actually holds when the caller
 *   is JavaScript, or when someone reaches for a cast.
 *
 * What the walk deliberately cannot see: the *output* of a component element.
 * `slot(<Quoted quote={q} />)` passes, because `Quoted` is a function whose
 * render output does not exist yet — and it should pass, because `Quoted` takes
 * a `Quotation` and cannot be handed page-authored text in the first place.
 * The walk exists to stop RAW attributed markup, which is the only way to get
 * quotation-shaped output without going through model/quotation.ts.
 * ------------------------------------------------------------------------- */

import { isValidElement, type ReactNode } from 'react';
import { announcesText } from './printed-surface';
import { systemText } from './quotation';

declare const slotBrand: unique symbol;

/** Content a component will render in a hole it does not control. */
export interface Slot {
  readonly node: ReactNode;
  readonly [slotBrand]: 'slot';
}

/** Intrinsic elements that render as somebody's quoted words. Lowercase — every
    comparison against this set lowercases first, because `<Q>` is a `<q>`. */
const ATTRIBUTED_TAGS: ReadonlySet<string> = new Set(['q', 'blockquote', 'cite']);

/**
 * Props that smuggle attribution past the tag check.
 *
 * `data-attribution` was missing until the round-5 blind review, and it is the
 * DOM token this codebase's own tests read to prove a name came from a record —
 * so raw markup carrying `data-attribution="m14"` beside a free name passed
 * through a slot AND satisfied every check written against that attribute. A
 * provenance token a slot can mint is a provenance token that proves nothing.
 */
const ATTRIBUTED_PROPS: readonly string[] = [
  'data-quoted',
  'data-attribution',
  'cite',
  'dangerouslySetInnerHTML',
];

/** The same list, folded, because the comparison folds. */
const ATTRIBUTED_PROPS_FOLDED: ReadonlySet<string> = new Set(
  ATTRIBUTED_PROPS.map((key) => key.toLowerCase()),
);

/** A tree this deep in a slot is a bug of its own; the cap keeps the walk O(1)-ish. */
const MAX_NODES = 500;

/**
 * `$$typeof` of a portal. React exports no predicate for one — `isValidElement`
 * is deliberately false for portals — so the tag is read the way React reads it.
 */
const PORTAL_TYPE: symbol = Symbol.for('react.portal');

/**
 * EVERY SHAPE `ReactNode` CAN BE, WRITTEN DOWN, BECAUSE THE WALK IS NOW TOTAL.
 *
 * React's own type is a closed union:
 *
 *   ReactElement | string | number | bigint | boolean | null | undefined
 *   | Iterable<ReactNode> | ReactPortal | Promise<AwaitedReactNode>
 *
 * and this walk answers for all ten. Anything else is not a `ReactNode` at all —
 * React itself throws "Objects are not valid as a React child" — so refusing it
 * costs nothing and closes the class.
 *
 * That closure is the point. Until r8 the walk `return`ed on everything it did
 * not recognise, which made a denylist of container shapes out of what reads like
 * an allowlist: `Array.isArray` missed a `Set` (found in r6), and
 * `isValidElement` missed a PORTAL (found in r8) — a portal's `$$typeof` is
 * `REACT_PORTAL_TYPE`, `isValidElement` is false, the walk returned, and
 *
 *   slot(createPortal(<q data-quoted="msg:forged">words priya never wrote</q>, host))
 *
 * validated while React rendered the `<q>` — minting the exact provenance token
 * r5 added to `ATTRIBUTED_PROPS` because "a provenance token a slot can mint is a
 * provenance token that proves nothing". Two rounds, two container shapes, one
 * defect: A WALK THAT RECURSES ON RECOGNISED SHAPES AND RETURNS ON THE REST IS AN
 * ALLOWLIST THAT FAILS OPEN. So the rest is a refusal now, and the enumeration
 * above is what makes that safe to say rather than merely strict.
 */
function refuseUnknown(node: object): never {
  const shape =
    (node as { constructor?: { name?: string } }).constructor?.name ??
    Object.prototype.toString.call(node);
  reject(
    `a ${shape} is not a shape this walk can check, so it is not a shape a slot may carry — ` +
      'React renders elements, strings, numbers, booleans, iterables, portals and promises, ' +
      'and everything a slot puts in front of a reader has to be walked, not assumed harmless',
  );
}

function reject(what: string): never {
  throw new Error(
    `slot: ${what} — a composition slot may not carry attributed markup. Text that is a person's words goes through model/quotation.ts and renders via <Quoted>; text the page authored is a SystemStatement and renders via <SystemVoice>.`,
  );
}

function walk(node: ReactNode, budget: { left: number }): void {
  /* FAIL CLOSED. This used to `return` when the budget ran out, so a tree of 501
     harmless nodes with a <q> at the end walked past the cap and validated —
     an unchecked subtree reported exactly like a checked one. A cap is a bound
     on work, not a licence to stop checking: past it the answer is "I could not
     check this", which is a refusal. Found by the round-5 blind review. */
  if (budget.left <= 0) {
    reject(
      `a slot tree larger than ${MAX_NODES} nodes could not be checked to the end; ` +
        'a subtree nothing walked is a subtree nothing validated',
    );
  }
  budget.left -= 1;

  if (node === null || node === undefined || typeof node === 'boolean') return;
  /* A number and a bigint are both rendered, and neither can be a sentence.
     `bigint` used to reach `isValidElement`, come back false, and be accepted by
     the fall-through — the same door the portal walked through, on a value that
     happened to be harmless. */
  if (typeof node === 'number' || typeof node === 'bigint') return;
  /* A RAW STRING IN A SLOT IS A STRING THE PAGE PRINTS, AND THIS IS ITS ONLY
     DOOR. Round 7: the walk returned here, so `slot(object.text)` and
     `slot(receipt.title)` handed a caller's sentence through a hole whose whole
     purpose is to stop caller content, and `ClaimText` printed `content.node`
     with nothing between the two. The tag and prop denylists were looking for
     markup; a bare string is not markup and was never looked at.
     Held to the SYSTEM's voice, not the offered-copy rule: a slot is a
     composition hole in the page's own chrome, never the label of a control. A
     person's words reach a slot as `<Quoted>` or `<MessageBody>`, which are
     elements, and the walk stops at a component boundary. */
  if (typeof node === 'string') {
    systemText(node, 'slot');
    return;
  }

  /* ANY ITERABLE, NOT ONLY AN ARRAY. Found by the blind cross-lineage review of
     round 6's own fix: React renders any `Iterable<ReactNode>`, and this walk
     tested `Array.isArray`. A `Set` therefore fell through to `isValidElement`,
     came back false, and was accepted in silence — so
     `slot(new Set([<q>words priya never wrote</q>]))` validated, and React
     rendered the `<q>`. A denylist that does not see the shape the platform
     accepts is the case-sensitivity defect this round already fixed, in the
     other axis: there it was a spelling, here it is a container. */
  if (typeof node === 'object' && node !== null && Symbol.iterator in node) {
    for (const child of node as Iterable<ReactNode>) walk(child, budget);
    return;
  }

  /* A PORTAL IS A CONTAINER, AND ITS CONTENTS ARE STILL THE SLOT'S. Found by the
     r8 blind review; see `refuseUnknown` for the full account. React renders a
     portal's `children` exactly as it renders any other children — somewhere
     else in the document, which is a fact about WHERE and not about WHAT — so
     the content guarantee has to hold for them too. What a slot cannot promise
     about a portal is its DESTINATION: `containerInfo` is a live DOM node the
     walk has no opinion on, and `slot()` has never made a layout claim. */
  if (typeof node === 'object' && node !== null && '$$typeof' in node) {
    const tag = (node as { $$typeof: unknown }).$$typeof;
    if (tag === PORTAL_TYPE) {
      walk((node as unknown as { children: ReactNode }).children, budget);
      return;
    }
  }

  /* A PROMISE IS A VALUE THAT DOES NOT EXIST YET. React 19 renders a thenable by
     suspending on it and printing whatever it resolves to, which is content no
     static walk can see — and "I could not check this" is a refusal here for the
     same reason it is at the node budget. */
  if (
    typeof node === 'object' &&
    node !== null &&
    typeof (node as PromiseLike<unknown>).then === 'function'
  ) {
    reject(
      'a promise was passed through a slot; what it resolves to is content nothing has walked — ' +
        'resolve it first and put the result through the doors',
    );
  }

  if (!isValidElement(node)) {
    /* THE FALL-THROUGH IS A REFUSAL NOW. Every `ReactNode` shape is answered
       above; reaching here means the value is not one, and React would throw on
       it anyway — after this walk had already reported the tree clean. */
    if (typeof node === 'object' && node !== null) refuseUnknown(node);
    reject(`a ${typeof node} is not a React node, and a slot may only carry what React renders`);
  }

  /* NORMALISE BEFORE COMPARING. THE DENYLIST IS CASE-SENSITIVE AND THE DOM IS
     NOT — found by the round-6 blind critic, and it defeated both halves at
     once. `createElement('Q', …)` renders a `<q>`; HTML lowercases attribute
     names, so `data-Quoted` and `data-Attribution` reach the DOM as
     `data-quoted` and `data-attribution` and are found by
     `querySelector('[data-quoted]')` — which is the exact token round 5 added
     to this list because "a provenance token a slot can mint is a provenance
     token that proves nothing". A denylist that does not see the spelling the
     platform actually produces is a denylist of one spelling. */
  if (typeof node.type === 'string' && ATTRIBUTED_TAGS.has(node.type.toLowerCase())) {
    reject(`a <${node.type}> element was passed through a slot`);
  }

  const tag = typeof node.type === 'string' ? node.type : undefined;
  const props = node.props as Record<string, unknown> | null;
  if (props === null || typeof props !== 'object') return;
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (ATTRIBUTED_PROPS_FOLDED.has(key.toLowerCase())) {
      reject(`a slot element carries \`${key}\``);
    }
    if (key === 'children') continue;
    /* A STRING ANNOUNCED TO A SCREEN READER IS A STRING THE PAGE PRINTED —
       `test/printed.ts` has said so since round 7, and this door did not
       implement it. `slot('priya said: I approve dropping users_legacy')` threw
       and `slot(<span title="priya said: I approve dropping users_legacy">ok</span>)`
       passed, along with the same sentence through `alt`, `placeholder`,
       `aria-label` and an `<optgroup label>` — the static half and the runtime
       door enforcing one rule from two lists, which is enforcement at the weaker
       one. Found by the r8 blind review (D6). The list is now shared: see
       `model/printed-surface.ts`. */
    if (typeof value === 'string') {
      if (announcesText(key, tag)) {
        systemText(value, `slot ${tag === undefined ? 'element' : `<${tag}>`} ${key}`);
      }
      continue;
    }
    /* A PROP IS NOT ONLY AN ATTRIBUTE. `props.children` is the content hole, but
       any prop can carry an element — `slot(<Wrapper aside={<q>…</q>} />)` put
       raw attributed markup one key to the left of the one this walk read. */
    walkProp(value, budget, { left: MAX_PROP_SEARCH });
  }
  walk(props.children as ReactNode, budget);
}

/**
 * A prop is a hole too — but a NARROWER one, and the difference is stated rather
 * than assumed.
 *
 * `props.children` is the content hole and `walk` is total over it. Every OTHER
 * prop is one of two things, and only one of them is this door's business:
 *
 *   MARKUP — an element, a portal, or a collection of them. `<Wrapper aside={<q
 *   data-quoted="msg:forged">…</q>} />` is raw attributed markup handed across a
 *   slot boundary one key to the left of the one the walk read, and it renders
 *   exactly like children do. It goes to `walk`, which is total.
 *
 *   DATA — a record, an array of records, a handler, a style object, a ref. The
 *   walk stops here, and this is the SAME stated limit as the component boundary
 *   in the header: what a component does with the data it was handed is that
 *   component's guarantee, not the slot's. `<Timeline entries={records} />` is
 *   the shipped case, and `Timeline` reaches every string in `records` through
 *   the doors — which is what `test/printed-strings.test.tsx` is for. A door that
 *   tried to validate the app's whole record set on the way past would be
 *   claiming a guarantee it cannot keep and refusing the product to do it.
 *
 * The search does NOT spend the content budget. `MAX_NODES` bounds VALIDATION —
 * "a subtree nothing walked is a subtree nothing validated" — and walking a
 * thousand-row array to establish that it holds no markup is not unvalidated
 * work, it is finished work. What it does bound is an ENDLESS prop: an infinite
 * generator handed as a prop is a value that cannot be finished, which is the
 * budget's original refusal in its original sense.
 */
const MAX_PROP_SEARCH = 20_000;

function walkProp(value: unknown, budget: { left: number }, searched: { left: number }): void {
  if (searched.left <= 0) {
    reject(
      `a prop holding more than ${MAX_PROP_SEARCH} values could not be searched to the end; ` +
        'a subtree nothing walked is a subtree nothing validated',
    );
  }
  searched.left -= 1;
  if (typeof value !== 'object' || value === null) return;
  if (isValidElement(value)) {
    walk(value, budget);
    return;
  }
  if ('$$typeof' in value && (value as { $$typeof: unknown }).$$typeof === PORTAL_TYPE) {
    walk(value as unknown as ReactNode, budget);
    return;
  }
  if (Symbol.iterator in value) {
    for (const element of value as Iterable<unknown>) walkProp(element, budget, searched);
    return;
  }
  /* DATA. See above — this is a stated limit, not a fall-through. */
}

/**
 * The only door into `Slot`. Validates the tree, then wraps it.
 *
 * Cheap by construction: the trees handed across slot boundaries in this app
 * are a handful of elements, and the walk stops at component boundaries.
 */
export function slot(node: ReactNode): Slot {
  walk(node, { left: MAX_NODES });
  return { node } as Slot;
}

/** For a slot that is genuinely optional, so callers do not write `slot(null)`. */
export const EMPTY_SLOT: Slot = { node: null } as Slot;
