'use client';

/* ═══════════════════════════════════════════════════════════════════════════
 * SELECTION → COVENANT SPAN (E8 / #197, P6F-3) — the load-bearing mapping.
 *
 * A human drag-selects a passage of a message body; this maps that DOM selection
 * to the EXACT `{ objectId, bodyPath, start, end }` the covenant certify path
 * addresses — byte-for-byte the same span `CovenantDocReaderProd` will re-read
 * from the live `Y.XmlText` body. Nothing here certifies: it computes coordinates.
 * The ✓ ACT stays a human's, driven through `certifyObjectSpanAction`; this module
 * only says WHICH span that act is over.
 *
 * ## The one property everything else serves
 *
 * The reader's index space (`covenant-reader.ts` `renderWindow` / `directDelta`,
 * and `Y.createRelativePositionFromTypeIndex(body, start/end, …)` in
 * `buildCapture`) is: walk the body's Yjs items in document order; a text run
 * contributes `op.text.length` — **UTF-16 code units**, exactly `String#length`;
 * an EMBED contributes exactly **1**; an inline FORMAT marker (bold/link/…)
 * contributes **0**. The span is half-open `[start, end)`.
 *
 * So a DOM offset can only equal a `Y.XmlText` index when the body is rendered
 * **1:1** into that same space: each text run as verbatim text (newlines kept as
 * real `\n`, never `<br>`, or the count drifts), each embed as a length-1 atom
 * marked {@link EMBED_ATTR}, and marks as *wrapping* elements that add no text.
 * {@link renderBodyModel} produces exactly that shape; {@link CertifyPassage}
 * renders it; {@link spanFromRange} counts over it. All three share one index
 * definition ({@link nodeBodyLength} / {@link indexOfPoint}) so they cannot drift
 * from each other — the mutation test flips the selection and asserts the mapped
 * span moves with it (if it did not, the mapping would be ornament).
 *
 * On a LIVE room there is no client `Y.Doc` (the authoritative doc is server-side;
 * the client holds only precomputed glyph reads). This mapping therefore runs
 * against the client `ConversationDoc` the conversation feed owns — the fixture /
 * transport path — where the very same `Y.XmlText` is present to render 1:1 and to
 * hand `bodyPath(id)`.
 * ═════════════════════════════════════════════════════════════════════════ */

import type { XmlText as YXmlText } from 'yjs';

/**
 * The marker attribute on a rendered EMBED atom. An element carrying it counts as
 * exactly ONE unit in the body index (matching the reader's `pos += 1` per embed),
 * regardless of whatever placeholder text it renders. Kept as a data attribute so
 * the count is observable in the DOM and in a test, and so a mark/ancestor wrapper
 * (which carries no such marker) is transparently summed through to its text.
 */
export const EMBED_ATTR = 'data-certify-embed';

/**
 * The marker attribute on the certify-body ROOT — the single element whose text
 * space is the `Y.XmlText`'s index space. {@link spanFromSelection} refuses a
 * selection that is not fully inside one such root (a selection straddling two
 * bodies, or the surrounding chrome, has no single-body span and must not certify).
 */
export const BODY_ROOT_ATTR = 'data-certify-body';

/** The full certify request the server action (`certifyObjectSpanAction`) accepts. */
export interface ObjectSpanRequest {
  readonly workspaceSlug: string;
  readonly roomSlug: string;
  readonly objectId: string;
  /** `[blockIndex, childIndex]` — from `ConversationDoc.bodyPath(id)`, never hand-built. */
  readonly bodyPath: number[];
  /** UTF-16 code-unit index into the `Y.XmlText`; embeds count as 1. Half-open with `end`. */
  readonly start: number;
  readonly end: number;
}

