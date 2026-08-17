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
import * as Y from 'yjs';

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
 *       ONLY through a non-blocking {@link DocSource} poll. The SYNCHRONOUS port
 *       methods poll ONCE — a source not ready right now fails closed at once,
 *       never blocking the event loop. The LIVE/streaming path uses the async port
 *       (`resolveSpanAsync` / `captureSelectionAsync` / `authoritativeContextAsync`)
 *       whose deadline is genuinely async, cancellable, and MONOTONIC: a never-ready
 *       OR slow-eventually-ready source yields `null` (⇒ DRIFT) at the deadline
 *       without a late `ok` and without a busy-spin (the 250ms busy-spin is gone).
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

/**
 * A resolver for the doc's CONTENT ROOT — the share where the certified span's
 * body lives. The live conversation's rich-text bodies (#194) are NOT under an
 * arbitrary `getXmlFragment('doc')`; binding to the wrong share means a content
 * mutation is never seen (the #189 MEDIUM). The caller supplies the share it
 * actually writes conversation content into; `null` ⇒ the share is absent, which
 * fails CLOSED (no capture, DRIFT) rather than resolving against an empty plant.
 */
export type RootResolver = (doc: Y.Doc) => Y.XmlFragment | Y.XmlElement | null;

/** The default content root — the `'doc'` XML fragment (the synthetic conformance shape). */
const DEFAULT_ROOT: RootResolver = (doc) => doc.getXmlFragment('doc');

export interface ReaderOptions {
  /**
   * The async resolution deadline in ms (hardening c). A source not ready within
   * a genuinely async, cancellable, MONOTONIC deadline fails closed — and a source
   * that becomes ready only AFTER the deadline is refused (no late `ok`). Consumed
   * by {@link CovenantDocReaderProd.resolveSpanAsync} and its siblings; the
   * synchronous port methods poll ONCE (never block the event loop).
   */
  deadlineMs?: number;
  /**
   * The MONOTONIC clock the async deadline reads (defaults to `performance.now`).
   * Injected in tests. Must be monotonic — a wall clock can jump backwards and
   * make a deadline never fire; the busy-spin this replaces used `Date.now`.
   */
  monotonicNow?: () => number;
  /**
   * Where the certified span's body is resolved FROM — the live conversation
   * content share. Defaults to the `'doc'` XML fragment. The live binding
   * ({@link readerForLiveDoc}) points this at the real conversation content so a
   * content mutation is actually seen; an absent share (`null`) fails closed.
   */
  resolveRoot?: RootResolver;
}

const DEFAULT_DEADLINE_MS = 250;

/** The span a reader captures from: a doc-path to a `Y.XmlText` body + char range. */
export type BodyPath = number[];

function isDocSource(x: unknown): x is DocSource {
  return typeof x === 'object' && x !== null && typeof (x as DocSource).poll === 'function';
}

