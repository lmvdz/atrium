import { z } from 'zod';
import { Actor, Id, Timestamp } from './common.js';
import { normalizeForReceipt } from './matching.js';

/**
 * THE COVENANT ANCHOR — the record a human `✓` binds to on the object/span axis,
 * such that ANY drift from the exact certified *rendered* content makes it fail
 * to resolve. Phase 6, #180; governed by #163 (complete-form re-resolution) and
 * #164 (DETECT-only, fail-closed — there is NO hard span lock).
 *
 * ## Why this exists, and what it is NOT
 *
 * `epistemic.ts`'s one predicate (`epistemicStateOf`) answers "has a *human*
 * touched this object" — provenance, not content. That is the right question for
 * an object accepted through the reducer; it is the WRONG question once the
 * object is a span of a live multiplayer CRDT document that agent-peers can edit
 * underneath the human's `✓`. There, "a human touched it once" stays true while
 * the content it vouched for drifts. The covenant anchor is the content half:
 * `✓` vouches for the EXACT certified rendered content, and auto-stales the
 * moment that content moves (map #162).
 *
 * ## Extends a PROVEN pattern, on a new axis
 *
 * Session certify already content-anchors: `certify_armed_artifact_digest =
 * md5(artifact::text)` binds a session `✓` to the artifact it signed
 * (apps/web/lib/certify-session.ts; migration 0034). This brings the identical
 * discipline — "a `✓` is a signature OF a specific rendered thing, frozen at the
 * moment of signing, and any change underneath the signature is refused/detected"
 * — to the OBJECT/SPAN axis and makes it Yjs-span-shaped.
 *
 * ## The round-2 finding this answers
 *
 * A bare `state_vector` was ruled a WELL-FORMED LIE: relative positions and a
 * state vector preserve CRDT *structure*, not rendered *meaning*, so an anchor
 * that resolves against them alone can report OK over content that reads
 * differently to a human (Electric read + AgentRoom §2.2 corroborate). The
 * COMPLETE form (#163) therefore carries, and re-checks, all of:
 *
 *   - `revision`        — the logical revision the `✓` was bound to.
 *   - `stateVector`     — resolution context: resolve the anchored positions
 *                         against the doc AS OF that revision, and detect GC /
 *                         a foreign document (opaque bytes; caller-encoded).
 *   - `deleteSet`       — resolution context: what was deleted as of the snapshot
 *                         (opaque bytes; caller-encoded).
 *   - `enclosedItems`   — the IDENTITY of every item inside the span, so deleting
 *                         one is detectable as an identity change, not only as a
 *                         content change.
 *   - `renderedDigest`  — the canonical RENDERED content (ancestor formatting +
 *                         inline marks incl. straddling ones + transitive embed /
 *                         overlay identity), hashed. This is the meaning check the
 *                         bare state vector could not make.
 *
 * ## Purity
 *
 * This module lives in `@atrium/core` and obeys its zero-I/O boundary: it imports
 * only `zod` and its own siblings, reads no clock, rolls no dice, and — crucially
 * — does NOT import `yjs`. The document is reached only through the
 * {@link CovenantDocReader} port; the Yjs binding of that port ships in the app
 * layer (#181/#183, where the live doc exists), exactly as `ports.ts` ships its
 * adapters in `apps/server`. Everything meaning-bearing — canonical rendering,
 * the digest, and the OK/DRIFT comparison — is owned HERE, under the core gate,
 * so a reader cannot quietly weaken it.
 */

// ─────────────────────────────────────────────────────────────────────────────
// A pure SHA-256. `crypto.*` is forbidden in this package (ids and hashes are
// the caller's to supply elsewhere, but the RENDERED digest is meaning this
// module owns), so the digest is computed here, deterministically, with no
// global and no I/O. Validated against the FIPS-180-4 vectors in the test.
// ─────────────────────────────────────────────────────────────────────────────

