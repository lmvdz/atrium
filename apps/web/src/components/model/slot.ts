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
 *   attribute, or a `dangerouslySetInnerHTML`. That is what actually holds when
 *   the caller is JavaScript, or when someone reaches for a cast.
 *
 * What the walk deliberately cannot see: the *output* of a component element.
 * `slot(<Quoted quote={q} />)` passes, because `Quoted` is a function whose
 * render output does not exist yet — and it should pass, because `Quoted` takes
 * a `Quotation` and cannot be handed page-authored text in the first place.
 * The walk exists to stop RAW attributed markup, which is the only way to get
 * quotation-shaped output without going through model/quotation.ts.
 * ------------------------------------------------------------------------- */

import { isValidElement, type ReactNode } from 'react';

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
  if (typeof node === 'string' || typeof node === 'number') return;

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

  if (!isValidElement(node)) return;

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

  const props = node.props as Record<string, unknown> | null;
  if (props === null) return;
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (ATTRIBUTED_PROPS_FOLDED.has(key.toLowerCase())) {
      reject(`a slot element carries \`${key}\``);
    }
  }
  walk(props.children as ReactNode, budget);
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
