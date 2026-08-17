import * as Y from 'yjs';
import {
  type AuthoritativeContext,
  type CapturedSelection,
  type CovenantAnchor,
  type CovenantDocReader,
  type EnclosedItem,
  type Mark,
  type RenderedFragment,
  type RenderedNode,
  type ResolvedSpan,
  sha256Hex,
} from '@atrium/core';

/* ═══════════════════════════════════════════════════════════════════════════
 * THE PRODUCTION `CovenantDocReader` (#189 / SL-2), over the live conversation's
 * real (TipTap / y-prosemirror) rich-text op shape.
 *
 * `@atrium/core` owns everything meaning-bearing — the canonical rendering rules,
 * the SHA-256 digest, and the OK/DRIFT verdict ({@link resolveCovenant}). This
 * reader owns exactly the CRDT-specific work the port declares: resolving the
 * persisted relative positions against the live doc, rendering the clipped span
 * HONESTLY (ancestors, text runs with marks + straddle, embeds with identity AND
 * inline marks), listing enclosed-item identity, and independently VERIFYING the
 * captured resolution snapshot. It is the production sibling of the reference
 * double in `packages/core/test/support/yjs-reader.ts` and is held to the same
 * conformance contract (`covenant-conformance.test.ts`) — re-run against THIS
 * reader in `apps/web/test/covenant-reader.conformance.test.ts`.
 *
 * ## The three routed hardenings (#180 gauntlet → #189)
 *
 * These are the acceptance-critical delta over the reference double, and they are
 * exactly the parts that depend on the UNKNOWN production embed shape, so #180
 * could not close them against its test double:
 *
 *   (a) STRUCTURAL canonicalization of deep embed / mark fields. A production
 *       embed op (a TipTap image / mention / figure node) carries NESTED OBJECT
 *       attributes — `{ src, meta: { width, height } }`, `{ attrs: { … } }`. The
 *       reference double coerces every non-`child` field with `String(v)`, which
 *       collapses EVERY distinct object to `"[object Object]"` — a false `✓`
 *       across two different embeds. This reader serializes each field
 *       type-preservingly (key-sorted canonical form, NFC on string leaves), so
 *       two embeds differing only in a nested-object field digest DIFFERENTLY.
 *       The same `canonicalizeLeaf` hardens mark attribute payloads.
 *
 *   (b) EMBED INLINE MARKS reach the digest. A Yjs `format()` stamps attributes
 *       onto an embed op exactly as onto a text op; a link on a certified image or
 *       a highlight on a mention chip is rendered meaning and MUST move the digest.
 *       This reader emits an embed's own `op.attributes` as the embed node's
 *       `marks` (with straddle), so such a `format()` drifts.
 *
 *   (c) RESOLUTION HAS A DEADLINE / fails closed. A production adapter is backed
 *       by a live stream whose handle may not be ready. The reader reaches the doc
 *       ONLY through a non-blocking {@link DocSource} poll and a wall-clock
 *       deadline: a handle that never becomes ready yields `null` (⇒ DRIFT) within
 *       the deadline, and NEVER hangs. `resolveSpan` stays synchronous, so the
 *       deadline is enforced by bounded polling, not by racing a blocking call.
 *
 * The three hardenings sit behind protected seams (`canonicalizeLeaf`,
 * `marksForEmbed`, `deadlineEnabled`) so the not-theater proof can drive a
 * deliberately NAIVE subclass (`test/support/naive-covenant-reader.ts`) down the
 * IDENTICAL resolution path and show each hardening's test fails naive / passes
 * here. There are no test toggles on the public constructor.
 * ═════════════════════════════════════════════════════════════════════════ */

// ─────────────────────────────────────────────────────────────────────────────
// The live-doc handle — a non-blocking poll, so the reader never blocks on a
// stream that is catching up or gone. The Yjs binding of the port is app-layer;
// core never sees this.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A source of the live `Y.Doc`, polled non-blockingly. `poll()` returns the doc
 * when it is ready, or `null` while it is pending / unavailable / torn down. A
 * source that is permanently `null` is the "stalled stream" case the deadline
 * turns into DRIFT.
 */