/** A monotonic clock — never runs backwards, unlike `Date.now`. */
function defaultMonotonicNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/**
 * Sleep `ms`, resolving EARLY (not rejecting) if `signal` aborts — so the async
 * deadline loop yields the event loop between polls (never a busy-spin) and is
 * cancellable. A zero/negative `ms` still yields one macrotask, so a never-ready
 * source cannot starve the loop.
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
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
// INJECTIVE, type-tagged, NFC-normalized serialization of an arbitrary leaf value
// — the discipline `@atrium/core`'s `canonical()` uses on the fragment itself,
// hardened for the covenant's INJECTIVITY requirement (#189 CRITICAL): DISTINCT
// content MUST serialize to a DISTINCT string (no false `✓`). Every branch carries
// a TYPE TAG, so a scalar `"x"` (`s:"x"`) ≠ an object `{value:"x"}` (`o:{…}`);
// `null` (`z:null`) ≠ `NaN` (`n:NaN`) ≠ `Infinity` (`n:Infinity`) — where a bare
// `JSON.stringify` folds `NaN`/`Infinity` to `null`; a bigint `1n` (`i:1`) ≠ the
// string `"bigint:1"` (`s:"bigint:1"`); and `Date`/`Map`/`Set` keep their own tag
// and structure instead of collapsing to `{}` (their `Object.keys` is empty). A
// nested object is serialized field-by-field with keys NFC-normalized BEFORE they
// are sorted (sort-before-normalize false-STALES a composed vs decomposed key). A
// value with NO injective rendering (a function / symbol) THROWS — fail-CLOSED to
// DRIFT — rather than collapsing onto a token two distinct values would share.
// ─────────────────────────────────────────────────────────────────────────────

export function canonicalizeLeafValue(value: unknown): string {
  if (value === null) return 'z:null';
  if (value === undefined) return 'z:undefined';
  const t = typeof value;
  if (t === 'string') return `s:${JSON.stringify((value as string).normalize('NFC'))}`;
  if (t === 'boolean') return `b:${value ? 'true' : 'false'}`;
  if (t === 'number') {
    const n = value as number;
    if (Number.isNaN(n)) return 'n:NaN';
    if (n === Number.POSITIVE_INFINITY) return 'n:Infinity';
    if (n === Number.NEGATIVE_INFINITY) return 'n:-Infinity';
    if (Object.is(n, -0)) return 'n:-0'; // -0 and +0 are distinct writes
    return `n:${JSON.stringify(n)}`;
  }
  if (t === 'bigint') return `i:${(value as bigint).toString()}`;
  if (t === 'function' || t === 'symbol') {
    // No rendered meaning and no injective serialization — fail CLOSED (the throw
    // becomes DRIFT in resolveCovenant / a refused anchor at certify), NEVER a
    // shared token two distinct unsupported values would collapse onto.
    throw new Error(`covenant reader: unsupported leaf value of type ${t}`);
  }
  if (Array.isArray(value)) return `a:[${value.map(canonicalizeLeafValue).join(',')}]`;
  if (value instanceof Date) {
    const ms = value.getTime();
    return `d:${Number.isNaN(ms) ? 'NaN' : String(ms)}`;
  }
  if (value instanceof Map) {
    const parts = [...(value as Map<unknown, unknown>).entries()]
      .map(([k, v]) => `${canonicalizeLeafValue(k)}=>${canonicalizeLeafValue(v)}`)
      .sort();
    return `m:{${parts.join(',')}}`;
  }
  if (value instanceof Set) {
    const parts = [...(value as Set<unknown>).values()].map(canonicalizeLeafValue).sort();
    return `t:[${parts.join(',')}]`;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    // NFC-normalize each key BEFORE sorting, then tag it so no key can collide with
    // a positional token.
    const entries = Object.keys(obj).map((k) => [k.normalize('NFC'), obj[k]] as const);
    entries.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    return `o:{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalizeLeafValue(v)}`)
      .join(',')}}`;
  }
  throw new Error(`covenant reader: unsupported leaf value of type ${t}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// The reader.
// ─────────────────────────────────────────────────────────────────────────────

export class CovenantDocReaderProd implements CovenantDocReader {
  private readonly source: DocSource;
  private readonly immediate: ImmediateSource | null;
  private readonly deadlineMs: number;
  private readonly monotonicNow: () => number;
  private readonly resolveRoot: RootResolver;

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
    this.monotonicNow = options?.monotonicNow ?? defaultMonotonicNow;
    this.resolveRoot = options?.resolveRoot ?? DEFAULT_ROOT;
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

  /** Hardening (c): the async resolution is bounded by a deadline (fail-closed, never hangs). */
  protected get deadlineEnabled(): boolean {
    return true;
  }

  // ── doc acquisition (hardening c) ───────────────────────────────────────────

  /**
   * SYNCHRONOUS acquisition: a SINGLE non-blocking poll. The synchronous port
   * methods (which `@atrium/core`'s sync `certifyAnchor` / `resolveCovenant` call)
   * never block the event loop and never busy-spin — a source not ready RIGHT NOW
   * fails closed (`null` ⇒ DRIFT / no capture) immediately. Waiting for a
   * catching-up stream is the ASYNC path's job ({@link acquireAsync}); a
   * synchronous caller cannot honestly wait, so it does not pretend to.
   */
  private acquire(): Y.Doc | null {
    return this.source.poll();
  }

  /**
   * ASYNCHRONOUS acquisition with a genuinely async, cancellable, MONOTONIC
   * deadline (hardening c, rebuilt — the 250ms busy-spin is gone). Between polls
   * it `await`s a real timer, so the event loop is free (a stream catching up on a
   * timer CAN make progress — a busy-spin would starve it). Three guarantees:
   *
   *   - a NEVER-ready source resolves `null` (⇒ DRIFT) promptly at the deadline;
   *   - a source that becomes ready only AFTER the deadline is REFUSED (`null`) —
   *     the deadline is checked BEFORE the poll is accepted, so there is no late `ok`;
   *   - an aborted `signal` resolves `null` at once (cancellable).
   *
   * When the deadline is disabled (the naive foil), a never-ready source is polled
   * forever — the hang the hardening prevents, which the not-theater test observes.
   */
  private async acquireAsync(signal?: AbortSignal): Promise<Y.Doc | null> {
    const start = this.monotonicNow();
    // Poll cadence: small enough to be prompt, non-zero so a stalled source cannot
    // starve the loop. Never longer than the remaining budget.
    const pollEveryMs = 1;
    for (;;) {
      if (signal?.aborted) return null;
      const elapsed = this.monotonicNow() - start;
      // Deadline FIRST: a doc that only just became ready AT/AFTER the deadline is
      // a late arrival and must NOT be accepted (the false-`ok` codex found).
      if (this.deadlineEnabled && elapsed >= this.deadlineMs) return null;
      const doc = this.source.poll();
      if (doc) return doc;
      const remaining = this.deadlineEnabled ? this.deadlineMs - elapsed : pollEveryMs;
      await delay(Math.min(pollEveryMs, Math.max(0, remaining)), signal);
    }
  }

  private rootOf(doc: Y.Doc): Y.XmlFragment | Y.XmlElement | null {
    return this.resolveRoot(doc);
  }

  /** Follow a path of child indices from the content root to a `Y.XmlText` body. */
  private bodyAtPath(doc: Y.Doc, path: BodyPath): Y.XmlText | null {
    let node: Y.XmlFragment | Y.XmlElement | Y.XmlText | null = this.rootOf(doc);
    for (const idx of path) {
      if (!node || node instanceof Y.XmlText) return null;
      const child: unknown = node.get(idx);
      if (child instanceof Y.XmlElement || child instanceof Y.XmlText) node = child;
      else return null;
    }
    return node instanceof Y.XmlText ? node : null;
  }

  // ── rendering ───────────────────────────────────────────────────────────────

  /**
   * The marks a text OR embed op carries, INJECTIVELY (hardening a + the #189
   * injectivity CRITICAL). The mark's payload SHAPE is encoded so no two distinct
   * payloads collapse to one `attrs` map:
   *
   *   - an OBJECT payload (`{ link: { href, meta:{…} } }`) → each field under a
   *     reserved `f:` namespace, plus a `#shape:object` tag, so a field literally
   *     named `value`/`scalar` can never masquerade as the scalar/flag branch, and
   *     an empty object `{}` (`{#shape:object}`) never equals a boolean flag;
   *   - a FLAG payload (`bold:true` / `null` / `undefined` / `false`) → `#flag`
   *     carrying the tagged value, so `true` ≠ `false` ≠ `null` ≠ `undefined`;
   *   - a SCALAR / array / Date / Map / Set payload → a single tagged `#scalar`, so
   *     a scalar `"x"` (`s:"x"`) is DISTINCT from the object `{value:"x"}` above.
   */
  private marksOf(attributes: Record<string, unknown> | undefined): Mark[] {
    if (!attributes) return [];
    return Object.keys(attributes)
      .sort()
      .map((type) => {
        const raw = attributes[type];
        const isPlainObject =
          raw !== null &&
          typeof raw === 'object' &&
          !Array.isArray(raw) &&
          !(raw instanceof Date) &&
          !(raw instanceof Map) &&
          !(raw instanceof Set);
        let attrs: Record<string, string>;
        if (isPlainObject) {
          attrs = { '#shape': 'object' };
          for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
            attrs[`f:${k}`] = this.canonicalizeLeaf(v);
          }
        } else if (raw === true || raw === false || raw === null || raw === undefined) {
          attrs = { '#flag': this.canonicalizeLeaf(raw) }; // true ≠ false ≠ null ≠ undefined
        } else {
          // A scalar / array / Date / Map / Set payload — a single tagged value; the
          // tag encodes the TYPE, so a scalar can never collide with an object field.
          attrs = { '#scalar': this.canonicalizeLeaf(raw) };
        }
        return { type, attrs, straddles: 'none' as const };
      });
  }

  /**
   * The identity of an embed — every field serialized INJECTIVELY (hardening a +
   * the #189 injectivity CRITICAL), plus a digest of any `child`/`children` body
   * computed FROM THE CHILD. Two things are closed here:
   *
   *   - NO `String(obj)` anywhere: `embedType` and every attr go through the tagged
   *     `canonicalizeLeaf`, so two distinct embeds differing only in a nested object
   *     no longer collide to a false `✓`, and an unsupported value fails CLOSED.
   *   - THE READER'S OWN FIELDS ARE RESERVED / NAMESPACED (grok's headline). The
   *     child digest lands on a reader-owned `#child` / `#children` key computed
   *     from the child itself, while EVERY passthrough attr is `a:`-namespaced — so
   *     a caller-supplied CRDT field named `docDigest` (or `#child`, or anything)
   *     becomes `a:docDigest` and can NEVER shadow the real child digest. Before
   *     this, a sibling `docDigest` field won `Object.entries` order and the actual
   *     child content was ignored (`innocent`→`EVIL` stayed `ok`).
   */
  private embedIdentity(embed: Record<string, unknown>): {
    embedType: string;
    identity: Record<string, string>;
  } {
    const rawType = embed.embedType ?? embed.type ?? 'embed';
    // A string type is used verbatim (NFC); a non-string type is canonicalized
    // injectively (still a non-empty string, so `RenderedNode.embedType` is valid)
    // rather than `String(obj)`-collapsed — an unsupported shape throws (fail-closed).
    const embedType =
      typeof rawType === 'string' ? rawType.normalize('NFC') : this.canonicalizeLeaf(rawType);
    const identity: Record<string, string> = {};
    for (const [k, v] of Object.entries(embed)) {
      if (k === 'embedType' || k === 'type') continue;
      if (k === 'child' || k === 'children') {
        // Reader-OWNED reserved key, computed from the CHILD `v` (never a sibling).
        // Every passthrough attr is `a:`-namespaced, so nothing a peer writes can
        // produce this bare `#child` / `#children` key.
        identity[k === 'children' ? '#children' : '#child'] = sha256Hex(this.canonicalizeLeaf(v));
        continue;
      }
      // Every OTHER field under the `a:` passthrough namespace, serialized
      // injectively — a scalar keeps its type, a nested object is field-by-field,
      // NEVER coerced to "[object Object]".
      identity[`a:${k}`] = this.canonicalizeLeaf(v);
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
      // An ancestor attribute value (y-prosemirror stores a node's `attrs` here) can
      // be a nested OBJECT — `setAttribute('meta', { v: 2 })`. `String(v)` collapsed
      // every such object to "[object Object]", so `{v:2}` and `{v:1}` shared a digest
      // (#189 CRITICAL). Serialize it INJECTIVELY, exactly as an embed/mark field.
      for (const [k, v] of Object.entries(parent.getAttributes()))
        attrs[k] = this.canonicalizeLeaf(v);
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

  /** Build the captured selection from an acquired doc (shared by sync + async). */
  private buildCapture(doc: Y.Doc): CapturedSelection | null {
    if (!this.selection) return null;
    const body = this.bodyAtPath(doc, this.selection.path);
    if (!body) return null; // content share absent / path unresolved ⇒ fail-closed
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

  /** Resolve an anchor against an acquired doc (shared by sync + async). */
  private buildResolve(doc: Y.Doc, anchor: CovenantAnchor): ResolvedSpan | null {
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

  // ── SYNCHRONOUS port (single-poll; the sync core primitives call these) ──────

  authoritativeContext(): AuthoritativeContext | null {
    const doc = this.acquire();
    if (!doc) return null; // unavailable / stalled ⇒ no context to sign (fail-closed)
    return this.contextOf(doc);
  }

  captureSelection(): CapturedSelection | null {
    const doc = this.acquire();
    if (!doc) return null;
    return this.buildCapture(doc);
  }

  resolveSpan(anchor: CovenantAnchor): ResolvedSpan | null {
    const doc = this.acquire();
    if (!doc) return null; // unavailable / stalled ⇒ fail-closed
    return this.buildResolve(doc, anchor);
  }

  // ── ASYNCHRONOUS port (deadline-bounded; the live/streaming read path, #191) ──
  // These honour the genuinely-async, cancellable, monotonic deadline of hardening
  // (c): a stalled stream yields `null` (⇒ DRIFT / no capture) at the deadline,
  // never a late `ok`, without blocking the event loop. A render throw propagates
  // (⇒ the read authority's guard turns it into DRIFT), matching the sync path.

  async authoritativeContextAsync(signal?: AbortSignal): Promise<AuthoritativeContext | null> {
    const doc = await this.acquireAsync(signal);
    if (!doc) return null;
    return this.contextOf(doc);
  }

  async captureSelectionAsync(signal?: AbortSignal): Promise<CapturedSelection | null> {
    const doc = await this.acquireAsync(signal);
    if (!doc) return null;
    return this.buildCapture(doc);
  }

  async resolveSpanAsync(
    anchor: CovenantAnchor,
    signal?: AbortSignal,
  ): Promise<ResolvedSpan | null> {
    const doc = await this.acquireAsync(signal);
    if (!doc) return null; // never-ready / past-deadline / aborted ⇒ fail-closed
    return this.buildResolve(doc, anchor);
  }
}

/**
 * Bind the production reader to the live #183 conversation doc's handle.
 *
 * #183's `ConversationDoc` today carries MESSAGE-LEVEL content (a `Y.Array` of
 * JSON messages); its rich-text bodies — the `Y.XmlText` spans this reader
 * resolves against — arrive with #194 (rich-text-spans-first). This binding takes
 * the same handle the surface already holds and exposes it as a deadline-guarded
 * {@link DocSource}: a torn-down / dropped doc polls `null` and fails closed to
 * DRIFT, exactly as a stalled Electric stream does. `provider` returns the live
 * `Y.Doc` or `null` when the handle is gone.
 *
 * WATCH THE CORRECT SHARE (#189 MEDIUM). The reader resolves the certified span's
 * body from `options.resolveRoot` — the SHARE the conversation actually writes its
 * content into (`#194`'s rich-text bodies), NOT a hardcoded / planted
 * `getXmlFragment('doc')`. Pass the conversation's real content root so a content
 * mutation is genuinely seen; if the share is absent, `resolveRoot` returns `null`
 * and capture/resolve fail closed (DRIFT) instead of vouching for an empty plant.
 */
export function readerForLiveDoc(
  provider: () => Y.Doc | null,
  selection?: { path: BodyPath; start: number; end: number },
  options?: ReaderOptions,
): CovenantDocReaderProd {
  const source: DocSource = { poll: () => provider() };
  return new CovenantDocReaderProd(source, selection, options);
}