// `Uint32Array` (not a plain array) so indexed reads are typed `number`, not
// `number | undefined`, under `noUncheckedIndexedAccess`.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** UTF-8 encode a string to bytes, without `TextEncoder` (no ambient globals). */
function utf8Bytes(input: string): number[] {
  const out: number[] = [];
  for (const ch of input) {
    let cp = ch.codePointAt(0) as number;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return out;
}

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** SHA-256 of a UTF-8 string, lower-case hex. Pure, deterministic, no I/O. */
export function sha256Hex(input: string): string {
  const bytes = utf8Bytes(input);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  // 64-bit big-endian length. Inputs here are far under 2^32 bytes, so the high
  // word is always zero; write it explicitly rather than assume it.
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  bytes.push(
    (hi >>> 24) & 0xff,
    (hi >>> 16) & 0xff,
    (hi >>> 8) & 0xff,
    hi & 0xff,
    (lo >>> 24) & 0xff,
    (lo >>> 16) & 0xff,
    (lo >>> 8) & 0xff,
    lo & 0xff,
  );

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const msg = Uint8Array.from(bytes);
  const w = new Uint32Array(64);
  for (let i = 0; i < msg.length; i += 64) {
    for (let t = 0; t < 16; t++) {
      const j = i + t * 4;
      w[t] = ((msg[j]! << 24) | (msg[j + 1]! << 16) | (msg[j + 2]! << 8) | msg[j + 3]!) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const w15 = w[t - 15]!;
      const w2 = w[t - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const chn = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + chn + K[t]! + w[t]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4) + hex(h5) + hex(h6) + hex(h7);
}

// ─────────────────────────────────────────────────────────────────────────────
// The rendered model — a plain, deterministic representation of what a human
// SEES for the certified span. The Yjs adapter (the port) produces this from a
// live doc; this module never touches Yjs itself.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One inline mark (bold, italic, link, …) on a text run, with its attributes and
 * whether it STRADDLES the certified boundary — i.e. begins before the span, or
 * ends after it. Straddle is meaning: a bold that a certified word is the tail of
 * reads differently from a bold that starts at that word, so a mark that grows to
 * straddle (or shrinks to stop straddling) is drift even when the enclosed text
 * is byte-identical (acceptance test, class 3).
 */
export const Mark = z.object({
  type: z.string().min(1),
  attrs: z.record(z.string(), z.string()),
  /** `none` | `start` (opens before the span) | `end` (closes after) | `both`. */
  straddles: z.enum(['none', 'start', 'end', 'both']),
});
export type Mark = z.infer<typeof Mark>;

/** The formatting of one enclosing ancestor block (heading level, list, quote…). */
export const BlockFormat = z.object({
  type: z.string().min(1),
  attrs: z.record(z.string(), z.string()),
});
export type BlockFormat = z.infer<typeof BlockFormat>;

/**
 * One rendered node inside the span: a run of text with its marks, or an embed
 * carrying its INTERNAL identity — the mention's target, the image's URL, the
 * nested doc's digest. The embed identity is why a mention re-pointed at another
 * user, or an image whose `src` was swapped, is drift though the span's visible
 * structure is unchanged (acceptance test, class 4).
 */
export const RenderedNode = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    text: z.string(),
    marks: z.array(Mark),
  }),
  z.object({
    kind: z.literal('embed'),
    embedType: z.string().min(1),
    /** e.g. `{ target: 'u_alice' }`, `{ src: 'https://…' }`, `{ docDigest: '…' }`. */
    identity: z.record(z.string(), z.string()),
  }),
]);
export type RenderedNode = z.infer<typeof RenderedNode>;

/**
 * The rendered fragment: the ancestor formatting context enclosing the span, and
 * the ordered content within it. This is the whole of what a `✓` vouches for; its
 * canonical digest is the meaning check.
 */
export const RenderedFragment = z.object({
  ancestors: z.array(BlockFormat),
  nodes: z.array(RenderedNode),
});
export type RenderedFragment = z.infer<typeof RenderedFragment>;

