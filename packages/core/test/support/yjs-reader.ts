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
// ALLOWLIST-THE-COMPLIANT-FORM leaf serialization (#189 round-3). Kept BYTE-FOR-BYTE
// in step with the production reader's `canonicalizeLeafValue`
// (`apps/web/lib/covenant-reader.ts`): the shared conformance harness runs its
// injective-encoding collision cases (typed-array-vs-object, sparse-vs-empty,
// NFC-duplicate-keys, embedType-impersonation, dropped-`type`) against BOTH readers,
// so BOTH must injectively encode a CLOSED allowlist and FAIL CLOSED (throw ⇒ DRIFT)
// on everything else. See that file for the full rationale.
// ─────────────────────────────────────────────────────────────────────────────

function reject(what: string): never {
  throw new Error(`covenant reader: non-compliant value shape (${what}) — failing closed to DRIFT`);
}

function canonicalizeLeafValue(value: unknown): string {
  if (value === null) return 'z:null';
  if (value === undefined) return 'z:undefined';
  const t = typeof value;
  if (t === 'string') return `s:${JSON.stringify((value as string).normalize('NFC'))}`;
  if (t === 'boolean') return `b:${value ? 'true' : 'false'}`;
  if (t === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) reject(`non-finite number ${String(n)}`);
    if (Object.is(n, -0)) return 'n:-0';
    return `n:${JSON.stringify(n)}`;
  }
  if (t === 'bigint') return `i:${(value as bigint).toString()}`;
  if (t !== 'object') reject(`type ${t}`);

  if (Array.isArray(value)) {
    const len = value.length;
    const parts: string[] = [];
    for (let i = 0; i < len; i++) {
      if (!(i in value)) reject('sparse array (hole)');
      parts.push(canonicalizeLeafValue(value[i]));
    }
    return `a:${len}:[${parts.join(',')}]`;
  }

  const proto = Object.getPrototypeOf(value as object);
  if (proto !== Object.prototype && proto !== null) reject('non-plain prototype');
  if (Object.getOwnPropertySymbols(value as object).length > 0) reject('symbol-keyed object');

  const obj = value as Record<string, unknown>;
  const seen = new Set<string>();
  const entries: Array<readonly [string, unknown]> = [];
  for (const rawKey of Object.keys(obj)) {
    const key = rawKey.normalize('NFC');
    if (seen.has(key)) reject('NFC-duplicate object keys');
    seen.add(key);
    entries.push([key, obj[rawKey]] as const);
  }
  entries.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  return `o:{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalizeLeafValue(v)}`)
    .join(',')}}`;
}

/**
 * SAFELY read a Y.XmlElement's attributes (kept in step with the production reader's
 * `safeElementAttrs`). `getAttributes()` materializes a plain object with `obj[key]=v`,
 * so a `__proto__` (or other prototype-setter) key is SILENTLY DROPPED — an invisible
 * mutation. We enumerate the element's own `_map` (a real `Map`, hazard-free), read
 * each via `getAttribute`, and fail closed (throw ⇒ DRIFT) if the materialized record
 * is missing any live key the map carries.
 */
interface AttrMapItem {
  deleted?: boolean;
}

/**
 * THE ONE GUARDED-ATTR ADAPTER (#189 round-5, kept BYTE-FOR-BYTE with the production
 * reader). A plain-object materialization (`obj[key]=value`) silently DROPS a
 * prototype-setter key (`__proto__`), so any digest over it is a lie. Every attribute
 * surface — ancestor attrs, body attrs, mark names/values — routes through this single
 * choke point, which rebuilds the materialization and FAILS CLOSED (throw ⇒ DRIFT) if it
 * drops any live key. An honest surface passes through unchanged.
 */
function guardedAttrEntries(rawEntries: Array<[string, unknown]>): Array<[string, unknown]> {
  const materialized: Record<string, unknown> = {};
  for (const [key, value] of rawEntries) materialized[key] = value;
  for (const [key] of rawEntries) {
    if (!Object.hasOwn(materialized, key)) {
      reject(`attribute key dropped by materialization (${JSON.stringify(key)})`);
    }
  }
  return rawEntries;
}

/**
 * SAFELY read a type's OWN node attributes — an ancestor `Y.XmlElement` OR the content
 * `Y.XmlText` body (surface 6). Enumerate the type's own `_map` (hazard-free), read each
 * via `getAttribute`, and route through the ONE {@link guardedAttrEntries} adapter so a
 * `__proto__` key `getAttributes()` would drop fails closed.
 */
function safeElementAttrs(el: Y.XmlElement | Y.XmlText): Array<[string, unknown]> {
  const map = (el as unknown as { _map?: Map<string, AttrMapItem> })._map;
  if (!(map instanceof Map)) {
    reject('element has no attribute map (foreign shape)');
  }
  const raw: Array<[string, unknown]> = [];
  for (const [key, item] of map.entries()) {
    if (item?.deleted) continue;
    raw.push([key, el.getAttribute(key)]);
  }
  return guardedAttrEntries(raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// DIRECT-ITEM DELTA WALK (#189 round-5, the F2 closer — kept BYTE-FOR-BYTE with the
// production reader). `toDelta()` materializes each op's marks into a plain object,
// dropping a `__proto__` mark. We render from the Yjs items DIRECTLY, mirroring toDelta's
// segmentation but carrying active marks as a real Map (hazard-free): ContentFormat is
// zero-width (updates active attrs), ContentString accumulates, ContentEmbed/ContentType
// is a one-column embed op, deleted items are skipped. Character offsets match toDelta's.
// ─────────────────────────────────────────────────────────────────────────────

type DirectOp =
  | { kind: 'text'; text: string; attrs: Array<[string, unknown]> }
  | { kind: 'embed'; embed: unknown; attrs: Array<[string, unknown]> };

interface YContentItem {
  content: {
    constructor: { name: string };
    str?: string;
    key?: string;
    value?: unknown;
    getContent?: () => unknown[];
  };
  deleted: boolean;
  right: unknown;
}

function directDelta(body: Y.XmlText): DirectOp[] {
  const ops: DirectOp[] = [];
  const active = new Map<string, unknown>();
  let str = '';
  const packStr = () => {
    if (str.length > 0) {
      ops.push({ kind: 'text', text: str, attrs: [...active.entries()] });
      str = '';
    }
  };
  let item: unknown = (body as unknown as { _start: unknown })._start;
  while (item) {
    const it = item as YContentItem;
    if (!it.deleted) {
      const name = it.content.constructor.name;
      if (name === 'ContentString') {
        str += it.content.str ?? '';
      } else if (name === 'ContentEmbed' || name === 'ContentType') {
        packStr();
        const embed = it.content.getContent ? it.content.getContent()[0] : undefined;
        ops.push({ kind: 'embed', embed, attrs: [...active.entries()] });
      } else if (name === 'ContentFormat') {
        packStr();
        const key = it.content.key as string;
        const value = it.content.value;
        if (value === null) active.delete(key);
        else active.set(key, value);
      } else {
        reject(`unrecognized Yjs content in body (${name})`);
      }
    }
    item = it.right;
  }
  packStr();
  return ops;
}

/**
 * The marks a text op carries, INJECTIVELY (allowlist-encoded; exotic ⇒ fail closed).
 * Mark NAMES are NFC-unique-enforced (a key surface like object keys) and the WHOLE
 * payload routes through the ONE `canonicalizeLeafValue`, whose type tag alone
 * discriminates scalar/object/flag — a single `#v` slot, no per-shape fork.
 */