export interface DocSource {
  poll(): Y.Doc | null;
}

/** Wrap a plain (already-resolved) doc — or `null` — as an immediate source. */
class ImmediateSource implements DocSource {
  constructor(private doc: Y.Doc | null) {}
  poll(): Y.Doc | null {
    return this.doc;
  }
  setUnavailable(): void {
    this.doc = null;
  }
}

/** How long the reader will wait (busy-poll) for a stalled source before DRIFT. */
export interface ReaderOptions {
  /** Resolution deadline in ms. A source not ready within it fails closed. */
  deadlineMs?: number;
  /** Injected clock (defaults to `Date.now`) — deterministic in tests. */
  now?: () => number;
}

const DEFAULT_DEADLINE_MS = 250;

/** The span a reader captures from: a doc-path to a `Y.XmlText` body + char range. */
export type BodyPath = number[];

function isDocSource(x: unknown): x is DocSource {
  return typeof x === 'object' && x !== null && typeof (x as DocSource).poll === 'function';
}

// ─────────────────────────────────────────────────────────────────────────────
// base64 <-> bytes (app-layer; core never touches these).
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

type DeltaOp = { insert: string | Record<string, unknown>; attributes?: Record<string, unknown> };

// ─────────────────────────────────────────────────────────────────────────────
// Canonical, type-preserving, NFC-normalized serialization of an arbitrary leaf
// value — the discipline `@atrium/core`'s `canonical()` uses on the fragment
// itself. This is hardening (a): a NESTED OBJECT is serialized field-by-field
// (keys sorted at every depth), NOT coerced to `"[object Object]"`, and its string
// leaves are NFC-normalized, so two distinct objects never collide and canonical
// Unicode equivalence still folds. Every JS type keeps a DISTINCT shape (a number
// `1` never equals the string `"1"`), so a field's type is itself content.
// ─────────────────────────────────────────────────────────────────────────────

export function canonicalizeLeafValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '"\\u0000undefined"';
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'));
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'bigint') return `"bigint:${value.toString()}"`;
  if (Array.isArray(value)) return `[${value.map(canonicalizeLeafValue).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k.normalize('NFC'))}:${canonicalizeLeafValue(obj[k])}`)
      .join(',')}}`;
  }
  // A function / symbol has no rendered meaning; give it a total, distinct token
  // rather than throwing, so a malformed embed still fails CLOSED (DRIFT), never OK.
  return JSON.stringify(` nonvalue:${typeof value}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// The reader.
// ─────────────────────────────────────────────────────────────────────────────

export class CovenantDocReaderProd implements CovenantDocReader {
  private readonly source: DocSource;
  private readonly immediate: ImmediateSource | null;
  private readonly deadlineMs: number;
  private readonly now: () => number;

  constructor(
    input: Y.Doc | null | DocSource,
    /** Where `captureSelection()` reads the span from. Absent ⇒ resolve-only reader. */
    private readonly selection?: { path: BodyPath; start: number; end: number },
    options?: ReaderOptions,
  ) {
    if (isDocSource(input)) {
      this.source = input;
      this.immediate = null;
    } else {
      this.immediate = new ImmediateSource(input);
      this.source = this.immediate;
    }
    this.deadlineMs = options?.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.now = options?.now ?? Date.now;
  }

  /** Simulate the doc handle dropping (a lost stream) — conformance parity. */
  makeUnavailable(): void {
    this.immediate?.setUnavailable();
  }

  // ── hardening seams (overridden by the not-theater NAIVE reader) ────────────

  /** Hardening (a): serialize an embed / mark field STRUCTURALLY, never `String(obj)`. */
  protected canonicalizeLeaf(value: unknown): string {
    return canonicalizeLeafValue(value);
  }

  /** Hardening (b): an embed's own inline marks reach the digest. */
  protected marksForEmbed(attributes: Record<string, unknown> | undefined): Mark[] {
    return this.marksOf(attributes);
  }

  /** Hardening (c): resolution is bounded by a deadline (fail-closed, never hangs). */
  protected get deadlineEnabled(): boolean {
    return true;
  }

