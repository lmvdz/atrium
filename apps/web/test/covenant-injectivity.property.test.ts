import { type RenderedFragment, renderedDigestOf } from '@atrium/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CovenantDocReaderProd } from '@/lib/covenant-reader';

/**
 * THE PROPERTY-BASED INJECTIVITY ORACLE (#189 round-4 point 7 — the ACCEPTANCE GATE).
 *
 * Three fix rounds each closed a set of digest collisions, and each time the SAME
 * class reappeared in a sibling location (ancestor `String(obj)` → embed `String(obj)`;
 * object-key NFC → mark-name NFC; capture-root → resolve-root). The shared conformance
 * harness could not catch that because it is COMMON-MODE: both readers run the same
 * hand-written encoder, so a per-case assertion only ever tests the cases someone
 * thought to write. This oracle is different in kind:
 *
 *   - It GENERATES many structurally-distinct spans (text, marks, embeds with types /
 *     children / sibling fields, ancestor attributes, nested objects, arrays, bigints,
 *     NFC-equivalent strings) from a FIXED seed list (deterministic — no `Math.random`).
 *   - It is INDEPENDENT OF THE READER'S ENCODER. It never calls `canonicalizeLeafValue`
 *     or inspects the reader's tagged strings. It builds its OWN, separately-written
 *     canonical signature of each span's INTENDED logical content (`specSig`), then
 *     drives the span through the production reader → `@atrium/core`'s `renderedDigestOf`
 *     and checks the digest against that signature. A bug in the reader's encoder cannot
 *     be mirrored by a matching bug here, because the two are written independently.
 *   - It tests the CLASS, as a biconditional over every generated pair:
 *       (i)  distinct logical content ⇒ DISTINCT digest   (no collision / false `✓`);
 *       (ii) identical logical content ⇒ IDENTICAL digest (no false-stale).
 *     Any reader defect — round-3's `type` fold, a mark-name NFC collision, a nested
 *     object that collapses — surfaces as a violation of this biconditional. On base
 *     `31aab6d` the `type`-channel fold breaks (i); after the consolidation, it holds
 *     across the whole generated space.
 *
 * Non-compliant shapes (NaN, typed arrays, sparse arrays, `__proto__` keys, NFC-dup
 * keys, symbols) are a separate property: the reader must FAIL CLOSED (never a digest),
 * so a rejected value can never share a compliant value's encoding.
 */

// ─────────────────────────────────────────────────────────────────────────────
// A deterministic PRNG (mulberry32) seeded from a FIXED list — no module-load
// `Math.random`, so a failure reproduces exactly from its seed.
// ─────────────────────────────────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const pick = <T>(rng: Rng, xs: readonly T[]): T =>
  xs[Math.floor(rng() * xs.length) % xs.length] as T;
const chance = (rng: Rng, p: number): boolean => rng() < p;

// ─────────────────────────────────────────────────────────────────────────────
// The COMPLIANT value pool — every leaf/structure the reader accepts. Deliberately
// includes the discriminating pairs from rounds 1-3: nested objects (the `String(obj)`
// class), bigints vs strings, `null`, and NFC-equivalent strings (for the no-false-
// stale direction). NON-compliant shapes are handled by a separate fail-closed
// property, so this pool stays total under `specSig`.
// ─────────────────────────────────────────────────────────────────────────────

// 'café' composed (U+00E9) — its decomposed twin is generated only as a perturbation,
// so composed/decomposed is a same-logical-content axis, never a distinctness axis.
const CAFE_COMPOSED = 'café';
const STRINGS = ['', 'a', 'b', 'ship it', 'Alice', CAFE_COMPOSED, '你好', 'x\ny'] as const;
const NUMBERS = [0, 1, -1, 42, 3.5, 1000] as const;

