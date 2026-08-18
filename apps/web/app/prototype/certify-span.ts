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
 * renders it; {@link spanFromRange} counts over it — all three walking the one index
 * definition ({@link nodeBodyLength} / {@link indexOfPoint}), so the COUNTING cannot
 * drift. What the render and the reader do NOT share is the text itself: the render
 * passes every run through the `fileText` door (which rewrites bidi/control chars to
 * U+FFFD), while the reader reads the RAW `Y.XmlText`. They land on the same indices
 * only because that rewrite is strictly LENGTH-PRESERVING — one code unit in, one
 * out — i.e. because of the 1:1 shape, not because they read the same bytes. If
 * `fileText` ever folded or expanded a character, the DOM the human selects over and
 * the body the covenant certifies would diverge in length and the coordinates would
 * drift; {@link bodyRenderDivergesFromRaw} surfaces the (currently glyph-only)
 * divergence, and the mutation test flips the selection and asserts the mapped span
 * moves with it (if it did not, the mapping would be ornament).
 *
 * On a LIVE room there is no client `Y.Doc` (the authoritative doc is server-side;
 * the client holds only precomputed glyph reads). This mapping therefore runs
 * against the client `ConversationDoc` the conversation feed owns — the fixture /
 * transport path — where the very same `Y.XmlText` is present to render 1:1 and to
 * hand `bodyPath(id)`.
 * ═════════════════════════════════════════════════════════════════════════ */

import type { XmlText as YXmlText } from 'yjs';
import { neutralizeControlChars } from '@/src/components/model';

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

/** Which end of a two-point span a DOM point is being measured as. */
type SpanEdge = 'lower' | 'upper';

/**
 * The body index of a DOM point `(node, offset)` within `root` — the number of
 * body-index units lying strictly before it in document order. This is the value
 * that, handed to the reader as `start`/`end`, addresses the identical `Y.XmlText`
 * position, because both count text as UTF-16 units and embeds as 1.
 *
 * `offset` is a character offset when `node` is a text node, or a child index when
 * `node` is an element (the two shapes the DOM Range/Selection API produces).
 *
 * EMBED-ATOM ENDPOINTS. An embed is ONE indivisible index unit that a Range point
 * cannot split; the point is resolved to one of the atom's two BOUNDARIES — the
 * index BEFORE it (`within` 0) or AFTER it (`within` 1) — and the ordinary
 * half-open `[start, end)` coverage then decides whether the atom is included.
 *
 * The resolution is ENCODING-INDEPENDENT, which is the whole point (E8 r2/r3
 * finding). The same physical boundary has TWO Range encodings and the real
 * browser's choice is unobservable here (jsdom differs). Every encoding is
 * NORMALIZED to a boundary FIRST ({@link embedPointBoundary}), then half-open
 * `[start, end)` coverage alone decides inclusion — there is no path where "point
 * on/in an embed" implies include regardless of coverage.
 *
 *   - LEFT edge — `(parent, indexOfEmbed)`, `(embed, 0)`, or the descendant
 *     `(embed.firstChild, 0)`: maps to "before the atom" (`within` 0).
 *   - RIGHT edge — `(parent, indexOfEmbed + 1)`, `(embed, childCount)`, or the
 *     descendant `(embed.lastChild, textLength)`: maps to "after the atom"
 *     (`within` 1).
 *   - INTERIOR — a point genuinely between the atom's first and last inner
 *     characters (`(embed, midChildIndex)` or a descendant offset that is neither
 *     the leading nor the trailing edge): the atom cannot be split and cannot mean
 *     "exclude", so a touched atom is included WHOLE — a `lower` bound rounds to
 *     its near edge (`within` 0), an `upper` bound to its far edge (`within` 1).
 *
 * A point that merely ENDS at an atom's edge (or STARTS at the next atom's edge,
 * with adjacent embeds) therefore excludes it; only a selection that actually
 * COVERS the atom (one endpoint before, the other after) grabs its one unit. The
 * r1 over-correction snapped every touched point OUTWARD and so over-included; the
 * r2 fix only classified the ELEMENT encoding and left the DESCENDANT encoding to
 * the interior branch (the r3 residual). {@link embedPointBoundary} classifies BOTH
 * encodings by measuring the point's character offset within the atom's inner DOM,
 * so no future Range encoding can re-open the over-include. `(parent, …)` points
 * never reach the embed branch at all (their `node` is the PARENT, not in the atom),
 * so they fall to the element walk below and already produce the same indices.
 */