  // ── deadline-bounded doc acquisition (hardening c) ──────────────────────────

  /**
   * Reach the live doc through the non-blocking source, bounded by the deadline.
   * A source that never becomes ready returns `null` here within `deadlineMs`
   * (⇒ DRIFT / no-capture) instead of hanging. When the deadline is disabled (the
   * naive reader), a never-ready source loops forever — which is exactly the hang
   * the hardening prevents, and what the not-theater test observes.
   */
  private acquire(): Y.Doc | null {
    const start = this.now();
    for (;;) {
      const doc = this.source.poll();
      if (doc) return doc;
      if (this.deadlineEnabled && this.now() - start >= this.deadlineMs) return null;
    }
  }

  private fragmentOf(doc: Y.Doc): Y.XmlFragment {
    return doc.getXmlFragment('doc');
  }

  /** Follow a path of child indices from the fragment to a `Y.XmlText` body. */
  private bodyAtPath(doc: Y.Doc, path: BodyPath): Y.XmlText | null {
    let node: Y.XmlFragment | Y.XmlElement | Y.XmlText | null = this.fragmentOf(doc);
    for (const idx of path) {
      if (!node || node instanceof Y.XmlText) return null;
      const child: unknown = node.get(idx);
      if (child instanceof Y.XmlElement || child instanceof Y.XmlText) node = child;
      else return null;
    }
    return node instanceof Y.XmlText ? node : null;
  }

  // ── rendering ───────────────────────────────────────────────────────────────