function genValue(rng: Rng, depth: number): unknown {
  const kinds =
    depth <= 0
      ? (['string', 'number', 'boolean', 'null', 'bigint'] as const)
      : (['string', 'number', 'boolean', 'null', 'bigint', 'object', 'array'] as const);
  switch (pick(rng, kinds)) {
    case 'string':
      return pick(rng, STRINGS);
    case 'number':
      return pick(rng, NUMBERS);
    case 'boolean':
      return chance(rng, 0.5);
    case 'null':
      return null;
    case 'bigint':
      return BigInt(pick(rng, [1, 2, 42]));
    case 'array': {
      const n = Math.floor(rng() * 3);
      const arr: unknown[] = [];
      for (let i = 0; i < n; i++) arr.push(genValue(rng, depth - 1));
      return arr;
    }
    case 'object': {
      const obj: Record<string, unknown> = {};
      const keys = ['a', 'b', 'w', 'title', 'author'];
      const n = 1 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) obj[pick(rng, keys)] = genValue(rng, depth - 1);
      return obj;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// A generated span SPEC. The certified range always covers the WHOLE body and no
// mark extends past it, so straddle is uniformly 'none' and never a hidden variable.
// ─────────────────────────────────────────────────────────────────────────────
interface AncestorSpec {
  name: string;
  attrs: Record<string, unknown>;
}
type NodeSpec =
  | { kind: 'text'; text: string; marks: Record<string, unknown> }
  // The embed ROOT is any value, not only a keyed object (#189 round-5 F1): `{}` / `[]`
  // / `42` / `{a:1}` must all be DISTINCT, so the generator varies the root's TYPE.
  | { kind: 'embed'; embed: unknown };
interface Spec {
  ancestors: AncestorSpec[];
  nodes: NodeSpec[];
  // The body XmlText's OWN node attributes (#189 round-5 F3): a surface `toDelta` never
  // shows. COMPLIANT values only here; the `__proto__` body attr is a fail-closed case.
  bodyAttrs?: Record<string, unknown>;
}

// `constructor` is a COMPLIANT mark name (assignment shadows it as an own key, so the
// guarded adapter keeps it) — distinct from the `__proto__` hazard, which fails closed.
const MARK_NAMES = ['bold', 'italic', 'highlight', 'link', 'constructor'] as const;
const ATTR_NAMES = ['level', 'align', 'indent', 'meta'] as const;
const BODY_ATTR_NAMES = ['data-id', 'lang', 'dir'] as const;
const EMBED_TYPES = ['image', 'mention', 'nestedDoc', 'tag'] as const;

function genMarks(rng: Rng): Record<string, unknown> {
  const marks: Record<string, unknown> = {};
  const n = Math.floor(rng() * 3);
  const names = [...MARK_NAMES];
  for (let i = 0; i < n && names.length > 0; i++) {
    const idx = Math.floor(rng() * names.length);
    const name = names.splice(idx, 1)[0] as string; // distinct mark names (NFC-dup tested separately)
    marks[name] = chance(rng, 0.4) ? genValue(rng, 1) : pick(rng, STRINGS);
  }
  return marks;
}

// Vary the embed ROOT TYPE (#189 round-5 point 3): a keyed object, an empty object, a
// dense array, or a bare scalar — the reader must digest each root TYPE distinctly.
function genEmbed(rng: Rng): unknown {
  const rootKind = pick(rng, ['object', 'object', 'empty-object', 'array', 'scalar'] as const);
  if (rootKind === 'empty-object') return {};
  if (rootKind === 'array') {
    const n = Math.floor(rng() * 3);
    const arr: unknown[] = [];
    for (let i = 0; i < n; i++) arr.push(genValue(rng, 1));
    return arr;
  }
  if (rootKind === 'scalar') return pick(rng, [42, 'x', true, null] as const);
  const embed: Record<string, unknown> = {};
  // The TYPE channel — absent / 'embed' / null / a real type — the round-3 fold class.
  const typeChoice = pick(rng, ['absent', 'embed', 'null', 'real'] as const);
  if (typeChoice === 'embed') embed.type = 'embed';
  else if (typeChoice === 'null') embed.type = null;
  else if (typeChoice === 'real') embed.type = pick(rng, EMBED_TYPES);
  // else absent
  // A couple of identity fields, sometimes a nested object (the String(obj) class),
  // sometimes a sibling `docDigest` (the shadow class), sometimes a child body.
  const fieldPool = ['src', 'target', 'label', 'id', 'meta', 'docDigest'];
  const n = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const k = pick(rng, fieldPool);
    embed[k] = genValue(rng, 1);
  }
  if (chance(rng, 0.5)) embed.child = genValue(rng, 1);
  return embed;
}

function genBodyAttrs(rng: Rng): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  const n = Math.floor(rng() * 3); // often none — a body with no attrs must digest as before
  const names = [...BODY_ATTR_NAMES];
  for (let i = 0; i < n && names.length > 0; i++) {
    const name = names.splice(Math.floor(rng() * names.length), 1)[0] as string;
    attrs[name] = chance(rng, 0.3) ? genValue(rng, 1) : pick(rng, STRINGS);
  }
  return attrs;
}