function marksOf(attrEntries: Array<[string, unknown]> | undefined): Mark[] {
  if (!attrEntries || attrEntries.length === 0) return [];
  // GUARDED enumeration (#189 round-5): mark names/values are read DIRECTLY from the Yjs
  // items' active-attribute Map (see `directDelta`), so a `__proto__` mark reaches here
  // and — routed through the ONE guarded adapter, the SAME guard ancestor/body attrs use
  // — FAILS CLOSED, never an invisible INNOCENT↔EVIL flip (the round-4 tie-break's F2).
  const guarded = guardedAttrEntries(attrEntries);
  const seenNames = new Set<string>();
  const marks: Mark[] = [];
  for (const [rawName, value] of guarded) {
    const type = rawName.normalize('NFC');
    if (seenNames.has(type)) reject('NFC-duplicate mark names');
    seenNames.add(type);
    marks.push({
      type,
      attrs: { '#v': canonicalizeLeafValue(value) },
      straddles: 'none',
    });
  }
  marks.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  return marks;
}

/** The identity of an embed — the root value + allowlist-encoded fields + child digest. */
function embedIdentity(embed: unknown): {
  embedType: string;
  identity: Record<string, string>;
} {
  const identity: Record<string, string> = Object.create(null);

  // EMBED-ROOT VALUE (#189 round-5 point 3, the F1 closer — byte-for-byte with the
  // production reader). The WHOLE embed root through the ONE canonicalizer, so the root's
  // TYPE discriminates: `{}` (`o:{}`) ≠ `[]` (`a:0:[]`) ≠ `42` (`n:42`) ≠ `{a:1}`. Round-4
  // only walked a keyed object, folding every non-object / array / empty-object root onto
  // one digest (the tie-break's `insertEmbed {} ≡ [] ≡ 42`). `#root` is reader-owned.
  identity['#root'] = canonicalizeLeafValue(embed);

  if (embed === null || typeof embed !== 'object') {
    return { embedType: 'none', identity };
  }
  const embedObj = embed as Record<string, unknown>;

  // EXPLICIT TYPE-SOURCE + PRESENCE — NO `?? default` folding (kept in step with the
  // production reader). The channel encodes which field supplied the type (`embedType`
  // vs `type` vs neither) AND its exact value, so `{k}` (absent), `{type:'embed',k}`,
  // and `{type:null,k}` are three DISTINCT channels; a string can't impersonate a
  // non-string; mutating the channel field in place moves the channel.
  const hasEmbedType = Object.hasOwn(embedObj, 'embedType');
  const hasType = Object.hasOwn(embedObj, 'type');
  let embedType: string;
  let channelField: 'embedType' | 'type' | null;
  if (hasEmbedType) {
    embedType = `embedType:${canonicalizeLeafValue(embedObj.embedType)}`;
    channelField = 'embedType';
  } else if (hasType) {
    embedType = `type:${canonicalizeLeafValue(embedObj.type)}`;
    channelField = 'type';
  } else {
    embedType = 'none';
    channelField = null;
  }

  const seenKeys = new Set<string>();
  for (const [k, v] of Object.entries(embedObj)) {
    if (channelField !== null && k === channelField) continue;
    if (k === 'child' || k === 'children') {
      // Reader-OWNED reserved key computed from the CHILD (never a sibling field).
      identity[k === 'children' ? '#children' : '#child'] = sha256Hex(canonicalizeLeafValue(v));
      continue;
    }
    const key = `a:${k.normalize('NFC')}`;
    if (seenKeys.has(key)) reject('NFC-duplicate embed field keys');
    seenKeys.add(key);
    identity[key] = canonicalizeLeafValue(v);
  }
  return { embedType, identity };
}