function indexOfPoint(root: Node, node: Node, offset: number, edge: SpanEdge): number {
  let target: Node = node;
  let within: number;
  // `closestEmbed` is ancestor-OR-self, so this covers both a point ON the atom
  // element itself and one INSIDE its inner DOM.
  const embedAncestor = closestEmbed(root, node);
  if (embedAncestor) {
    target = embedAncestor;
    // `within` is measured from `target`'s start: 0 ⇒ before the atom, 1 ⇒ after its
    // single unit. The preceding-sibling walk below then adds every unit before it.
    // NORMALIZE FIRST: classify the point as one of the atom's boundaries or its
    // interior, ENCODING-INDEPENDENTLY (element or descendant), then let coverage
    // decide. There is no branch where touching the atom forces inclusion.
    const boundary = embedPointBoundary(embedAncestor, node, offset);
    if (boundary === 'left') {
      within = 0; // the atom's LEFT edge, any encoding — exclude by default.
    } else if (boundary === 'right') {
      within = 1; // the atom's RIGHT edge, any encoding — exclude by default.
    } else {
      // Genuinely inside the atom's inner DOM. A touched, unsplittable atom is
      // included whole: a lower bound rounds to its near edge, an upper to its far.
      within = edge === 'upper' ? 1 : 0;
    }
  } else if (node.nodeType === 3 /* TEXT_NODE */) {
    within = Math.max(0, Math.min(offset, (node.nodeValue ?? '').length));
  } else if (node.nodeType === 1 /* ELEMENT_NODE */) {
    const el = node as Element;
    within = 0;
    for (let i = 0; i < offset && i < el.childNodes.length; i++) {
      const child = el.childNodes[i];
      if (child) within += nodeBodyLength(child);
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
 * The raw text length of a DOM subtree in UTF-16 code units, counting EVERY text
 * node (embed-ness is irrelevant here — we are measuring position *inside* one atom's
 * inner DOM, not the body index). Used only by {@link embedPointBoundary}.
 */
function rawTextLength(node: Node): number {
  if (node.nodeType === 3 /* TEXT_NODE */) return (node.nodeValue ?? '').length;
  if (node.nodeType === 1 /* ELEMENT_NODE */) {
    let total = 0;
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i];
      if (child) total += rawTextLength(child);
    }
    return total;
  }
  return 0;
}

/** Which boundary of an embed atom a Range point resolves to. */
type EmbedBoundary = 'left' | 'right' | 'interior';

/**
 * Classify a Range point that lands ON or INSIDE an embed `atom` as the atom's LEFT
 * boundary, its RIGHT boundary, or its INTERIOR — ENCODING-INDEPENDENTLY, so the two
 * DOM encodings of each physical edge collapse to the same answer (E8 r3: closes the
 * class the r2 fix left open for the descendant encoding).
 *
 * The method is a character offset within the atom's inner DOM: `left` when nothing
 * precedes the point inside the atom, `right` when nothing follows it, `interior`
 * otherwise. This makes every encoding of an edge agree:
 *   - LEFT: `(atom, 0)` → offset 0; `(atom.firstChild, 0)` → offset 0.
 *   - RIGHT: `(atom, childCount)` → full length; `(atom.lastChild, textLen)` → full.
 *   - INTERIOR: `(atom, midChildIndex)` or a mid-text descendant offset.
 * An empty atom (no inner text) has length 0, so its every point is `left` (before
 * the sole unit) — which the element-offset checks below also produce, keeping the
 * two paths consistent.
 */
function embedPointBoundary(atom: Element, node: Node, offset: number): EmbedBoundary {
  // ELEMENT encoding: `offset` is a CHILD index on the atom itself, which is
  // unambiguous regardless of inner text — before the first child is the left edge,
  // at/after the last is the right edge, and a mid child-index is the interior.
  if (node === atom) {
    if (offset <= 0) return 'left';
    if (offset >= atom.childNodes.length) return 'right';
    return 'interior';
  }
  // DESCENDANT encoding: measure the point's character offset within the atom's
  // inner DOM (document order). `left` when nothing precedes it, `right` when
  // nothing follows it, `interior` otherwise.
  let acc: number;
  if (node.nodeType === 3 /* TEXT_NODE */) {
    acc = Math.max(0, Math.min(offset, (node.nodeValue ?? '').length));
  } else if (node.nodeType === 1 /* ELEMENT_NODE */) {
    acc = 0;
    for (let i = 0; i < offset && i < node.childNodes.length; i++) {
      const child = node.childNodes[i];
      if (child) acc += rawTextLength(child);
    }
  } else {
    acc = 0;
  }
  // Add every text unit lying before `node`'s subtree, up to (but not through) `atom`.
  let cur: Node | null = node;
  while (cur && cur !== atom) {
    let sib: Node | null = cur.previousSibling;
    while (sib) {
      acc += rawTextLength(sib);
      sib = sib.previousSibling;
    }
    cur = cur.parentNode;
  }
  const innerLength = rawTextLength(atom);
  if (acc <= 0) return 'left';
  if (acc >= innerLength) return 'right';
  return 'interior';
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
  // A `Range` is always document-ordered (start ≤ end), so its start container is
  // the span's LOWER bound and its end container the UPPER bound — the edge that
  // decides which way an embed-interior point rounds (see {@link indexOfPoint}).
  const a = indexOfPoint(root, range.startContainer, range.startOffset, 'lower');
  const b = indexOfPoint(root, range.endContainer, range.endOffset, 'upper');
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

/**
 * Whether a single character's RENDERED form on the certify surface differs from its
 * raw form (E8 finding #4). The body is drawn through the `fileText` verbatim-content
 * door, which replaces every bidi override/isolate and nonprinting control char with
 * U+FFFD (the replacement glyph). That rewrite is LENGTH-PRESERVING (one code unit
 * in, one out), so the span index still aligns byte-for-byte -- but the human sees
 * the replacement glyph while the covenant would certify the RAW character.
 *
 * DERIVED FROM THE DOOR, not a second hand-maintained denylist (E8 r2 minor). The
 * predicate is exactly `neutralizeControlChars(ch) !== ch` — the SAME function
 * `fileText` runs — so it cannot drift from `fileText`'s set as that set grows. The
 * ONE exception is the newline: `neutralizeControlChars` rewrites `\n`, but
 * {@link renderRun} re-emits it as a real line break on this surface, so a `\n`
 * renders faithfully here and is NOT a divergence. (TAB needs no exception: the door
 * leaves it intact, so `neutralizeControlChars` reports no change for it.)
 */
function isRenderDivergent(ch: string): boolean {
  if (ch === '\n') return false;
  return neutralizeControlChars(ch) !== ch;
}

/**
 * Whether any TEXT run in the rendered body carries a character the certify surface
 * paints as the U+FFFD replacement glyph rather than its raw form
 * ({@link isRenderDivergent}). When true, what the human SEES is not byte-for-byte
 * what the covenant would CERTIFY -- the anchor is minted from the raw `Y.XmlText`,
 * not the sanitized render -- so the surface surfaces a warning. It does NOT refuse:
 * the raw content is legitimate to certify and the span index is still exact
 * (the sanitization is length-preserving), and the U+FFFD sanitization stays -- it
 * is a bidi-security defense, not a display quirk. Embeds are excluded; their label
 * divergence never affects the certified body, which counts an embed as one opaque
 * unit regardless of label.
 */
export function bodyRenderDivergesFromRaw(segments: readonly BodySegment[]): boolean {
  for (const seg of segments) {
    if (seg.kind !== 'text') continue;
    // Iterate by code POINT: a surrogate pair (emoji) is left intact by the door, so
    // it must be judged as one character, never as two lone-surrogate code units.
    for (const ch of seg.text) {
      if (isRenderDivergent(ch)) return true;
    }
  }
  return false;
}