/**
 * The identity of one enclosed item — its stable CRDT id and kind. The ORDERED
 * list of these is a distinct anchor field from the digest: it makes a deletion
 * detectable as an identity change even for a renderer that might have folded the
 * deleted node out of the digest input. Defence in depth for class 5.
 */
export const EnclosedItem = z.object({
  id: z.string().min(1),
  kind: z.enum(['text', 'embed']),
});
export type EnclosedItem = z.infer<typeof EnclosedItem>;

// ─────────────────────────────────────────────────────────────────────────────
// Canonical serialization + the digest of a rendered fragment.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic JSON: object keys sorted, arrays in order, no incidental
 * whitespace. Two fragments that render identically serialize to the identical
 * string on a server, in a worker, and in a browser — the same property the
 * reducer relies on. Everything reachable here is a string, an array, or a plain
 * object with string keys.
 *
 * `undefined` is serialized explicitly (`"undefined"`, a token no valid value
 * produces) rather than throwing: a malformed fragment must still yield a total,
 * DIFFERENT string, so it fails the digest comparison as DRIFT instead of
 * throwing out of {@link resolveCovenant}. Defence for class D (fail-closed).
 */
function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '"\\u0000undefined"';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object') return JSON.stringify(String(value));
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

/**
 * DETERMINISTIC CANONICALIZATION (class E). Yjs presents the SAME logical content
 * in more than one shape — a run split into two ops after an insert, a string in
 * NFC vs NFD form, marks in whatever order the map iterated — and a naive digest
 * of the raw fragment false-stales on every one of them. Normalize so that same
 * logical content ⇒ same digest, and only a REAL rendered change moves it:
 *
 *   1. **NFC-normalize + prose-fold every string** — text, mark/ancestor attribute
 *      values and keys, embed identity. `normalizeForReceipt` is core's existing
 *      prose fold (Unicode-invisible drop, whitespace-run collapse, apostrophe +
 *      link canonicalization) and is the same fold the receipt path trusts; NFC
 *      first so composed and decomposed accents agree. This is the prose-v1
 *      normalization of #163 (a reflow must not false-stale).
 *   2. **Sort each text run's `marks[]`** — mark order is not rendered meaning.
 *   3. **Coalesce adjacent text runs with identical marks**, and drop empty runs —
 *      Yjs op-splitting is not rendered meaning.
 *
 * Embeds are boundaries: two text runs on either side of an embed do NOT coalesce.
 */
function normalizeString(s: string): string {
  return normalizeForReceipt(s.normalize('NFC'));
}

function normalizeAttrs(attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(attrs)) out[normalizeString(k)] = normalizeString(attrs[k] ?? '');
  return out;
}

function normalizeMark(mark: Mark): Mark {
  return { type: normalizeString(mark.type), attrs: normalizeAttrs(mark.attrs), straddles: mark.straddles };
}

/** A stable, total ordering key for a mark — its own canonical form. */
function markKey(mark: Mark): string {
  return canonical(normalizeMark(mark));
}

/** Sort a mark set into its canonical order (mark order is not rendered meaning). */
function sortedMarks(marks: readonly Mark[]): Mark[] {
  return marks.map(normalizeMark).sort((a, b) => (markKey(a) < markKey(b) ? -1 : markKey(a) > markKey(b) ? 1 : 0));
}

/** True when two already-sorted normalized mark sets are identical. */
function sameMarks(a: readonly Mark[], b: readonly Mark[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (markKey(a[i] as Mark) !== markKey(b[i] as Mark)) return false;
  }
  return true;
}

/**
 * Normalize a fragment to its canonical form (class E) before digesting.
 *
 * Text is coalesced on RAW text before the prose fold, then folded ONCE per run:
 * `normalizeForReceipt` trims and collapses whitespace, so folding each Yjs op
 * separately and concatenating would drop the boundary spaces a single fold
 * keeps — the coalesce must precede the fold, or `'ship '·'it'` and `'ship it'`
 * digest differently (they must not).
 */
