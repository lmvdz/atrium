import * as Y from 'yjs';
import {
  type CapturedSelection,
  type CovenantAnchor,
  type CovenantDocReader,
  type EnclosedItem,
  type Mark,
  type RenderedFragment,
  type RenderedNode,
  sha256Hex,
} from '../../src/index.js';

/**
 * THE REFERENCE `CovenantDocReader` over Yjs — the HONEST adapter #181/#183 mirror.
 *
 * `covenant.test.ts` pins the pure primitive against a stub; this binds the port
 * to a real in-memory `Y.Doc` and is the reader the covenant conformance suite
 * (`covenant-conformance.test.ts`) drives, mutating a live doc through THIS code
 * and asserting DRIFT for every advertised class. It exists precisely so the
 * production reader cannot quietly reintroduce the round-1 holes — every hole the
 * gauntlet found (hardcoded `straddles:'none'`, only the heading `level`, ignored
 * embed children, flattened string-valued marks, a fixed-index span, an
 * ornamental snapshot) has a failing-on-mutation test through this file.
 *
 * ## The document shape it resolves
 *
 * A certified span is a CHARACTER RANGE `[relStart, relEnd)` inside ONE block's
 * `Y.XmlText` body, under a chain of ancestor `Y.XmlElement`s:
 *
 *     fragment('doc')
 *       └ <blockquote indent align>          ← ancestor (all attrs, not just one)
 *          └ <heading level>                  ← ancestor
 *             └ Y.XmlText  body               ← the content stream
 *                  text runs (marks incl. string-valued + straddling)
 *                  embeds  (mention{target,label}, image{src}, nestedDoc{child})
 *
 * The span is anchored by Yjs RELATIVE POSITIONS persisted ON the anchor, so it
 * survives a reader with no in-memory state (reload) and a sibling inserted at
 * the same index cannot redirect it (class B). Everything meaning-bearing — the
 * digest and the OK/DRIFT verdict — is owned by `@atrium/core`; this reader only
 * renders the live fragment honestly and verifies the captured snapshot.
 */

// ─────────────────────────────────────────────────────────────────────────────
// base64 <-> bytes (the reader is app-layer; core never touches these).
// ─────────────────────────────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64');
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Delta helpers — render a clipped window of a Y.XmlText honestly.
// ─────────────────────────────────────────────────────────────────────────────

type DeltaOp = { insert: string | Record<string, unknown>; attributes?: Record<string, unknown> };

/** The marks a text op carries, with string-valued payloads PRESERVED (not `{}`). */
function marksOf(attributes: Record<string, unknown> | undefined): Mark[] {
  if (!attributes) return [];
  return Object.keys(attributes).map((type) => {
    const raw = attributes[type];
    // A string-valued mark ({highlight:'yellow'}) is kept as {value:'yellow'} so
    // yellow→red is a rendered change; an object-valued mark ({link:{href}}) keeps
    // its fields. The round-1 reader flattened BOTH to {} — that is the hole.
    let attrs: Record<string, string>;
    if (raw && typeof raw === 'object') {
      attrs = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)]));
    } else if (raw === true || raw === null || raw === undefined) {
      attrs = {}; // a boolean mark (bold:true) has no payload
    } else {
      attrs = { value: String(raw) }; // a scalar payload IS rendered meaning
    }
    return { type, attrs, straddles: 'none' as const };
  });
}

/** The identity of an embed — every field stringified, plus a digest of any child content. */
function embedIdentity(embed: Record<string, unknown>): { embedType: string; identity: Record<string, string> } {
  const embedType = String(embed['embedType'] ?? embed['type'] ?? 'embed');
  const identity: Record<string, string> = {};
  for (const [k, v] of Object.entries(embed)) {
    if (k === 'embedType' || k === 'type') continue;
    if (k === 'child' || k === 'children') {
      // A nested-doc / mention-label body is CHILD content: digest it so a change
      // inside the child (not just a top-level attr) is drift (class A / #163).
      identity['docDigest'] = sha256Hex(typeof v === 'string' ? v : JSON.stringify(v));
      continue;
    }
    identity[k] = String(v);
  }
  return { embedType, identity };
}

