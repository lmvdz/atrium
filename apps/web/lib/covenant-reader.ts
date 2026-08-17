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
 * A source of the live `Y.Doc`, polled non-blockingly. `poll(signal)` returns the
 * doc when it is ready, or `null` while it is pending / unavailable / torn down. The
 * async deadline passes its `AbortSignal` INTO `poll` (#189 round-2) so a source
 * whose own acquisition is cancellable can abandon in-flight work at once, rather
 * than the deadline loop merely ignoring a doc it eventually returns. A source that
 * is permanently `null` is the "stalled stream" case the deadline turns into DRIFT.
 */
export interface DocSource {
  poll(signal?: AbortSignal): Y.Doc | null;
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
 *
 * The abort listener is REMOVED on normal (timer) completion (#189 round-2 finding):
 * a stalled acquire polls hundreds of times, and a listener left registered on each
 * pass accumulates (~250 callbacks) on a long-lived signal — a real leak. Registering
 * a NAMED listener and removing it in BOTH the timer and abort paths keeps at most one
 * live at a time.
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort); // normal completion — drop the listener
        resolve();
      },
      Math.max(0, ms),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
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
// ALLOWLIST-THE-COMPLIANT-FORM serialization of a leaf value (#189 round-3, the
// class-closer). The round-2 gauntlet proved a TAG-EVERYTHING encoder can never be
// injective — every new exotic shape (`Uint8Array` ≡ `{0:1}`, a sparse hole ≡ `[]`,
// NFC-duplicate keys last-wins) is another collision. So instead of adding tags, we
// injectively encode a CLOSED ALLOWLIST of compliant forms and FAIL CLOSED — THROW,
// which `resolveCovenant` turns into DRIFT / a refused anchor at certify — on
// EVERYTHING else. A throw is never a shared token two distinct values collapse onto.
//
//   LEAF allowlist   — `string`, FINITE `number`, `boolean`, `null`, plus a
//                      dedicated `undefined` tag and a dedicated `bigint` tag (each
//                      an unambiguous, injective form). `NaN`/`±Infinity` are NOT
//                      finite ⇒ THROW (no `JSON.stringify`-to-`null` fold to hide in).
//   STRUCTURED allow — (a) a PLAIN object (own-enumerable keys, `Object.prototype`
//                      or null-proto ONLY) whose keys' NFC forms are UNIQUE; two raw
//                      keys that normalize equal ⇒ THROW (never last-wins-overwrite).
//                      (b) a DENSE array; a hole (`new Array(1)`, sparse) ⇒ THROW.
//                      The length is encoded (`a:${len}:[…]`) so `[undefined]` (len 1)
//                      can never equal `[]` (len 0).
//   REJECT ⇒ DRIFT   — typed arrays (`Uint8Array` …), sparse arrays, `Date`/`Map`/
//                      `Set`, functions, symbols, class instances / any unrecognized
//                      prototype. `Uint8Array([1])` MUST NOT share `{0:1}`'s encoding,
//                      so it is refused, not coerced to `o:{"0":n:1}`.
//
// Keys are NFC-normalized BEFORE they are sorted (sort-before-normalize false-STALES
// a composed vs decomposed key). Every branch carries a TYPE TAG, so a scalar `"x"`
// (`s:"x"`) is distinct from an object `{value:"x"}` (`o:{…}`) and a bigint `1n`
// (`i:1`) from the string `"bigint:1"` (`s:"bigint:1"`).
// ─────────────────────────────────────────────────────────────────────────────

function reject(what: string): never {
  // Fail CLOSED: the throw becomes DRIFT in resolveCovenant / a refused anchor at
  // certify, NEVER a shared token two distinct non-compliant values collapse onto.
  throw new Error(`covenant reader: non-compliant value shape (${what}) — failing closed to DRIFT`);
}

export function canonicalizeLeafValue(value: unknown): string {
  if (value === null) return 'z:null';
  if (value === undefined) return 'z:undefined';
  const t = typeof value;
  if (t === 'string') return `s:${JSON.stringify((value as string).normalize('NFC'))}`;
  if (t === 'boolean') return `b:${value ? 'true' : 'false'}`;
  if (t === 'number') {
    const n = value as number;
    // Allowlist: FINITE numbers only. NaN/±Infinity are not compliant leaf content
    // and have no place in a rendered span → fail closed (never fold to `null`).
    if (!Number.isFinite(n)) reject(`non-finite number ${String(n)}`);
    if (Object.is(n, -0)) return 'n:-0'; // -0 and +0 are distinct finite writes
    return `n:${JSON.stringify(n)}`;
  }
  if (t === 'bigint') return `i:${(value as bigint).toString()}`;
  // Functions / symbols: no injective serialization → reject.
  if (t !== 'object') reject(`type ${t}`);

  if (Array.isArray(value)) {
    // DENSE arrays only. A hole (`new Array(1)`, a sparse deletion) is NOT `[]`, and
    // `.map`/`.join` silently skip holes — so reject any hole outright, and encode
    // the length so `[undefined]` (len 1) can never collapse onto `[]` (len 0).
    const len = value.length;
    const parts: string[] = [];
    for (let i = 0; i < len; i++) {
      if (!(i in value)) reject('sparse array (hole)');
      parts.push(canonicalizeLeafValue(value[i]));
    }
    return `a:${len}:[${parts.join(',')}]`;
  }

  // PLAIN objects only. `Date`/`Map`/`Set`/typed arrays/class instances all have a
  // non-`Object.prototype` prototype and are refused here — they must NOT be coerced
  // to `o:{…}` (a `Uint8Array` would become `{0:…}` and shadow a real index object).
  const proto = Object.getPrototypeOf(value as object);
  if (proto !== Object.prototype && proto !== null) reject('non-plain prototype');
  // A symbol-keyed object would silently drop those keys from `Object.keys` (two
  // distinct symbol-keyed objects collapsing) — refuse it.
  if (Object.getOwnPropertySymbols(value as object).length > 0) reject('symbol-keyed object');

  const obj = value as Record<string, unknown>;
  const seen = new Set<string>();
  const entries: Array<readonly [string, unknown]> = [];
  for (const rawKey of Object.keys(obj)) {
    const key = rawKey.normalize('NFC');
    // Two raw keys whose NFC forms are equal are ambiguous: keeping both would emit a
    // duplicate key slot, and merging them last-wins would silently drop a value.
    // Neither is injective → fail closed.
    if (seen.has(key)) reject('NFC-duplicate object keys');
    seen.add(key);
    entries.push([key, obj[rawKey]] as const);
  }
  entries.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  return `o:{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalizeLeafValue(v)}`)
    .join(',')}}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SAFE ATTRIBUTE ADAPTER (#189 round-4 / consolidation, finding: `__proto__` is an
// INVISIBLE ancestor attribute). `Y.XmlElement.getAttributes()` materializes a PLAIN
// object with `obj[key] = value`. When `key` is `__proto__` (or any other prototype
// setter), that assignment mutates the object's PROTOTYPE instead of creating an own
// key, so the attribute is SILENTLY DROPPED from the returned record — an invisible
// mutation that leaves the digest unchanged (a false `✓`: an anchor minted over
// `__proto__:'INNOCENT'` resolves `ok` against a live `__proto__:'EVIL'`).
//
// This reads the element's attributes through a GUARDED enumeration instead: Yjs
// stores them in the element's own `_map` (a real `Map`, immune to the prototype
// hazard). We enumerate the live (non-deleted) keys there, read each value with the
// per-key `getAttribute` (also hazard-free), and CROSS-CHECK against the materialized
// `getAttributes()` record: if the plain object is MISSING any live key the map
// carries, materialization dropped it ⇒ FAIL CLOSED (throw ⇒ DRIFT). An honest doc
// (no prototype-hazard keys) enumerates identically to `getAttributes()` and never
// throws. Entries land in the caller's null-prototype record, so the reader never
// re-introduces the same hazard when it rebuilds the canonical attrs map.
// ─────────────────────────────────────────────────────────────────────────────

interface AttrMapItem {
  deleted?: boolean;
}

function safeElementAttrs(el: Y.XmlElement): Array<[string, unknown]> {
  const map = (el as unknown as { _map?: Map<string, AttrMapItem> })._map;
  if (!(map instanceof Map)) {
    // A foreign element shape with no attribute map — cannot enumerate safely.
    reject('ancestor element has no attribute map (foreign shape)');
  }
  const materialized = el.getAttributes() as Record<string, unknown>;
  const entries: Array<[string, unknown]> = [];
  for (const [key, item] of map.entries()) {
    if (item?.deleted) continue; // a deleted attribute is not live content
    // If the plain-object materialization dropped this live key (a prototype-hazard
    // key such as `__proto__`), the record is lossy and any digest over it is a lie.
    if (!Object.hasOwn(materialized, key)) {
      reject(`ancestor attribute key dropped by materialization (${JSON.stringify(key)})`);
    }
    entries.push([key, el.getAttribute(key)]);
  }
  return entries;
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
    // DEADLINE-SCOPED AbortController (#189 round-4 point 6). Round-3 forwarded the
    // caller's `signal` into `poll` but never aborted anything on TIMEOUT — a source
    // that kicked off background acquisition on `poll(signal)` was left running (a
    // leaked task / listeners) after the deadline gave up. We own a controller here,
    // COMBINE it with the caller's signal (a caller abort aborts ours), pass OUR
    // combined signal into `poll`/`delay`, and abort it in `finally` — so a timed-out
    // OR normally-completed acquire actually cancels any in-flight work exactly once.
    const controller = new AbortController();
    const combined = controller.signal;
    const onCallerAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onCallerAbort, { once: true });
    }
    // Poll cadence: small enough to be prompt, non-zero so a stalled source cannot
    // starve the loop. Never longer than the remaining budget.
    const pollEveryMs = 1;
    const start = this.monotonicNow();
    try {
      for (;;) {
        if (combined.aborted) return null;
        const elapsed = this.monotonicNow() - start;
        // Deadline FIRST: a doc that only just became ready AT/AFTER the deadline is
        // a late arrival and must NOT be accepted (the false-`ok` codex found).
        if (this.deadlineEnabled && elapsed >= this.deadlineMs) return null;
        // OUR combined signal flows INTO poll so a cancellable source abandons in-flight
        // work when either the caller aborts OR the deadline fires (via `finally`).
        const doc = this.source.poll(combined);
        if (doc) {
          // RE-CHECK after poll returns (#189 round-2, codex's 10.001ms window): a
          // slow poll can itself straddle the deadline or an abort, so re-sample the
          // monotonic clock AND the signal before ACCEPTING the doc.
          if (combined.aborted) return null;
          if (this.deadlineEnabled && this.monotonicNow() - start >= this.deadlineMs) return null;
          return doc;
        }
        const remaining = this.deadlineEnabled ? this.deadlineMs - elapsed : pollEveryMs;
        await delay(Math.min(pollEveryMs, Math.max(0, remaining)), combined);
      }
    } finally {
      // Timed-out / aborted / resolved — cancel any in-flight acquisition the source
      // started against `combined`, and drop the caller-forwarding listener (no leak).
      controller.abort();
      if (signal) signal.removeEventListener('abort', onCallerAbort);
    }
  }

  private rootOf(doc: Y.Doc): Y.XmlFragment | Y.XmlElement | null {
    return this.resolveRoot(doc);
  }

  /**
   * Is `body` contained under `root` (the configured content share)? Ascends the
   * parent chain from the body and requires it to pass through `root` by IDENTITY
   * (`===`). Used to enforce {@link resolveRoot} on RESOLUTION (#189 round-4 point 5),
   * so a span whose relative positions resolve into a DIFFERENT share (an anchor minted
   * under another root, or a planted share divorced from conversation content) is
   * rejected — capture-time root enforcement alone let such an anchor resolve `ok`.
   */
  private bodyUnderRoot(body: Y.XmlText, root: Y.XmlFragment | Y.XmlElement): boolean {
    let node: { parent?: unknown } | null = body as { parent?: unknown };
    while (node) {
      if ((node as unknown) === (root as unknown)) return true;
      const parent: unknown = node.parent;
      node = parent && typeof parent === 'object' ? (parent as { parent?: unknown }) : null;
    }
    return false;
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
   * The marks a text OR embed op carries, INJECTIVELY (the #189 injectivity
   * CRITICAL, closed by ALLOWLIST in round-3). The mark's payload runs through the
   * single allowlist encoder ({@link canonicalizeLeaf}), so an exotic payload — a
   * `Uint8Array`, a sparse array, an NFC-duplicate-keyed object — FAILS CLOSED
   * (throws ⇒ DRIFT) instead of collapsing onto a compliant object's encoding (a
   * `Uint8Array` mark once shared `{0:…}`'s `f:0` map). The payload SHAPE is still
   * tagged so no two shapes collapse to one `attrs` map:
   *
   *   - an OBJECT payload (`{ link: { href } }`) → one `#object` key carrying the
   *     allowlist encoding of the whole object, so a field literally named
   *     `value`/`scalar` can never masquerade as the scalar/flag branch;
   *   - a FLAG payload (`bold:true` / `null` / `undefined` / `false`) → `#flag`
   *     carrying the tagged value, so `true` ≠ `false` ≠ `null` ≠ `undefined`;
   *   - a SCALAR / dense-array payload → a single tagged `#scalar`, so a scalar
   *     `"x"` (`s:"x"`) is DISTINCT from the object `{value:"x"}` above.
   */
  private marksOf(attributes: Record<string, unknown> | undefined): Mark[] {
    if (!attributes) return [];
    // NFC-UNIQUE mark NAMES (#189 round-4 point 4). Mark names are a KEY SURFACE just
    // like object keys / ancestor attr names: two raw names normalizing NFC-equal are
    // ambiguous (a last-wins map would silently drop one) ⇒ fail closed. Round-3
    // normalized object keys but NOT mark names — the same class in a sibling location.
    const seenNames = new Set<string>();
    const marks: Mark[] = [];
    for (const rawName of Object.keys(attributes)) {
      const type = rawName.normalize('NFC');
      if (seenNames.has(type)) reject('NFC-duplicate mark names');
      seenNames.add(type);
      // ONE canonicalizer: the WHOLE payload through {@link canonicalizeLeaf}. Its type
      // tag already discriminates every shape — a scalar `"x"` (`s:"x"`) from an object
      // `{value:"x"}` (`o:{…}`) from a flag `true` (`b:true`) from `null` (`z:null`) —
      // so a single `#v` slot is injective; no per-shape `#object`/`#flag`/`#scalar`
      // fork (which could itself drift out of sync) is needed. A non-compliant payload
      // (typed array, NFC-dup keys, non-plain proto) throws here ⇒ DRIFT.
      marks.push({
        type,
        attrs: { '#v': this.canonicalizeLeaf(attributes[rawName]) },
        straddles: 'none',
      });
    }
    marks.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
    return marks;
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
    // EXPLICIT TYPE-SOURCE + PRESENCE (#189 round-4 point 3) — NO `?? default` folding.
    // Round-3 computed `embed.type ?? 'embed'`, which folded THREE distinct embeds onto
    // one channel: `{k}` (type absent), `{type:'embed',k}`, and `{type:null,k}` all
    // became `s:embed` (a false `✓`, and mutating `type` in place left the digest put).
    // The channel now encodes BOTH which field supplied the type (`embedType` vs `type`
    // vs neither) AND its exact value through the ONE canonicalizer, so:
    //   - type ABSENT → `none`; `type:'embed'` → `type:s:"embed"`; `type:null` →
    //     `type:z:null` — three DISTINCT channels;
    //   - a string can't impersonate a non-string (`embedType:'o:{}'` → `embedType:s:"o:{}"`
    //     vs `embedType:{}` → `embedType:o:{}`), nor forge the other field's prefix;
    //   - mutating the channel field in place MOVES the channel (⇒ digest moves).
    const hasEmbedType = Object.hasOwn(embed, 'embedType');
    const hasType = Object.hasOwn(embed, 'type');
    let embedType: string;
    let channelField: 'embedType' | 'type' | null;
    if (hasEmbedType) {
      embedType = `embedType:${this.canonicalizeLeaf(embed.embedType)}`;
      channelField = 'embedType';
    } else if (hasType) {
      embedType = `type:${this.canonicalizeLeaf(embed.type)}`;
      channelField = 'type';
    } else {
      embedType = 'none';
      channelField = null;
    }

    const identity: Record<string, string> = Object.create(null);
    const seenKeys = new Set<string>();
    for (const [k, v] of Object.entries(embed)) {
      // Consume ONLY the field used as the type channel — never both. When `embedType`
      // is the channel, a sibling `type` is NOT dropped: it flows through as a normal
      // `a:type` passthrough, so two embeds differing only in `type` differ.
      if (channelField !== null && k === channelField) continue;
      if (k === 'child' || k === 'children') {
        // Reader-OWNED reserved key, computed from the CHILD `v` (never a sibling).
        // Every passthrough attr is `a:`-namespaced, so nothing a peer writes can
        // produce this bare `#child` / `#children` key.
        identity[k === 'children' ? '#children' : '#child'] = sha256Hex(this.canonicalizeLeaf(v));
        continue;
      }
      // Every OTHER field under the `a:` passthrough namespace, its key NFC-normalized
      // and deduplicated (two keys normalizing equal would else last-wins-overwrite a
      // distinct value → fail closed), its value serialized through the allowlist —
      // a scalar keeps its type, a nested object is field-by-field, an exotic throws.
      const key = `a:${k.normalize('NFC')}`;
      if (seenKeys.has(key)) reject('NFC-duplicate embed field keys');
      seenKeys.add(key);
      identity[key] = this.canonicalizeLeaf(v);
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
        if (!attrs) return null;
        // Reconstruct through `marksOf` so the mark NAME is compared in its NFC-normalized
        // form (a raw `type in attrs` shortcut would miss a normalizing-equal name).
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
      const attrs: Record<string, string> = Object.create(null);
      const seenKeys = new Set<string>();
      // An ancestor attribute value (y-prosemirror stores a node's `attrs` here) can be
      // a nested OBJECT — `setAttribute('meta', { v: 2 })` — serialized through the ONE
      // canonicalizer (a nested object field-by-field, an exotic fails closed). Keys are
      // read through the SAFE adapter (never a `getAttributes()` plain object that drops
      // a `__proto__` key ⇒ invisible mutation) and NFC-deduped (two normalizing-equal
      // keys cannot last-wins-overwrite).
      for (const [k, v] of safeElementAttrs(parent)) {
        const key = k.normalize('NFC');
        if (seenKeys.has(key)) reject('NFC-duplicate ancestor attribute keys');
        seenKeys.add(key);
        attrs[key] = this.canonicalizeLeaf(v);
      }
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

    // ENFORCE `resolveRoot` ON RESOLUTION (#189 round-4 point 5). The resolved body
    // must ascend to the SAME content share the reader is configured to watch; an
    // anchor whose positions resolve into a different / planted share is DRIFT, not a
    // false `ok`. An absent configured root (`null`) also fails closed.
    const configuredRoot = this.rootOf(doc);
    if (!configuredRoot || !this.bodyUnderRoot(body, configuredRoot)) return null;

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