export function normalizeFragment(fragment: RenderedFragment): RenderedFragment {
  const ancestors: BlockFormat[] = fragment.ancestors.map((a) => ({
    type: normalizeString(a.type),
    attrs: normalizeAttrs(a.attrs),
  }));

  // Pass 1: normalize marks / embeds, keep text RAW; coalesce adjacent same-mark
  // runs by concatenating their raw text.
  type RawText = { kind: 'text'; rawText: string; marks: Mark[] };
  const staged: (RawText | Extract<RenderedNode, { kind: 'embed' }>)[] = [];
  for (const node of fragment.nodes) {
    if (node.kind === 'text') {
      const marks = sortedMarks(node.marks);
      const prev = staged[staged.length - 1];
      if (prev && prev.kind === 'text' && sameMarks(prev.marks, marks)) {
        prev.rawText += node.text;
      } else {
        staged.push({ kind: 'text', rawText: node.text, marks });
      }
    } else {
      staged.push({ kind: 'embed', embedType: normalizeString(node.embedType), identity: normalizeAttrs(node.identity) });
    }
  }

  // Pass 2: fold each coalesced run once; drop a run that renders nothing.
  const nodes: RenderedNode[] = [];
  for (const node of staged) {
    if (node.kind === 'text') {
      const text = normalizeString(node.rawText);
      if (text === '') continue;
      nodes.push({ kind: 'text', text, marks: node.marks });
    } else {
      nodes.push(node);
    }
  }
  return { ancestors, nodes };
}

/** The canonical rendered string a digest is taken of. Exported for tests/debug. */
export function canonicalRendered(fragment: RenderedFragment): string {
  return canonical(normalizeFragment(fragment));
}

/**
 * The digest a `✓` binds to: SHA-256 of the canonical rendered fragment. Includes
 * ancestor formatting, every inline mark (with its straddle), and every embed's
 * internal identity — so any of the drift classes moves it — and is stable for a
 * byte-identical re-render.
 *
 * The input is `RenderedFragment.parse`d first (class D): a reader that hands back
 * a malformed shape is rejected HERE, so the throw is contained by
 * {@link resolveCovenant}'s guard and becomes DRIFT, never an unhandled exception.
 */
export function renderedDigestOf(fragment: RenderedFragment): string {
  const parsed = RenderedFragment.parse(fragment);
  return sha256Hex(canonicalRendered(parsed));
}

// ─────────────────────────────────────────────────────────────────────────────
// The anchor record + the reader port.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE COVENANT ANCHOR, complete form (#163). A gated Postgres ledger row (persisted
 * by migration 0050), never a CRDT field: the `✓` is authority, and authority
 * lives on the ledger the room reads read-only, not inside the substrate agents
 * can write.
 */
export const CovenantAnchor = z.object({
  /** The object/span this `✓` is over. */
  objectId: Id,
  roomId: Id,
  /** The logical revision the `✓` was bound to. */
  revision: z.number().int().nonnegative(),
  /**
   * Opaque, caller-encoded Yjs RELATIVE POSITION of the span's start / end. These
   * are PERSISTED on the anchor (migration 0051), not held on a reader instance —
   * so `resolveCovenant` locates the span from the ledger after a reload, and a
   * sibling inserted at the same index cannot redirect the anchor to it (class B).
   */
  relStart: z.string().min(1),
  relEnd: z.string().min(1),
  /** Opaque, caller-encoded Yjs state vector — resolution context (see class 6). */
  stateVector: z.string().min(1),
  /** Opaque, caller-encoded Yjs delete set — resolution context. */
  deleteSet: z.string().min(1),
  /** The identity of every item inside the span, in document order. */
  enclosedItems: z.array(EnclosedItem),
  /** SHA-256 of the canonical rendered fragment at certify time. */
  renderedDigest: z.string().regex(/^[0-9a-f]{64}$/, 'a rendered digest is 64 lower-case hex chars'),
  /** Who certified. Only a human may (enforced upstream); recorded for the receipt. */
  certifier: Actor,
  certifiedAt: Timestamp,
});
export type CovenantAnchor = z.infer<typeof CovenantAnchor>;