  /** The marks a text OR embed op carries, with payloads canonicalized (hardening a). */
  private marksOf(attributes: Record<string, unknown> | undefined): Mark[] {
    if (!attributes) return [];
    return Object.keys(attributes)
      .sort()
      .map((type) => {
        const raw = attributes[type];
        let attrs: Record<string, string>;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          // An object-valued mark ({ link: { href, meta:{…} } }): each field is
          // canonicalized STRUCTURALLY, so a nested-object mark field cannot collide.
          attrs = {};
          for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
            attrs[k] = this.canonicalizeLeaf(v);
          }
        } else if (raw === true || raw === null || raw === undefined) {
          attrs = {}; // a boolean mark (bold:true) has no payload
        } else {
          attrs = { value: this.canonicalizeLeaf(raw) }; // a scalar payload IS meaning
        }
        return { type, attrs, straddles: 'none' as const };
      });
  }

  /**
   * The identity of an embed — every field serialized STRUCTURALLY (hardening a),
   * plus a digest of any `child`/`children` body. NO `String(obj)` anywhere: a
   * nested-object field is canonicalized field-by-field, so two distinct embeds
   * that differ only in a nested object no longer collide to a false `✓`.
   */
  private embedIdentity(embed: Record<string, unknown>): {
    embedType: string;
    identity: Record<string, string>;
  } {
    const embedType = String(embed.embedType ?? embed.type ?? 'embed');
    const identity: Record<string, string> = {};
    for (const [k, v] of Object.entries(embed)) {
      if (k === 'embedType' || k === 'type') continue;
      if (k === 'child' || k === 'children') {
        // Child body: digest it so a change INSIDE the child is drift. A string
        // child is NFC-normalized first (the hex docDigest is opaque to core's NFC
        // pass); an object child is canonicalized (sorted keys, NFC leaves), so
        // insertion order is not mistaken for a content change.
        identity.docDigest = sha256Hex(
          typeof v === 'string' ? v.normalize('NFC') : this.canonicalizeLeaf(v),
        );
        continue;
      }
      // Every OTHER field, structurally — a scalar keeps its type, a nested object
      // is serialized field-by-field, NEVER coerced to "[object Object]".
      identity[k] = this.canonicalizeLeaf(v);
    }
    return { embedType, identity };
  }

  /** The mark-type→attrs active at absolute char `offset` (for straddle), text OR embed. */
  private markActiveAt(
    delta: DeltaOp[],
    offset: number,
    type: string,
  ): Record<string, string> | null {
    let pos = 0;
    for (const op of delta) {
      const len = typeof op.insert === 'string' ? op.insert.length : 1;
      if (offset >= pos && offset < pos + len) {
        const attrs = op.attributes;
        if (!attrs || !(type in attrs)) return null;
        const m = this.marksOf(attrs).find((x) => x.type === type);
        return m ? m.attrs : null;
      }
      pos += len;
    }
    return null;
  }

  private static sameAttrs(a: Record<string, string>, b: Record<string, string> | null): boolean {
    if (b === null) return false;
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length) return false;
    return ka.every((k, i) => k === kb[i] && a[k] === b[k]);
  }

  /** The ancestor formatting chain above a body, top-down: every element, all attrs. */
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

  /** Render the clipped window [start,end): nodes + enclosed item identity. */
  private renderWindow(
    body: Y.XmlText,
    start: number,
    end: number,
  ): { fragment: RenderedFragment; enclosedItems: EnclosedItem[] } {
    const delta = body.toDelta() as DeltaOp[];
    const nodes: RenderedNode[] = [];
    let firstNode = -1;
    let lastNode = -1;
    let pos = 0;
    for (const op of delta) {
      if (typeof op.insert === 'string') {
        const opStart = pos;
        const opEnd = pos + op.insert.length;
        const from = Math.max(start, opStart);
        const to = Math.min(end, opEnd);
        if (to > from) {
          const text = op.insert.slice(from - opStart, to - opStart);
          const marks = this.marksOf(op.attributes);
          if (firstNode === -1) firstNode = nodes.length;
          lastNode = nodes.length;
          nodes.push({ kind: 'text', text, marks });
        }
        pos = opEnd;
      } else {
        // An embed occupies exactly one character: its structural identity AND its
        // own inline marks (hardening b) — a link/highlight/bold stamped on it.
        if (pos >= start && pos < end) {
          const { embedType, identity } = this.embedIdentity(op.insert);
          const marks = this.marksForEmbed(op.attributes);
          if (firstNode === -1) firstNode = nodes.length;
          lastNode = nodes.length;
          nodes.push({ kind: 'embed', embedType, identity, marks });
        }
        pos += 1;
      }
    }

    // STRADDLE post-pass — a mark straddles a boundary iff the SAME mark (type +
    // attrs) is active continuously across it. Stamped on the boundary-adjacent
    // node, text OR embed (both carry `marks`), so an embed on the boundary, or an
    // embed-only span, is detected instead of a byte-identical 'none'.
    const straddlesAcross = (m: Mark, before: number, after: number): boolean =>
      CovenantDocReaderProd.sameAttrs(m.attrs, this.markActiveAt(delta, before, m.type)) &&
      CovenantDocReaderProd.sameAttrs(m.attrs, this.markActiveAt(delta, after, m.type));
    const stamp = (idx: number, boundary: 'start' | 'end') => {
      if (idx === -1) return;
      const node = nodes[idx];
      if (!node) return;
      node.marks = node.marks.map((m) => {
        const straddleStart =
          m.straddles === 'start' ||
          m.straddles === 'both' ||
          (boundary === 'start' && straddlesAcross(m, start - 1, start));
        const straddleEnd =
          m.straddles === 'end' ||
          m.straddles === 'both' ||
          (boundary === 'end' && straddlesAcross(m, end - 1, end));
        const straddles: Mark['straddles'] =
          straddleStart && straddleEnd
            ? 'both'
            : straddleStart
              ? 'start'
              : straddleEnd
                ? 'end'
                : 'none';
        return { ...m, straddles };
      });
    };
    stamp(firstNode, 'start');
    stamp(lastNode, 'end');

    return {
      fragment: { ancestors: this.ancestorsOf(body), nodes },
      enclosedItems: this.enclosedItemsOf(body, start, end),
    };
  }

  /**
   * The identity of every ATOMIC (embed) Yjs item overlapping [start,end) —
   * client:clock ids. Only embeds: text items split/re-merge under editing, so
   * listing their ids would false-stale a byte-identical revert; embeds are atomic.
   * The `_start`/`content` access is Yjs-internal, guarded so a foreign shape fails
   * CLOSED (throws ⇒ DRIFT) rather than lying OK.
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

  /** The live logical revision — total op count across all clients (monotonic). */
  private liveRevision(doc: Y.Doc): number {
    let total = 0;
    for (const clock of Y.decodeStateVector(Y.encodeStateVector(doc)).values()) total += clock;
    return total;
  }

  /** The (client:clock) id of every non-deleted item overlapping [start,end). */
  private spanItemIds(
    body: Y.XmlText,
    start: number,
    end: number,
  ): Array<{ client: number; clock: number }> {
    const out: Array<{ client: number; clock: number }> = [];
    let item: unknown = (body as unknown as { _start: unknown })._start;
    let offset = 0;
    while (item) {
      const it = item as {
        id: { client: number; clock: number };
        length: number;
        deleted: boolean;
        right: unknown;
      };
      if (!it.deleted) {
        const itStart = offset;
        const itEnd = offset + it.length;
        if (itEnd > start && itStart < end) out.push({ client: it.id.client, clock: it.id.clock });
        offset = itEnd;
      }
      item = it.right;
    }
    return out;
  }

  /** Deleted (tombstoned) items whose position falls within [start,end], BOUNDARIES INCLUDED. */
  private spanDeletedItems(
    body: Y.XmlText,
    start: number,
    end: number,
  ): Array<{ client: number; clock: number; len: number }> {
    const out: Array<{ client: number; clock: number; len: number }> = [];
    let item: unknown = (body as unknown as { _start: unknown })._start;
    let offset = 0;
    while (item) {
      const it = item as {
        id: { client: number; clock: number };
        length: number;
        deleted: boolean;
        right: unknown;
      };
      if (it.deleted) {
        if (offset >= start && offset <= end)
          out.push({ client: it.id.client, clock: it.id.clock, len: it.length });
      } else {
        offset += it.length;
      }
      item = it.right;
    }
    return out;
  }

  /** The REAL per-client state-vector frontiers the doc has passed through for `client`. */
  private clientBoundaries(doc: Y.Doc, client: number): Set<number> {
    const bounds = new Set<number>([0]);
    const structs = (
      doc as unknown as {
        store: { clients: Map<number, Array<{ id: { clock: number }; length: number }>> };
      }
    ).store.clients.get(client);
    if (!structs) return bounds;
    for (const s of structs) bounds.add(s.id.clock + s.length);
    return bounds;
  }

  /** INDEPENDENTLY verify the captured snapshot against the live doc (class C). */
  private verifySnapshot(
    doc: Y.Doc,
    anchor: CovenantAnchor,
    body: Y.XmlText,
    start: number,
    end: number,
  ): boolean {
    try {
      if (anchor.revision > this.liveRevision(doc)) return false;

      const anchorSV = Y.decodeStateVector(base64ToBytes(anchor.stateVector));
      let anchorSum = 0;
      for (const clock of anchorSV.values()) anchorSum += clock;
      if (anchorSum !== anchor.revision) return false;

      const liveSV = Y.decodeStateVector(Y.encodeStateVector(doc));
      for (const [client, clock] of anchorSV.entries()) {
        if ((liveSV.get(client) ?? 0) < clock) return false;
      }

      for (const [client, clock] of anchorSV.entries()) {
        if (!this.clientBoundaries(doc, client).has(clock)) return false;
      }

      for (const { client, clock } of this.spanItemIds(body, start, end)) {
        if ((anchorSV.get(client) ?? 0) <= clock) return false;
      }

      const anchorDS = JSON.parse(
        new TextDecoder().decode(base64ToBytes(anchor.deleteSet)),
      ) as Record<string, [number, number][]>;
      const liveDS = Y.snapshot(doc).ds;

      for (const [clientStr, ranges] of Object.entries(anchorDS)) {
        const client = Number(clientStr);
        const liveRanges = (liveDS.clients.get(client) ?? []) as Array<{
          clock: number;
          len: number;
        }>;
        for (const [clock, len] of ranges) {
          const covered = liveRanges.some(
            (r) => r.clock <= clock && clock + len <= r.clock + r.len,
          );
          if (!covered) return false;
        }
      }

      for (const { client, clock, len } of this.spanDeletedItems(body, start, end)) {
        const frontier = anchorSV.get(client) ?? 0;
        if (clock >= frontier) continue;
        const anchorRanges = anchorDS[String(client)] ?? [];
        const covered = anchorRanges.some(([c, l]) => c <= clock && clock + len <= c + l);
        if (!covered) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  // ── Port surface ────────────────────────────────────────────────────────────

  /** The authoritative resolution context — revision / SV / delete set from HEAD. */
  private contextOf(doc: Y.Doc): AuthoritativeContext {
    const ds = Y.snapshot(doc).ds;
    const dsPlain: Record<string, [number, number][]> = {};
    for (const [client, ranges] of ds.clients.entries()) {
      dsPlain[String(client)] = (ranges as Array<{ clock: number; len: number }>).map((r) => [
        r.clock,
        r.len,
      ]);
    }
    return {
      revision: this.liveRevision(doc),
      stateVector: bytesToBase64(Y.encodeStateVector(doc)),
      deleteSet: bytesToBase64(new TextEncoder().encode(JSON.stringify(dsPlain))),
    };
  }

  authoritativeContext(): AuthoritativeContext | null {
    const doc = this.acquire();
    if (!doc) return null; // unavailable / stalled ⇒ no context to sign (fail-closed)
    return this.contextOf(doc);
  }

  captureSelection(): CapturedSelection | null {
    const doc = this.acquire();
    if (!doc || !this.selection) return null;
    const body = this.bodyAtPath(doc, this.selection.path);
    if (!body) return null;
    const { start, end } = this.selection;

    const relStart = Y.createRelativePositionFromTypeIndex(body, start, -1);
    const relEnd = Y.createRelativePositionFromTypeIndex(body, end, 1);

    const { fragment, enclosedItems } = this.renderWindow(body, start, end);
    return {
      ...this.contextOf(doc),
      relStart: bytesToBase64(Y.encodeRelativePosition(relStart)),
      relEnd: bytesToBase64(Y.encodeRelativePosition(relEnd)),
      fragment,
      enclosedItems,
    };
  }

  resolveSpan(anchor: CovenantAnchor): ResolvedSpan | null {
    const doc = this.acquire();
    if (!doc) return null; // unavailable / stalled ⇒ fail-closed

    const relStart = Y.decodeRelativePosition(base64ToBytes(anchor.relStart));
    const relEnd = Y.decodeRelativePosition(base64ToBytes(anchor.relEnd));
    const absStart = Y.createAbsolutePositionFromRelativePosition(relStart, doc);
    const absEnd = Y.createAbsolutePositionFromRelativePosition(relEnd, doc);
    if (!absStart || !absEnd) return null;
    const body = absStart.type;
    if (!(body instanceof Y.XmlText) || absEnd.type !== body) return null;
    const item = (body as unknown as { _item: { deleted: boolean } | null })._item;
    if (item?.deleted) return null;

    const start = Math.min(absStart.index, absEnd.index);
    const end = Math.max(absStart.index, absEnd.index);
    const { fragment, enclosedItems } = this.renderWindow(body, start, end);
    return {
      fragment,
      enclosedItems,
      snapshotVerified: this.verifySnapshot(doc, anchor, body, start, end),
    };
  }
}

/**
 * Bind the production reader to the live #183 conversation doc's handle.
 *
 * #183's `ConversationDoc` today carries MESSAGE-LEVEL content (a `Y.Array` of
 * JSON messages); its rich-text bodies — the `Y.XmlText` spans this reader
 * resolves against — arrive with sub-message co-editing (#184/#185). This binding
 * takes the same handle the surface already holds and exposes it as a
 * deadline-guarded {@link DocSource}: a torn-down / dropped doc polls `null` and
 * fails closed to DRIFT, exactly as a stalled Electric stream does. `provider`
 * returns the live `Y.Doc` or `null` when the handle is gone.
 */
export function readerForLiveDoc(
  provider: () => Y.Doc | null,
  selection?: { path: BodyPath; start: number; end: number },
  options?: ReaderOptions,
): CovenantDocReaderProd {
  const source: DocSource = { poll: () => provider() };
  return new CovenantDocReaderProd(source, selection, options);
}