/** The mark-type→attrs active at absolute char `offset`, or null (for straddle detection). */
function markActiveAt(delta: DeltaOp[], offset: number, type: string): Record<string, string> | null {
  let pos = 0;
  for (const op of delta) {
    const len = typeof op.insert === 'string' ? op.insert.length : 1;
    if (offset >= pos && offset < pos + len) {
      if (typeof op.insert !== 'string') return null; // an embed carries no inline marks
      const attrs = op.attributes;
      if (!attrs || !(type in attrs)) return null;
      const m = marksOf(attrs).find((x) => x.type === type);
      return m ? m.attrs : null;
    }
    pos += len;
  }
  return null;
}

function sameAttrs(a: Record<string, string>, b: Record<string, string> | null): boolean {
  if (b === null) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

// ─────────────────────────────────────────────────────────────────────────────
// The reader.
// ─────────────────────────────────────────────────────────────────────────────

/** Locate a Y.XmlText body by a doc-path (child indices from the fragment down). */
export type BodyPath = number[];

export class YjsCovenantDocReader implements CovenantDocReader {
  constructor(
    private doc: Y.Doc | null,
    /** Where captureSelection() reads the span from: a path to the body + char range. */
    private readonly selection?: { path: BodyPath; start: number; end: number },
  ) {}

  /** Simulate the doc handle dropping (a lost Electric stream). */
  makeUnavailable(): void {
    this.doc = null;
  }

  private fragment(): Y.XmlFragment | null {
    return this.doc ? this.doc.getXmlFragment('doc') : null;
  }

  /** Follow a path of child indices from the fragment to a Y.XmlText body. */
  private bodyAtPath(path: BodyPath): Y.XmlText | null {
    let node: Y.XmlFragment | Y.XmlElement | Y.XmlText | null = this.fragment();
    for (const idx of path) {
      if (!node || node instanceof Y.XmlText) return null;
      const child: unknown = node.get(idx);
      if (child instanceof Y.XmlElement || child instanceof Y.XmlText) node = child;
      else return null;
    }
    return node instanceof Y.XmlText ? node : null;
  }

  /** The ancestor formatting chain above a body, top-down: EVERY element, ALL its attrs. */
  private ancestorsOf(body: Y.XmlText): RenderedFragment['ancestors'] {
    const chain: RenderedFragment['ancestors'] = [];
    let parent: Y.AbstractType<unknown> | null = body.parent;
    while (parent && parent instanceof Y.XmlElement) {
      const attrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(parent.getAttributes())) attrs[k] = String(v);
      chain.push({ type: parent.nodeName, attrs });
      parent = parent.parent;
    }
    return chain.reverse();
  }

  /** Render the clipped window [start,end) of a body: nodes + enclosed item identity. */
  private renderWindow(
    body: Y.XmlText,
    start: number,
    end: number,
  ): { fragment: RenderedFragment; enclosedItems: EnclosedItem[] } {
    const delta = body.toDelta() as DeltaOp[];
    const nodes: RenderedNode[] = [];
    let pos = 0;
    for (const op of delta) {
      if (typeof op.insert === 'string') {
        const opStart = pos;
        const opEnd = pos + op.insert.length;
        const from = Math.max(start, opStart);
        const to = Math.min(end, opEnd);
        if (to > from) {
          const text = op.insert.slice(from - opStart, to - opStart);
          const marks = marksOf(op.attributes).map((m) => {
            const straddleStart = from <= start && sameAttrs(m.attrs, markActiveAt(delta, start - 1, m.type));
            const straddleEnd = to >= end && sameAttrs(m.attrs, markActiveAt(delta, end, m.type));
            const straddles: Mark['straddles'] =
              straddleStart && straddleEnd ? 'both' : straddleStart ? 'start' : straddleEnd ? 'end' : 'none';
            return { ...m, straddles };
          });
          nodes.push({ kind: 'text', text, marks });
        }
        pos = opEnd;
      } else {
        // An embed occupies exactly one character.
        if (pos >= start && pos < end) {
          const { embedType, identity } = embedIdentity(op.insert);
          nodes.push({ kind: 'embed', embedType, identity });
        }
        pos += 1;
      }
    }
    return { fragment: { ancestors: this.ancestorsOf(body), nodes }, enclosedItems: this.enclosedItemsOf(body, start, end) };
  }

  /**
   * The IDENTITY of every ATOMIC (embed) Yjs item overlapping [start,end) —
   * client:clock ids from the internal struct list. Defence-in-depth (class 5): a
   * deleted embed drops its item from this set even for a renderer that folded it
   * out of the digest.
   *
   * Only EMBED items are listed, deliberately. Text items split and re-merge under
   * ordinary editing — typing a character mid-run and deleting it again leaves the
   * SAME rendered text carried by TWO items with fresh clocks — so listing text
   * item ids would false-stale a byte-identical revert (class 7 requires it resolve
   * OK). Text drift is caught by the digest, which is stable across that resplit;
   * embeds are atomic (length 1, never split), so their identity is a sound axis.
   *
   * The `_item`/`_start` access is Yjs-internal; it is guarded so a shape that
   * lacks it fails CLOSED (throws → DRIFT in resolveCovenant) rather than lying OK.
   */
  private enclosedItemsOf(body: Y.XmlText, start: number, end: number): EnclosedItem[] {
    const out: EnclosedItem[] = [];
    let item: unknown = (body as unknown as { _start: unknown })._start;
    let offset = 0;
    while (item) {
      const it = item as {
        id: { client: number; clock: number };
        length: number;
        deleted: boolean;
        content: { constructor: { name: string } };
        right: unknown;
      };
      if (!it.deleted) {
        const itStart = offset;
        const itEnd = offset + it.length;
        if (itEnd > start && itStart < end && it.content.constructor.name === 'ContentEmbed') {
          out.push({ id: `${it.id.client}:${it.id.clock}`, kind: 'embed' });
        }
        offset = itEnd;
      }
      item = it.right;
    }
    return out;
  }

  /** The live logical revision — the total op count across all clients (monotonic). */
  private liveRevision(doc: Y.Doc): number {
    let total = 0;
    for (const clock of Y.decodeStateVector(Y.encodeStateVector(doc)).values()) total += clock;
    return total;
  }

  /**
   * INDEPENDENTLY verify the captured snapshot against the live doc (class C):
   * the certifier's state must be a sub-state of what exists now, and the recorded
   * revision must not post-date it. A forged / foreign revision, state vector, or
   * delete set is `false`. Any decode failure is `false` (fail-closed), never a
   * throw that could be read as OK.
   */
  private verifySnapshot(doc: Y.Doc, anchor: CovenantAnchor): boolean {
    try {
      // Revision cannot post-date the live doc.
      if (anchor.revision > this.liveRevision(doc)) return false;

      // The state vector and the revision are bound: the recorded revision IS the
      // sum of the certify-time state vector, so a forged revision or a forged /
      // empty state vector (which would otherwise pass the prefix check vacuously)
      // no longer agree. This is the check that closes the all-zeros SV lie.
      const anchorSV = Y.decodeStateVector(base64ToBytes(anchor.stateVector));
      let anchorSum = 0;
      for (const clock of anchorSV.values()) anchorSum += clock;
      if (anchorSum !== anchor.revision) return false;

      // Every (client, clock) the certifier saw must be present in the live SV
      // (the certifier saw a PREFIX of what exists now).
      const liveSV = Y.decodeStateVector(Y.encodeStateVector(doc));
      for (const [client, clock] of anchorSV.entries()) {
        if ((liveSV.get(client) ?? 0) < clock) return false;
      }

      // Every deletion the certifier saw must still be deleted in the live doc
      // (deletions are permanent; a delete set naming ranges the doc never deleted
      // is a forgery). The delete set is an ACTUAL delete set the reader decodes,
      // not a full snapshot.
      const anchorDS = JSON.parse(new TextDecoder().decode(base64ToBytes(anchor.deleteSet))) as Record<
        string,
        [number, number][]
      >;
      const liveDS = Y.snapshot(doc).ds;
      for (const [clientStr, ranges] of Object.entries(anchorDS)) {
        const client = Number(clientStr);
        const liveRanges = (liveDS.clients.get(client) ?? []) as Array<{ clock: number; len: number }>;
        for (const [clock, len] of ranges) {
          const covered = liveRanges.some((r) => r.clock <= clock && clock + len <= r.clock + r.len);
          if (!covered) return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  // ── Port surface ──────────────────────────────────────────────────────────

  captureSelection(): CapturedSelection | null {
    const doc = this.doc;
    const frag = this.fragment();
    if (!doc || !frag || !this.selection) return null;
    const body = this.bodyAtPath(this.selection.path);
    if (!body) return null;
    const { start, end } = this.selection;

    // Relative positions of the span boundaries, anchored to the BODY type so they
    // track that body wherever it moves. start associates left, end associates
    // right, so text typed AT the end boundary falls INSIDE the span (→ drift).
    const relStart = Y.createRelativePositionFromTypeIndex(body, start, -1);
    const relEnd = Y.createRelativePositionFromTypeIndex(body, end, 1);

    const { fragment, enclosedItems } = this.renderWindow(body, start, end);
    const ds = Y.snapshot(doc).ds;
    const dsPlain: Record<string, [number, number][]> = {};
    for (const [client, ranges] of ds.clients.entries()) {
      dsPlain[String(client)] = (ranges as Array<{ clock: number; len: number }>).map((r) => [r.clock, r.len]);
    }
    return {
      revision: this.liveRevision(doc),
      relStart: bytesToBase64(Y.encodeRelativePosition(relStart)),
      relEnd: bytesToBase64(Y.encodeRelativePosition(relEnd)),
      stateVector: bytesToBase64(Y.encodeStateVector(doc)),
      deleteSet: bytesToBase64(new TextEncoder().encode(JSON.stringify(dsPlain))),
      fragment,
      enclosedItems,
    };
  }

  resolveSpan(anchor: CovenantAnchor): ReturnType<CovenantDocReader['resolveSpan']> {
    const doc = this.doc;
    if (!doc) return null; // unavailable ⇒ fail-closed

    // Resolve the span from the PERSISTED relative positions — NOT a fixed index.
    // A position that no longer resolves ⇒ the span is gone (GC'd / deleted).
    const relStart = Y.decodeRelativePosition(base64ToBytes(anchor.relStart));
    const relEnd = Y.decodeRelativePosition(base64ToBytes(anchor.relEnd));
    const absStart = Y.createAbsolutePositionFromRelativePosition(relStart, doc);
    const absEnd = Y.createAbsolutePositionFromRelativePosition(relEnd, doc);
    if (!absStart || !absEnd) return null;
    const body = absStart.type;
    if (!(body instanceof Y.XmlText) || absEnd.type !== body) return null;
    // A GC'd/tombstoned body element ⇒ unresolvable.
    const item = (body as unknown as { _item: { deleted: boolean } | null })._item;
    if (item && item.deleted) return null;

    const start = Math.min(absStart.index, absEnd.index);
    const end = Math.max(absStart.index, absEnd.index);
    const { fragment, enclosedItems } = this.renderWindow(body, start, end);
    return { fragment, enclosedItems, snapshotVerified: this.verifySnapshot(doc, anchor) };
  }
}