/** What a reader returns when it re-resolves an anchor against the live document. */
export interface ResolvedSpan {
  fragment: RenderedFragment;
  enclosedItems: EnclosedItem[];
  /**
   * The reader's INDEPENDENT verdict (class C) on whether the anchor's captured
   * resolution context — `revision`, `stateVector`, `deleteSet` — is consistent
   * with the live document: the captured state must be a sub-state of the live
   * one (the certifier saw a prefix of what exists now) and the revision must not
   * post-date it. A forged or foreign context is `false`, and
   * {@link resolveCovenant} turns that into DRIFT regardless of the digest. The
   * captured context is thus VERIFIED, never trusted (the "well-formed lie").
   */
  snapshotVerified: boolean;
}

/** What a reader returns when it captures a fresh anchor from a live selection. */
export interface CapturedSelection {
  revision: number;
  relStart: string;
  relEnd: string;
  stateVector: string;
  deleteSet: string;
  fragment: RenderedFragment;
  enclosedItems: EnclosedItem[];
}

/**
 * The seam to the live document — a type-only PORT, like everything in `ports.ts`.
 * Its Yjs binding ships in the app layer (#181/#183); this package never imports
 * Yjs. The reader owns exactly the CRDT-specific work — resolving relative
 * positions against a historical revision, reading formatting, detecting GC — and
 * NOTHING meaning-bearing: the digest and the OK/DRIFT verdict are computed here.
 *
 * `resolveSpan` MUST return `null` — never throw, never a best-effort fragment —
 * when the span cannot be faithfully resolved: the doc is unavailable, the
 * anchored items were deleted and garbage-collected, the state vector names a
 * document this is not, or the positions no longer resolve. `null` is the
 * fail-closed signal, and {@link resolveCovenant} turns it into DRIFT.
 */
export interface CovenantDocReader {
  /** Capture a fresh anchor's raw materials from the currently-selected span. */
  captureSelection(): CapturedSelection | null;
  /** Re-resolve an existing anchor against the live document. `null` ⇒ fail-closed. */
  resolveSpan(anchor: CovenantAnchor): ResolvedSpan | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Certify capture + the resolve primitive.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CERTIFY CAPTURE — build the complete anchor for a freshly-certified span. The
 * digest is computed HERE from the reader's rendered materials, so a reader
 * cannot supply a digest that does not match what it rendered (the round-2
 * "caller-supplied value is a well-formed lie" class, closed by construction).
 *
 * Returns `null` when the selection cannot be captured — there is no anchor to
 * persist for a span that does not resolve even at certify time, and a `✓` is
 * never recorded over one.
 */
export function certifyAnchor(
  doc: CovenantDocReader,
  meta: { objectId: string; roomId: string; certifier: Actor; certifiedAt: Timestamp },
): CovenantAnchor | null {
  const captured = doc.captureSelection();
  if (captured === null) return null;
  return CovenantAnchor.parse({
    objectId: meta.objectId,
    roomId: meta.roomId,
    revision: captured.revision,
    relStart: captured.relStart,
    relEnd: captured.relEnd,
    stateVector: captured.stateVector,
    deleteSet: captured.deleteSet,
    enclosedItems: captured.enclosedItems,
    renderedDigest: renderedDigestOf(captured.fragment),
    certifier: meta.certifier,
    certifiedAt: meta.certifiedAt,
  });
}

/** The covenant's live status for a span: the exact content holds, or it drifted. */
export type CovenantStatus = 'ok' | 'drift';

/** What {@link resolveCovenant} returns — the shape #181's read authority consumes. */
export interface CovenantResolution {
  /** The revision the `✓` was bound to (carried through from the anchor). */
  revision: number;
  /** The live re-rendered fragment, or `null` when it could not be resolved. */
  renderedFragment: RenderedFragment | null;
  /** `ok` only for a byte-identical re-render; `drift` for every other outcome. */
  covenantStatus: CovenantStatus;
}

function sameEnclosedItems(a: readonly EnclosedItem[], b: readonly EnclosedItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return false;
    if (x.id !== y.id || x.kind !== y.kind) return false;
  }
  return true;
}