function genSpec(rng: Rng): Spec {
  const ancestors: AncestorSpec[] = [];
  const depth = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < depth; i++) {
    const attrs: Record<string, unknown> = {};
    const an = Math.floor(rng() * 3);
    const names = [...ATTR_NAMES];
    for (let j = 0; j < an && names.length > 0; j++) {
      const name = names.splice(Math.floor(rng() * names.length), 1)[0] as string;
      attrs[name] = chance(rng, 0.3) ? genValue(rng, 1) : pick(rng, STRINGS);
    }
    ancestors.push({ name: pick(rng, ['heading', 'blockquote', 'paragraph']), attrs });
  }
  const nodes: NodeSpec[] = [];
  const nn = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < nn; i++) {
    if (chance(rng, 0.45)) nodes.push({ kind: 'embed', embed: genEmbed(rng) });
    else
      nodes.push({
        kind: 'text',
        text: pick(rng, ['A', 'BB', 'ship', CAFE_COMPOSED]),
        marks: genMarks(rng),
      });
  }
  return { ancestors, nodes, bodyAttrs: genBodyAttrs(rng) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Build a real Y.Doc from a spec, then read it through the PRODUCTION reader and
// digest via `@atrium/core`. Outcome is a digest, or a fail-closed sentinel.
// ─────────────────────────────────────────────────────────────────────────────
function buildDoc(spec: Spec): { doc: Y.Doc; path: number[]; start: number; end: number } {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('doc');
  const path: number[] = [];
  let parent: Y.XmlFragment | Y.XmlElement = frag;
  for (const anc of spec.ancestors) {
    const el = new Y.XmlElement(anc.name);
    for (const [k, v] of Object.entries(anc.attrs)) el.setAttribute(k, v as string);
    parent.insert(0, [el]);
    path.push(0);
    parent = el;
  }
  const body = new Y.XmlText();
  parent.insert(0, [body]);
  path.push(0);
  // The body's OWN node attributes (#189 round-5 F3) — a surface `toDelta` never shows.
  if (spec.bodyAttrs) {
    for (const [k, v] of Object.entries(spec.bodyAttrs)) body.setAttribute(k, v as string);
  }
  let pos = 0;
  for (const node of spec.nodes) {
    if (node.kind === 'text') {
      body.insert(pos, node.text);
      if (Object.keys(node.marks).length > 0) body.format(pos, node.text.length, node.marks);
      pos += node.text.length;
    } else {
      // The embed root is ANY value (object / array / scalar / empty) — the reader must
      // discriminate its TYPE. Yjs accepts a non-object embed value verbatim.
      body.insertEmbed(pos, node.embed as object);
      pos += 1;
    }
  }
  return { doc, path, start: 0, end: pos };
}

function readerOutcome(spec: Spec): string {
  let built: ReturnType<typeof buildDoc>;
  try {
    built = buildDoc(spec);
  } catch {
    return 'BUILD:throw'; // an exotic Yjs value rejected at insert — still fail-closed
  }
  const reader = new CovenantDocReaderProd(built.doc, {
    path: built.path,
    start: built.start,
    end: built.end,
  });
  let cap: ReturnType<typeof reader.captureSelection>;
  try {
    cap = reader.captureSelection();
  } catch {
    return 'READ:throw'; // canonicalize failed closed ⇒ DRIFT, not a digest
  }
  if (cap === null) return 'READ:null';
  return `digest:${renderedDigestOf(cap.fragment as RenderedFragment)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The INDEPENDENT logical signature. Separately written from the reader's encoder:
// different tags, different structure. It models the reader's INTENDED meaning of a
// span (ancestors in order; text = content + mark SET; embed = explicit type channel
// + identity fields + child) so a reader that renders two distinct-meaning spans
// alike (a collision) or two same-meaning spans differently (a false-stale) shows as
// a mismatch between this signature and the digest.
// ─────────────────────────────────────────────────────────────────────────────
function valSig(v: unknown): string {
  if (v === null) return 'N';
  const t = typeof v;
  if (t === 'string') return `S(${JSON.stringify((v as string).normalize('NFC'))})`;
  if (t === 'number') return `D(${Object.is(v, -0) ? '-0' : String(v)})`;
  if (t === 'boolean') return `B(${v})`;
  if (t === 'bigint') return `I(${(v as bigint).toString()})`;
  if (Array.isArray(v)) return `A[${v.map(valSig).join('|')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj)
    .map((k) => k.normalize('NFC'))
    .sort();
  return `O{${keys.map((k) => `${JSON.stringify(k)}=${valSig(obj[k])}`).join('|')}}`;
}

function marksSig(marks: Record<string, unknown>): string {
  const keys = Object.keys(marks)
    .map((k) => k.normalize('NFC'))
    .sort();
  return `[${keys.map((k) => `${JSON.stringify(k)}:${valSig(marks[k])}`).join('|')}]`;
}

// INDEPENDENT embed signature (#189 round-5 — deliberately NOT the reader's walk). The
// round-4 oracle re-derived the reader's own embed decomposition — the `embedType`/`type`
// channel selection, the `#child` reserved key, the `a:` passthrough namespace — so a bug
// SHARED by that walk (the tie-break's embed-root fold: `{}` ≡ `[]` ≡ `42`, all read as an
// empty keyed-object walk) was mirrored here and slipped past (COMMON-MODE). This signature
// is a different decomposition entirely: an embed's logical identity is simply its whole
// root VALUE, encoded structurally by the shared `valSig` — which discriminates `{}` (`O{}`)
// from `[]` (`A[]`) from `42` (`D(42)`) from `{a:1}` (`O{"a"=D(1)}`) with NO channel/reserved
// -key/namespace logic. Two embeds are logically equal IFF their root values are deep-equal;
// a reader that folds distinct roots together therefore lands two distinct sigs on one digest
// and is CAUGHT. It never inspects `embedType`/`type`/`child` specially — that is the point.
function embedSig(embed: unknown): string {
  return `EMB(${valSig(embed)})`;
}

function specSig(spec: Spec): string {
  const anc = spec.ancestors
    .map((a) => {
      const keys = Object.keys(a.attrs)
        .map((k) => k.normalize('NFC'))
        .sort();
      return `${a.name}{${keys.map((k) => `${JSON.stringify(k)}=${valSig(a.attrs[k])}`).join('|')}}`;
    })
    .join('>');
  const nodes = spec.nodes
    .map((n) =>
      n.kind === 'text'
        ? `T(${JSON.stringify(n.text.normalize('NFC'))};${marksSig(n.marks)})`
        : embedSig(n.embed),
    )
    .join(',');
  // Body attrs are a distinct surface (#189 round-5 F3); OMITTED when empty so a body
  // with none signs — and digests — exactly as a body that never had the surface.
  const bodyKeys = Object.keys(spec.bodyAttrs ?? {})
    .map((k) => k.normalize('NFC'))
    .sort();
  const bodyPart =
    bodyKeys.length > 0
      ? `::BODY{${bodyKeys.map((k) => `${JSON.stringify(k)}=${valSig((spec.bodyAttrs as Record<string, unknown>)[k])}`).join('|')}}`
      : '';
  return `ANC[${anc}]::NODES[${nodes}]${bodyPart}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// A logically-equivalent PERTURBATION: same content, different concrete shape —
// reorder object/mark/attr keys, swap NFC-composed strings for their decomposed
// twins. `specSig` is invariant under it, so the reader's digest MUST be too.
// ─────────────────────────────────────────────────────────────────────────────
function decompose(s: string): string {
  return s.normalize('NFD'); // café(composed) → cafe+U+0301 — same NFC, distinct bytes
}
function perturbValue(v: unknown, rng: Rng): unknown {
  if (typeof v === 'string') return chance(rng, 0.7) ? decompose(v) : v;
  if (Array.isArray(v)) return v.map((x) => perturbValue(x, rng));
  if (v !== null && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj);
    // reverse insertion order
    const out: Record<string, unknown> = {};
    for (const k of keys.reverse()) out[k] = perturbValue(obj[k], rng);
    return out;
  }
  return v;
}
function perturbRecord(rec: Record<string, unknown>, rng: Rng): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(rec).reverse()) out[k] = perturbValue(rec[k], rng);
  return out;
}
function perturbSpec(spec: Spec, rng: Rng): Spec {
  return {
    ancestors: spec.ancestors.map((a) => ({ name: a.name, attrs: perturbRecord(a.attrs, rng) })),
    nodes: spec.nodes.map((n) =>
      n.kind === 'text'
        ? {
            kind: 'text',
            text: chance(rng, 0.7) ? decompose(n.text) : n.text,
            marks: perturbRecord(n.marks, rng),
          }
        : // The embed root is any value — perturb it AS a value (reorder keys / NFC-decompose).
          { kind: 'embed', embed: perturbValue(n.embed, rng) },
    ),
    bodyAttrs: spec.bodyAttrs ? perturbRecord(spec.bodyAttrs, rng) : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLLED MINIMAL-PAIR FAMILIES — the round-1-3 collision classes, generated by
// construction so the injectivity biconditional MUST exercise them (random specs
// rarely differ in exactly one axis, so a fold between two variants would otherwise
// slip past by chance). Each family is a set of specs that are pairwise DISTINCT in
// logical content but differ in only ONE meaningful axis; the reader must give each
// a distinct digest. On base `31aab6d` the type-channel and mark-name families
// collapse (a false ✓); after the consolidation, all are distinct.
// ─────────────────────────────────────────────────────────────────────────────
function discriminatorFamilies(): Spec[] {
  const specs: Spec[] = [];
  const embedSpec = (embed: unknown): Spec => ({
    ancestors: [{ name: 'paragraph', attrs: {} }],
    nodes: [{ kind: 'embed', embed }],
  });
  const markSpec = (marks: Record<string, unknown>): Spec => ({
    ancestors: [{ name: 'paragraph', attrs: {} }],
    nodes: [{ kind: 'text', text: 'x', marks }],
  });
  const bodyAttrSpec = (bodyAttrs: Record<string, unknown>): Spec => ({
    ancestors: [{ name: 'paragraph', attrs: {} }],
    nodes: [{ kind: 'text', text: 'x', marks: {} }],
    bodyAttrs,
  });

  // F1 (#189 round-5) — the EMBED-ROOT-TYPE fold the tie-break reproduced on real ops:
  // `insertEmbed {} ≡ [] ≡ 42`, all read as an empty keyed-object walk on base. Each root
  // TYPE must be distinct, and `{a:1}`/`{a:2}` (the controls) distinct from each other.
  specs.push(embedSpec({}));
  specs.push(embedSpec([]));
  specs.push(embedSpec(42));
  specs.push(embedSpec('x'));
  specs.push(embedSpec(true));
  specs.push(embedSpec(null));
  specs.push(embedSpec({ a: 1 }));
  specs.push(embedSpec({ a: 2 }));
  specs.push(embedSpec([1]));
  specs.push(embedSpec([1, 2]));

  // The `type`-channel fold (round-4): absent ≠ 'embed' ≠ null ≠ 'image' — everything
  // else held fixed. Base folds the first three onto one digest via `?? 'embed'`.
  specs.push(embedSpec({ k: 1 }));
  specs.push(embedSpec({ type: 'embed', k: 1 }));
  specs.push(embedSpec({ type: null, k: 1 }));
  specs.push(embedSpec({ type: 'image', k: 1 }));
  // `embedType` present with a sibling `type` that varies — `type` must not be dropped.
  specs.push(embedSpec({ embedType: 'img', type: 'a', k: 1 }));
  specs.push(embedSpec({ embedType: 'img', type: 'b', k: 1 }));
  specs.push(embedSpec({ embedType: 'img', k: 1 }));
  // Scalar vs object mark payload (single canonicalizer) — held under one mark name.
  specs.push(markSpec({ m: 'x' }));
  specs.push(markSpec({ m: { value: 'x' } }));
  // A `constructor` mark (COMPLIANT — assignment shadows as an own key) with distinct values.
  specs.push(markSpec({ constructor: 'A' }));
  specs.push(markSpec({ constructor: 'B' }));
  // bigint vs the string that prints the same.
  specs.push(embedSpec({ type: 't', v: 1n }));
  specs.push(embedSpec({ type: 't', v: '1' }));
  // Nested-object field (the String(obj) class) — distinct nested value.
  specs.push(embedSpec({ type: 't', meta: { w: 1 } }));
  specs.push(embedSpec({ type: 't', meta: { w: 2 } }));
  // A sibling `docDigest` must never shadow the real child.
  specs.push(embedSpec({ type: 't', child: 'innocent', docDigest: 'A' }));
  specs.push(embedSpec({ type: 't', child: 'EVIL', docDigest: 'A' }));

  // F3 (#189 round-5) — the body XmlText's OWN node attrs: a body with attr `A` ≠ `B` ≠
  // none. On base the body attrs are never read, so all three fold onto one digest.
  specs.push(bodyAttrSpec({ 'data-id': 'A' }));
  specs.push(bodyAttrSpec({ 'data-id': 'B' }));
  specs.push(bodyAttrSpec({ 'data-id': 'A', lang: 'en' }));
  specs.push(embedSpec({ type: 't', k: 9 })); // a no-body-attr control, distinct shape
  return specs;
}

const SEEDS = Array.from({ length: 60 }, (_, i) => (i + 1) * 2654435761);

describe('INJECTIVITY ORACLE (property): the reader digest is injective over generated spans', () => {
  // Generate a large, deterministic corpus of compliant spans once, plus the
  // controlled minimal-pair families that pin the named round-1-3 classes.
  const corpus: Array<{ seed: number; spec: Spec; sig: string; outcome: string }> = [];
  const add = (seed: number, spec: Spec) =>
    corpus.push({ seed, spec, sig: specSig(spec), outcome: readerOutcome(spec) });
  for (const seed of SEEDS) {
    const rng = mulberry32(seed);
    for (let k = 0; k < 5; k++) add(seed, genSpec(rng));
  }
  discriminatorFamilies().forEach((spec, i) => {
    add(-1 - i, spec);
  });

  it('the corpus actually produces compliant digests (the reader is exercised, not all-throw)', () => {
    const digested = corpus.filter((c) => c.outcome.startsWith('digest:'));
    expect(digested.length).toBeGreaterThan(200); // a real, exercised space
  });

  it('(i) NO COLLISION — distinct logical content ⇒ distinct digest', () => {
    // Group every generated span by its INDEPENDENT signature; any two spans that
    // digest equal MUST be in the same signature group. A round-3-style fold (two
    // distinct-meaning spans → one digest) puts two different sigs under one digest.
    const byDigest = new Map<string, Set<string>>();
    for (const c of corpus) {
      if (!c.outcome.startsWith('digest:')) continue;
      const sigs = byDigest.get(c.outcome) ?? new Set<string>();
      sigs.add(c.sig);
      byDigest.set(c.outcome, sigs);
    }
    const collisions = [...byDigest.entries()].filter(([, sigs]) => sigs.size > 1);
    expect(collisions.map(([digest, sigs]) => ({ digest, sigs: [...sigs] }))).toEqual([]);
  });

  it('(ii) NO FALSE-STALE — identical logical content ⇒ identical digest', () => {
    // The mirror: any two spans with the SAME signature must have the SAME outcome.
    const bySig = new Map<string, Set<string>>();
    for (const c of corpus) {
      const outs = bySig.get(c.sig) ?? new Set<string>();
      outs.add(c.outcome);
      bySig.set(c.sig, outs);
    }
    const stale = [...bySig.entries()].filter(([, outs]) => outs.size > 1);
    expect(stale.map(([sig, outs]) => ({ sig, outs: [...outs] }))).toEqual([]);
  });

  it('a logically-equivalent perturbation (key reorder + NFC decompose) never moves the digest', () => {
    // Directly checks no-false-stale on the normalization axes: same content, different
    // concrete shape. A sort-before-NFC bug, a key-order leak, or a mark-order leak
    // would move the digest here.
    for (const c of corpus) {
      if (!c.outcome.startsWith('digest:')) continue;
      const rng = mulberry32(c.seed ^ 0x9e3779b9);
      const perturbed = perturbSpec(c.spec, rng);
      expect(specSig(perturbed)).toBe(c.sig); // the perturbation truly preserves content
      expect(readerOutcome(perturbed)).toBe(c.outcome); // …so the digest must not move
    }
  });

  it('injective count: distinct digests == distinct signatures over the digested corpus', () => {
    const digested = corpus.filter((c) => c.outcome.startsWith('digest:'));
    const digests = new Set(digested.map((c) => c.outcome));
    const sigs = new Set(digested.map((c) => c.sig));
    expect(digests.size).toBe(sigs.size); // a perfect bijection ⇒ injective
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FAIL-CLOSED property: every NON-compliant shape the generator can plant must yield
// a fail-closed outcome (never a digest), so a rejected value can never share a
// compliant value's encoding. Each of these is a class the earlier rounds collapsed.
// ─────────────────────────────────────────────────────────────────────────────
describe('INJECTIVITY ORACLE (property): non-compliant shapes ALWAYS fail closed', () => {
  const embedSpec = (embed: Record<string, unknown>): Spec => ({
    ancestors: [{ name: 'paragraph', attrs: {} }],
    nodes: [{ kind: 'embed', embed }],
  });
  const markSpec = (marks: Record<string, unknown>): Spec => ({
    ancestors: [{ name: 'paragraph', attrs: {} }],
    nodes: [{ kind: 'text', text: 'x', marks }],
  });
  const ancestorSpec = (attrs: Record<string, unknown>): Spec => ({
    ancestors: [{ name: 'paragraph', attrs }],
    nodes: [{ kind: 'text', text: 'x', marks: {} }],
  });
  const bodyAttrSpec = (bodyAttrs: Record<string, unknown>): Spec => ({
    ancestors: [{ name: 'paragraph', attrs: {} }],
    nodes: [{ kind: 'text', text: 'x', marks: {} }],
    bodyAttrs,
  });
  // Plant a GENUINE own enumerable `__proto__` key the way a CRDT wire object could — a
  // literal `{ __proto__: … }` only sets the prototype (no own key), so defineProperty.
  const withOwnProto = (val: unknown): Record<string, unknown> => {
    const o: Record<string, unknown> = {};
    Object.defineProperty(o, '__proto__', {
      value: val,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    return o;
  };

  const failsClosed = (spec: Spec) => expect(readerOutcome(spec).startsWith('digest:')).toBe(false);

  it('NaN / ±Infinity in an embed field ⇒ fail closed', () => {
    failsClosed(embedSpec({ type: 'x', v: Number.NaN }));
    failsClosed(embedSpec({ type: 'x', v: Number.POSITIVE_INFINITY }));
  });
  it('a typed array (Uint8Array) ⇒ fail closed (never coerced to an index object)', () => {
    failsClosed(embedSpec({ type: 'x', data: new Uint8Array([1, 2, 3]) }));
  });
  it('a sparse array (a hole) ⇒ fail closed', () => {
    const sparse: unknown[] = [1];
    sparse[2] = 3; // index 1 is a hole
    expect(1 in sparse).toBe(false); // genuinely sparse
    failsClosed(embedSpec({ type: 'x', data: sparse }));
  });
  it('a Date / Map / Set value ⇒ fail closed', () => {
    failsClosed(embedSpec({ type: 'x', d: new Date(0) }));
    failsClosed(embedSpec({ type: 'x', m: new Map([['a', 1]]) }));
    failsClosed(embedSpec({ type: 'x', s: new Set([1]) }));
  });
  it('a symbol-keyed object ⇒ fail closed', () => {
    const o: Record<string | symbol, unknown> = { a: 1 };
    o[Symbol('s')] = 2;
    failsClosed(embedSpec({ type: 'x', o: o as Record<string, unknown> }));
  });
  it('NFC-duplicate keys in a nested embed object ⇒ fail closed', () => {
    const dup: Record<string, unknown> = {};
    dup['café'] = 1;
    dup['café'] = 2;
    failsClosed(embedSpec({ type: 'x', o: dup }));
  });
  it('a NaN mark payload ⇒ fail closed', () => {
    failsClosed(markSpec({ bold: Number.NaN }));
  });
  it('a `__proto__` ancestor attribute ⇒ fail closed (never an invisible mutation)', () => {
    // A literal `{ __proto__: … }` sets the PROTOTYPE (no own key); use defineProperty
    // to plant a genuine own `__proto__` attribute the way a CRDT wire object could.
    const attrs: Record<string, unknown> = {};
    Object.defineProperty(attrs, '__proto__', {
      value: 'EVIL',
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(Object.hasOwn(attrs, '__proto__')).toBe(true);
    failsClosed(ancestorSpec(attrs));
  });

  // ── F2 (#189 round-5): a `__proto__` MARK — the tie-break's reproduced collision ──
  it('F2: a `__proto__` MARK ⇒ fail closed, and INNOCENT↔EVIL is distinct-or-DRIFT', () => {
    // `body.format(…, {__proto__:'INNOCENT', bold:true})` persists a genuine `__proto__`
    // ContentFormat item, but `toDelta()` DROPS it at read (both flips deltaed back to
    // only `bold`) — the invisible mutation. Reading marks from the Yjs items directly
    // surfaces it; the guarded adapter then fails it closed. Both flips fail closed, so
    // the INNOCENT-certifies-then-EVIL-resolves-`ok` hole is gone (distinct-or-DRIFT).
    const innocent = readerOutcome(markSpec(withOwnProto('INNOCENT')));
    const evil = readerOutcome(markSpec(withOwnProto('EVIL')));
    expect(innocent.startsWith('digest:')).toBe(false); // fail closed, never a digest
    expect(evil.startsWith('digest:')).toBe(false);
    // distinct-or-DRIFT holds trivially via the DRIFT branch: neither can resolve `ok`.
    expect(innocent === 'digest:X' && evil === 'digest:X').toBe(false);
  });
  it('F2: a `__proto__` mark alongside a real `bold` mark ⇒ still fail closed', () => {
    const marks = withOwnProto('EVIL');
    marks.bold = true;
    failsClosed(markSpec(marks));
  });

  // ── NFC-duplicate MARK NAMES (a key surface like object keys) ⇒ fail closed ──
  it('NFC-duplicate mark names (café composed + decomposed) ⇒ fail closed', () => {
    const composed = 'café'; // NFC form (e-acute as one code point)
    const decomposed = composed.normalize('NFD'); // e + combining acute; distinct bytes, same NFC
    expect(composed).not.toBe(decomposed);
    expect(composed.normalize('NFC')).toBe(decomposed.normalize('NFC'));
    const marks: Record<string, unknown> = {};
    marks[composed] = 1;
    marks[decomposed] = 2;
    expect(Object.keys(marks).length).toBe(2); // genuinely two raw keys
    failsClosed(markSpec(marks));
  });

  // ── F3 (#189 round-5): a `__proto__` BODY attribute ⇒ fail closed ──
  it('F3: a `__proto__` body attribute ⇒ fail closed (never an invisible body mutation)', () => {
    failsClosed(bodyAttrSpec(withOwnProto('EVIL')));
  });
  it('a NaN body-attribute value ⇒ fail closed', () => {
    failsClosed(bodyAttrSpec({ 'data-id': Number.NaN }));
  });
});