/**
 * The mark-type→attrs active at absolute char `offset`, or null (for straddle
 * detection). Reads `op.attributes` regardless of whether the op is text OR an
 * EMBED: a Yjs `format()` stamps attributes onto an embed op too (verified —
 * `{insert:{…embed…},attributes:{bold:true}}`), so a mark that runs CONTINUOUSLY
 * across an embed at the span boundary is seen as active there. The round-2 hole
 * was this function returning `null` for every embed, which made a mark straddling
 * an embed boundary read as `straddles:'none'` — a byte-identical lie when the
 * mark was later retargeted to stop crossing the boundary.
 */
function markActiveAt(
  delta: DirectOp[],
  offset: number,
  type: string,
): Record<string, string> | null {
  let pos = 0;
  for (const op of delta) {
    const len = op.kind === 'text' ? op.text.length : 1;
    if (offset >= pos && offset < pos + len) {
      // Reconstruct through `marksOf` so the mark NAME is compared NFC-normalized.
      const m = marksOf(op.attrs).find((x) => x.type === type);
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
      const attrs: Record<string, string> = Object.create(null);
      const seenKeys = new Set<string>();
      // Allowlist-encode each ancestor attribute value (a nested object goes
      // field-by-field, an exotic fails closed) and NFC-dedup the keys, reading through
      // the SAFE adapter (never a `getAttributes()` plain object that drops `__proto__`),
      // exactly as the production reader does — never `String(obj)`.
      for (const [k, v] of safeElementAttrs(parent)) {
        const key = k.normalize('NFC');
        if (seenKeys.has(key)) reject('NFC-duplicate ancestor attribute keys');
        seenKeys.add(key);
        attrs[key] = canonicalizeLeafValue(v);
      }
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
    // Render from the Yjs items DIRECTLY (#189 round-5), not the lossy `toDelta` — so a
    // `__proto__` mark reaches the digest and fails closed. Offsets match toDelta's.
    const delta = directDelta(body);
    const nodes: RenderedNode[] = [];
    // Track the first / last IN-SPAN node (text OR embed) so straddle is stamped on
    // whatever sits adjacent to each span boundary — even when the boundary itself
    // is an EMBED, and even for an embed-ONLY span with no in-span text run at all.
    let firstNode = -1;
    let lastNode = -1;
    let pos = 0;
    for (const op of delta) {
      if (op.kind === 'text') {
        const opStart = pos;
        const opEnd = pos + op.text.length;
        const from = Math.max(start, opStart);
        const to = Math.min(end, opEnd);
        if (to > from) {
          const text = op.text.slice(from - opStart, to - opStart);
          const marks = marksOf(op.attrs); // straddle stamped in the post-pass
          if (firstNode === -1) firstNode = nodes.length;
          lastNode = nodes.length;
          nodes.push({ kind: 'text', text, marks });
        }
        pos = opEnd;
      } else {
        // An embed occupies exactly one character. It carries BOTH its internal
        // identity (embedIdentity) AND its own inline marks (op.attrs: a
        // link/highlight/bold stamped onto the embed) — the round-3 PRIMARY gap
        // was rendering only the identity, so a mark on a certified embed had
        // nowhere to land and stayed a false `✓`.
        if (pos >= start && pos < end) {
          const { embedType, identity } = embedIdentity(op.embed);
          const marks = marksOf(op.attrs); // straddle stamped in the post-pass
          if (firstNode === -1) firstNode = nodes.length;
          lastNode = nodes.length;
          nodes.push({ kind: 'embed', embedType, identity, marks });
        }
        pos += 1;
      }
    }

    // STRADDLE post-pass. A mark straddles the START boundary iff the SAME mark
    // (type + attrs) is active CONTINUOUSLY across it — active at both `start-1`
    // (just outside) and `start` (just inside) — and likewise across the END
    // boundary at `end-1` / `end`. Because `markActiveAt` now sees embed ops, this
    // holds when an embed sits on the boundary. Applied ONLY to the first / last
    // in-span text runs, so an interior run cannot spuriously read as straddling.
    const straddlesAcross = (m: Mark, before: number, after: number): boolean =>
      sameAttrs(m.attrs, markActiveAt(delta, before, m.type)) &&
      sameAttrs(m.attrs, markActiveAt(delta, after, m.type));
    // Stamp straddle on the boundary-adjacent node — text OR embed (both carry
    // `marks` now), so a mark that straddles an embed on the boundary, or an
    // embed-only span, is detected instead of reading a byte-identical `none`.
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
      fragment: { ancestors: this.ancestorsOf(body), nodes, bodyAttrs: this.bodyAttrsOf(body) },
      enclosedItems: this.enclosedItemsOf(body, start, end),
    };
  }

  /**
   * The BODY's OWN node attributes (#189 round-5 point 6, the F3 closer — byte-for-byte
   * with the production reader). A y-prosemirror text block stores per-node attrs on the
   * `Y.XmlText` body itself, and they never surface in `toDelta()`. Read them through the
   * SAME guarded `safeElementAttrs` adapter (so a `__proto__` body attr fails closed),
   * each value through the ONE canonicalizer. `undefined` when the body has no live attrs.
   */
  private bodyAttrsOf(body: Y.XmlText): Record<string, string> | undefined {
    const attrs: Record<string, string> = Object.create(null);
    const seenKeys = new Set<string>();
    let any = false;
    for (const [k, v] of safeElementAttrs(body)) {
      const key = k.normalize('NFC');
      if (seenKeys.has(key)) reject('NFC-duplicate body attribute keys');
      seenKeys.add(key);
      attrs[key] = canonicalizeLeafValue(v);
      any = true;
    }
    return any ? attrs : undefined;
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
   * The (client:clock) id of every non-deleted item OVERLAPPING [start,end) in the
   * body — text runs and embeds alike. These are exactly the items the certifier
   * must have SEEN to render the span, so the captured state vector must cover
   * every one of them (used to close the empty/weakened-SV lie below). Yjs-internal
   * `_start`/`right` walk, guarded so a foreign shape throws → DRIFT.
   */
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

  /**
   * The (client:clock,len) of every DELETED (tombstoned) item whose position falls
   * within the certified span `[start,end]`, BOUNDARIES INCLUDED. A deletion inside
   * or AT either edge of the span changed the span's content, so the certifier must
   * have recorded it in the captured delete set. Round-3: the old `offset > start &&
   * offset < end` EXCLUDED a boundary tombstone (`offset == start | end`), so an
   * anchor that dropped a boundary tombstone from its delete set slipped past
   * completeness → a false `✓`. Widened to `offset >= start && offset <= end`.
   *
   * A deletion OUTSIDE the span (another block, or elsewhere in this block) is
   * irrelevant to this `✓` and is deliberately NOT required — that span-scoping is
   * what keeps an anchor robust to edits elsewhere (no false-stale storm). Do NOT
   * widen this to a global delete-set check.
   */
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
        // A tombstone contributes no visible width; it sits AT the current offset.
        // Boundaries included: a deletion at offset == start or offset == end is
        // span content the certifier saw removed.
        if (offset >= start && offset <= end)
          out.push({ client: it.id.client, clock: it.id.clock, len: it.length });
      } else {
        offset += it.length;
      }
      item = it.right;
    }
    return out;
  }

  /**
   * The set of REAL per-client state-vector frontiers the live doc has passed
   * through for `client` — `{0} ∪ {clock+len}` over that client's contiguous
   * structs in the struct store. A Yjs state vector always records, per client, the
   * next-expected clock, which is exactly one of these boundaries; a value that is
   * NOT one of them (mid-struct, or past the client's last op) is a state the doc
   * never occupied and so cannot be a genuine certify-time frontier. Used to reject
   * a fabricated / redistributed SV that merely preserves the sum (round-3 SECONDARY).
   */
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

  /**
   * INDEPENDENTLY verify the captured snapshot against the live doc (class C), and
   * — round 3 — reject WEAKENED values, not merely forged ones. The captured
   * `revision`/`stateVector`/`deleteSet` must be the certify-time snapshot, so an
   * anchor whose snapshot fields were zeroed / emptied to slip past the earlier,
   * vacuous checks is `false`. Any decode failure is `false` (fail-closed).
   */
  private verifySnapshot(
    doc: Y.Doc,
    anchor: CovenantAnchor,
    body: Y.XmlText,
    start: number,
    end: number,
  ): boolean {
    try {
      // Revision cannot post-date the live doc.
      if (anchor.revision > this.liveRevision(doc)) return false;

      // The state vector and the revision are bound: the recorded revision IS the
      // sum of the certify-time state vector, so a forged revision or a forged /
      // empty state vector (which would otherwise pass the prefix check vacuously)
      // no longer agree.
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

      // Toward certify-time EQUALITY, not merely same-sum-prefix (round-3 SECONDARY):
      // every per-client frontier must land on a REAL boundary the doc actually
      // passed through. A redistributed SV that preserves the sum but shifts a
      // client's clock to a value the doc never occupied (mid-struct, or off its
      // op count) is not a genuine certify-time frontier → DRIFT. A genuine SV is
      // always boundary-aligned, so this never false-stales an honest anchor.
      for (const [client, clock] of anchorSV.entries()) {
        if (!this.clientBoundaries(doc, client).has(clock)) return false;
      }

      // COVERAGE (closes the zeroed-revision / emptied-SV lie): every item the span
      // is rendered FROM must have existed as of the captured SV — its clock must
      // be strictly below the SV frontier for its client. An empty or under-counted
      // SV cannot cover the real span items, so `(revision:0, stateVector:<empty>)`
      // — internally consistent and a prefix of every doc — is now DRIFT. A genuine
      // certify always covers them, so this never false-stales.
      for (const { client, clock } of this.spanItemIds(body, start, end)) {
        if ((anchorSV.get(client) ?? 0) <= clock) return false;
      }

      // The delete set is an ACTUAL delete set the reader decodes (not a snapshot).
      const anchorDS = JSON.parse(
        new TextDecoder().decode(base64ToBytes(anchor.deleteSet)),
      ) as Record<string, [number, number][]>;
      const liveDS = Y.snapshot(doc).ds;

      // (i) Every deletion the certifier saw must still be deleted in the live doc
      // (deletions are permanent; a set naming ranges never deleted is a forgery).
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

      // (ii) COMPLETENESS (closes the non-empty→empty weakening) — SCOPED TO THE SPAN.
      // Every tombstone INSIDE the certified span that existed as of the captured SV
      // (clock < frontier) must ALSO appear in the captured DS. A deletion inside the
      // span is content the certifier saw removed; stripping its DS entry (the
      // non-empty→empty weakening) now fails here → DRIFT. Deletions created AFTER
      // certify (clock ≥ frontier — e.g. a type-then-revert) and deletions OUTSIDE
      // the span (other blocks / elsewhere in this block) are excluded, so ordinary
      // editing never false-stales.
      for (const { client, clock, len } of this.spanDeletedItems(body, start, end)) {
        const frontier = anchorSV.get(client) ?? 0;
        if (clock >= frontier) continue; // created after certify ⇒ not the certifier's deletion
        const anchorRanges = anchorDS[String(client)] ?? [];
        const covered = anchorRanges.some(([c, l]) => c <= clock && clock + len <= c + l);
        if (!covered) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  // ── Port surface ──────────────────────────────────────────────────────────

  /**
   * The authoritative resolution context — revision / state vector / delete set
   * read DIRECTLY from the live doc HEAD. `captureSelection` and
   * `authoritativeContext` both derive it from here, so an honest same-instant
   * capture agrees on all three byte-for-byte, and `certifyAnchor` signs THIS.
   */
  private contextOf(doc: Y.Doc): { revision: number; stateVector: string; deleteSet: string } {
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

  authoritativeContext(): ReturnType<CovenantDocReader['authoritativeContext']> {
    const doc = this.doc;
    if (!doc) return null; // unavailable ⇒ no context to sign (fail-closed)
    return this.contextOf(doc);
  }

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
    return {
      ...this.contextOf(doc),
      relStart: bytesToBase64(Y.encodeRelativePosition(relStart)),
      relEnd: bytesToBase64(Y.encodeRelativePosition(relEnd)),
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