/**
 * THE PRIMITIVE #181's readers call. Resolve the `✓`'s anchor against the live
 * document and answer OK / DRIFT, fail-closed.
 *
 * DETECT-only, fail-CLOSED (#164): the ONLY way to `ok` is a span that resolves
 * AND whose captured resolution context the reader independently VERIFIED against
 * the live doc (class C) AND whose enclosed-item identity is unchanged AND whose
 * canonical rendered digest is byte-identical to the one certified. Every other
 * path — an unresolvable / GC'd / unavailable doc (`resolveSpan` ⇒ `null`), an
 * unverified / forged context, a changed identity set, or a moved digest — is
 * DRIFT. There is no OK-by-default and no OK-on-error anywhere in this function.
 *
 * FAIL-CLOSED ON THROW (class D): the whole body runs under a guard. A reader that
 * throws — a `_item.id` deref on a root type, a malformed shape that fails
 * `RenderedFragment.parse`, a decode error on a forged position/vector — yields
 * DRIFT, never a propagated exception and never OK. An exception is exactly the
 * "I could not faithfully resolve" case, which is drift by the covenant.
 */
export function resolveCovenant(doc: CovenantDocReader, anchor: CovenantAnchor): CovenantResolution {
  try {
    const parsedAnchor = CovenantAnchor.parse(anchor);
    const resolved = doc.resolveSpan(parsedAnchor);
    // Fail-closed: unavailable / GC'd / unresolvable ⇒ DRIFT, never OK (class 6).
    if (resolved === null) {
      return { revision: parsedAnchor.revision, renderedFragment: null, covenantStatus: 'drift' };
    }
    // The captured resolution context is VERIFIED, not trusted (class C): a forged
    // / foreign revision, state vector, or delete set the reader could not confirm
    // against the live doc is DRIFT before the digest is even consulted.
    if (resolved.snapshotVerified !== true) {
      return { revision: parsedAnchor.revision, renderedFragment: resolved.fragment, covenantStatus: 'drift' };
    }
    // A changed identity set (e.g. a deleted enclosed item) is drift on its own
    // axis (class 5), checked before and independently of the digest.
    if (!sameEnclosedItems(resolved.enclosedItems, parsedAnchor.enclosedItems)) {
      return { revision: parsedAnchor.revision, renderedFragment: resolved.fragment, covenantStatus: 'drift' };
    }
    // The meaning check: byte-identical rendered content ⇒ OK, anything else ⇒ DRIFT
    // (classes 1–4, and 7's OK). `renderedDigestOf` parses its input, so a
    // malformed fragment throws HERE and is caught below as DRIFT.
    const digest = renderedDigestOf(resolved.fragment);
    return {
      revision: parsedAnchor.revision,
      renderedFragment: resolved.fragment,
      covenantStatus: digest === parsedAnchor.renderedDigest ? 'ok' : 'drift',
    };
  } catch {
    // Any throw is "could not faithfully resolve" ⇒ fail-closed to DRIFT. The
    // revision is read defensively; a malformed anchor still yields a resolution.
    const revision = typeof (anchor as { revision?: unknown })?.revision === 'number'
      ? (anchor as { revision: number }).revision
      : 0;
    return { revision, renderedFragment: null, covenantStatus: 'drift' };
  }
}