/** A resolved span within one body, before the room/object context is attached. */
export interface BodySpan {
  readonly start: number;
  readonly end: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// The ONE index definition — shared by the render model, the component, and the
// mapper, so a body's rendered DOM and its Yjs index can never disagree.
// ─────────────────────────────────────────────────────────────────────────────

/** Is `el` a rendered embed atom (counts as exactly 1, its inner text ignored)? */
function isEmbedAtom(el: Element): boolean {
  return el.hasAttribute(EMBED_ATTR);
}

/**
 * The body-index length of a DOM node's whole subtree, in the reader's units:
 * a text node is its `String#length` (UTF-16 code units); an embed atom is 1
 * (its inner text does NOT count); any other element is the sum of its children
 * (so a mark/ancestor wrapper is transparent). A comment / other node is 0.
 */
function nodeBodyLength(node: Node): number {
  if (node.nodeType === 3 /* TEXT_NODE */) {
    return (node.nodeValue ?? '').length;
  }
  if (node.nodeType === 1 /* ELEMENT_NODE */) {
    const el = node as Element;
    if (isEmbedAtom(el)) return 1;
    let total = 0;
    for (let i = 0; i < el.childNodes.length; i++) {
      const child = el.childNodes[i];
      if (child) total += nodeBodyLength(child);
    }
    return total;
  }
  return 0;
}

/**
 * The body index of a DOM point `(node, offset)` within `root` — the number of
 * body-index units lying strictly before it in document order. This is the value
 * that, handed to the reader as `start`/`end`, addresses the identical `Y.XmlText`
 * position, because both count text as UTF-16 units and embeds as 1.
 *
 * `offset` is a character offset when `node` is a text node, or a child index when
 * `node` is an element (the two shapes the DOM Range/Selection API produces). A
 * point that lands INSIDE an embed atom is clamped to that atom's near/far edge, so
 * a stray anchor within an atom can never split its single unit.
 */
function indexOfPoint(root: Node, node: Node, offset: number): number {
  // If the point sits inside (or on) an embed atom, snap it to the atom's edges so
  // the atom stays exactly one unit: offset 0 ⇒ the atom's start, else its end.
  let target: Node = node;
  let within: number;
  const embedAncestor = closestEmbed(root, node);
  if (embedAncestor && embedAncestor !== node) {
    // Inside an atom's inner DOM — collapse to the atom itself.
    target = embedAncestor;
    within = 0; // measured up to the atom's start; the atom's own unit is added by preceding-sibling walk only when we step past it
  } else if (node.nodeType === 3 /* TEXT_NODE */) {
    within = Math.max(0, Math.min(offset, (node.nodeValue ?? '').length));
  } else if (node.nodeType === 1 /* ELEMENT_NODE */) {
    const el = node as Element;
    if (isEmbedAtom(el)) {
      // A point expressed as (embedElement, childIndex): 0 ⇒ before it, ≥1 ⇒ after it.
      within = offset > 0 ? 1 : 0;
    } else {
      within = 0;
      for (let i = 0; i < offset && i < el.childNodes.length; i++) {
        const child = el.childNodes[i];
        if (child) within += nodeBodyLength(child);
      }
    }
  } else {
    within = 0;
  }

  // Add every unit lying before `target` up the ancestor chain to `root`.
  let acc = within;
  let cur: Node | null = target;
  while (cur && cur !== root) {
    let sib: Node | null = cur.previousSibling;
    while (sib) {
      acc += nodeBodyLength(sib);
      sib = sib.previousSibling;
    }
    cur = cur.parentNode;
  }
  return acc;
}

/** The nearest ancestor-or-self embed atom of `node` within `root`, or null. */
function closestEmbed(root: Node, node: Node): Element | null {
  let cur: Node | null = node;
  while (cur && cur !== root) {
    if (cur.nodeType === 1 && isEmbedAtom(cur as Element)) return cur as Element;
    cur = cur.parentNode;
  }
  return null;
}

/**
 * The total body-index length of a certify-body root — the exclusive upper bound
 * a valid `end` can take. Equals the body's `Y.XmlText.length` when the DOM was
 * produced by {@link renderBodyModel}.
 */
export function bodyLengthOf(root: Node): number {
  return nodeBodyLength(root);
}

// ─────────────────────────────────────────────────────────────────────────────
// The mapper.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map a DOM `Range` over a certify-body `root` to a normalized `{ start, end }` in
 * the body's `Y.XmlText` index space, or `null` when the range does not describe a
 * non-empty span inside that one body. A collapsed selection (`start === end`)
 * yields `null` — there is no passage to certify.
 */
export function spanFromRange(root: Node, range: Range): BodySpan | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const a = indexOfPoint(root, range.startContainer, range.startOffset);
  const b = indexOfPoint(root, range.endContainer, range.endOffset);
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  if (end <= start) return null;
  const max = nodeBodyLength(root);
  // Clamp to the body's own length — a selection extended past the body's text (a
  // trailing newline the browser rolled into the next block) never over-reaches.
  const clampedEnd = Math.min(end, max);
  if (clampedEnd <= start) return null;
  return { start, end: clampedEnd };
}

/**
 * Map the current window selection to a body span, if it lies within `root`.
 * `getSelection` is read from `root`'s own document so a portaled panel resolves
 * against the right window. Returns `null` when there is no selection, it is
 * collapsed, or it is not inside this body.
 */
export function spanFromSelection(root: HTMLElement): BodySpan | null {
  const win = root.ownerDocument?.defaultView ?? (typeof window !== 'undefined' ? window : null);
  const sel = win?.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  return spanFromRange(root, sel.getRangeAt(0));
}

/**
 * Assemble the full certify request from a resolved body span plus the room/object
 * context. `bodyPath` MUST come from `ConversationDoc.bodyPath(messageId)` — the
 * CRDT-identity-resolved `[blockIndex, childIndex]` the reader walks — never a
 * hand-built path. Returns `null` if there is no body path (an unresolvable /
 * bodyless message), so the affordance stays honestly inert rather than certifying
 * a span it cannot address.
 */
export function objectSpanRequest(params: {
  readonly workspaceSlug: string;
  readonly roomSlug: string;
  readonly objectId: string;
  readonly bodyPath: number[] | null;
  readonly span: BodySpan;
}): ObjectSpanRequest | null {
  if (params.bodyPath === null) return null;
  return {
    workspaceSlug: params.workspaceSlug,
    roomSlug: params.roomSlug,
    objectId: params.objectId,
    bodyPath: params.bodyPath,
    start: params.span.start,
    end: params.span.end,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The 1:1 render model — the body's Yjs delta as index-faithful segments.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One rendered segment of a body, in document order. A `text` segment carries a
 * verbatim run (its length IS its body-index length) and the inline mark names
 * active over it (rendered as transparent wrappers that add no units). An `embed`
 * segment is a single body-index unit rendered as an atom.
 */
export type BodySegment =
  | { readonly kind: 'text'; readonly text: string; readonly marks: readonly string[] }
  | { readonly kind: 'embed'; readonly label: string };

/**
 * Project a `Y.XmlText` body to the index-faithful {@link BodySegment} list the
 * certify surface renders. Uses `toDelta()` — whose op boundaries and character
 * counts match the reader's `directDelta` exactly (both count a text op as its
 * string length and an embed as one). A format-only op carries no `insert`, so it
 * contributes no segment and no units, mirroring the reader's zero-width markers.
 * The active mark NAMES are surfaced (not their payloads) purely so the surface can
 * echo the body's emphasis; they never affect the index.
 */
export function renderBodyModel(body: YXmlText): BodySegment[] {
  const delta = body.toDelta() as Array<{
    insert?: unknown;
    attributes?: Record<string, unknown>;
  }>;
  const out: BodySegment[] = [];
  for (const op of delta) {
    if (typeof op.insert === 'string') {
      if (op.insert.length === 0) continue;
      out.push({
        kind: 'text',
        text: op.insert,
        marks: op.attributes ? Object.keys(op.attributes).sort() : [],
      });
    } else if (op.insert !== undefined && op.insert !== null) {
      // An embed op — one unit. Label it honestly from a `type`/`embedType` hint.
      const embed = op.insert as Record<string, unknown>;
      const label =
        typeof embed.embedType === 'string'
          ? embed.embedType
          : typeof embed.type === 'string'
            ? embed.type
            : 'embed';
      out.push({ kind: 'embed', label });
    }
  }
  return out;
}

/** The plain text of a rendered body model (embeds shown as their single unit). */
export function bodyModelLength(segments: readonly BodySegment[]): number {
  let n = 0;
  for (const seg of segments) n += seg.kind === 'text' ? seg.text.length : 1;
  return n;
}
