import { type CovenantAnchor, certifyAnchor, resolveCovenant } from '@atrium/core';
import { describe, expect, it } from 'vitest';
import { CertifyObjectSpanInput } from '@/app/app/[workspace]/[room]/control/covenant-actions-input';
import {
  type CovenantDocReaderProd,
  type RootResolver,
  readerForLiveDoc,
} from '@/lib/covenant-reader';
import { CertifyBody } from '../app/prototype/CertifyPassage';
import {
  bodyLengthOf,
  bodyModelLength,
  bodyRenderDivergesFromRaw,
  objectSpanRequest,
  renderBodyModel,
  spanFromRange,
  spanFromSelection,
} from '../app/prototype/certify-span';
import type { ChatMsg } from '../app/prototype/types';
import { ConversationDoc, conversationContentRoot } from '../app/prototype/yjs-conversation';
import { renderCertifyBodyDom } from './support/certify-body-dom';

/* ═══════════════════════════════════════════════════════════════════════════
 * E8 / #197 — the SELECTION → COVENANT SPAN mapping is byte-for-byte, and MOVES.
 *
 * The load-bearing property: a DOM range over a body rendered 1:1 maps to the
 * EXACT `{ bodyPath, start, end }` the covenant resolver re-reads from the live
 * `Y.XmlText`. These tests prove it three ways that cannot all pass by accident —
 * and, crucially, the "expected" span is ALWAYS derived INDEPENDENTLY of the mapper
 * (from the fixture string's own indices), never from the mapper's own output:
 *
 *   1. RAW-INDEX, NOT RENDERED. The offsets index the raw `Y.XmlText` string, so
 *      `T.slice(start, end)` is exactly the selected passage — a rendered-offset
 *      mapping would land elsewhere. The expected offsets are computed from the
 *      fixture text (`T.indexOf`, `.length`), not read back from the mapper.
 *   2. THE READER RE-READS THE SAME BYTES (end-to-end, NOT tautological). The
 *      mapped offsets are handed to the production `CovenantDocReaderProd` — the
 *      class the server certify path uses — and its OWN captured fragment text is
 *      asserted to equal the INDEPENDENTLY-sliced passage. (The old test only
 *      asserted `resolveCovenant(...) === ok`, which is `ok` for ANY in-range span
 *      on an unchanged doc — it proved the request was well-formed, never that the
 *      coords matched the selection. That framing is gone.)
 *   3. IT MOVES (the mutation gate). Flip / shift / grow the selection and the
 *      mapped span moves with it, character-for-character, against independently
 *      computed targets.
 *
 * Embeds count as exactly one unit and inline marks as zero — and the never-flip
 * fixtures (surrogate pair, combining mark, newline-split nodes, control-char
 * rewrite, embed boundaries, 2nd-message body, last char, cross-body) each pin a
 * coordinate class that a naive offset would silently get wrong.
 * ═════════════════════════════════════════════════════════════════════════ */

const ALICE = { kind: 'human', userId: 'u_alice' } as const;
const AT = '2026-08-17T12:00:00.000Z';

/** Non-null assert without the `!` operator (the repo forbids it) — throws on null. */
function nn<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('expected a non-null value in test setup');
  return value;
}

function seededDoc(...messages: ChatMsg[]): ConversationDoc {
  return new ConversationDoc().seed(messages);
}

function msg(id: string, text: string): ChatMsg {
  return { id, time: '12:00', kind: 'human', who: 'you', text };
}

/** A capturing reader over a body span — the exact pattern the server certify path uses. */
function readerFor(
  convo: ConversationDoc,
  id: string,
  span: { start: number; end: number },
): CovenantDocReaderProd {
  const path = convo.bodyPath(id);
  if (!path) throw new Error('no body path');
  const provider = () => (convo.isDestroyed() ? null : convo.doc);
  const root: RootResolver = conversationContentRoot;
  return readerForLiveDoc(
    provider,
    { path, start: span.start, end: span.end },
    { resolveRoot: root },
  );
}

/**
 * The text the PRODUCTION reader itself re-reads at a mapped span — an INDEPENDENT
 * witness of what the covenant would certify. Text nodes contribute their verbatim
 * characters; an embed contributes the U+FFFC object-replacement sentinel (its one
 * opaque unit). Comparing this to a passage sliced straight from the fixture string
 * proves the mapped coordinates address the selected region end-to-end — not that
 * "the resolver agrees with itself".
 */
function readerText(
  convo: ConversationDoc,
  id: string,
  span: { start: number; end: number },
): string {
  const capture = readerFor(convo, id, span).captureSelection();
  if (!capture) throw new Error('reader captured nothing for span');
  return capture.fragment.nodes.map((node) => (node.kind === 'text' ? node.text : '￼')).join('');
}

function certify(
  convo: ConversationDoc,
  id: string,
  span: { start: number; end: number },
): CovenantAnchor {
  const anchor = certifyAnchor(readerFor(convo, id, span), {
    objectId: 'o_span',
    roomId: 'room_1',
    certifier: ALICE,
    certifiedAt: AT,
  });
  if (anchor === null) throw new Error('capture failed for span');
  return anchor;
}

/** The round-trip STATUS — kept only to assert a mapped span is a well-formed,
    in-range covenant input; it is NOT a mapping proof (see the header). */
const roundTripStatus = (
  convo: ConversationDoc,
  id: string,
  span: { start: number; end: number },
) => resolveCovenant(readerFor(convo, id, span), certify(convo, id, span)).covenantStatus;

// A raw body deliberately carrying source markers a RENDERED view would transform
// (a `@mention`, a `==highlight==`) — so a rendered-offset mapping would be caught.
const T = 'ship the @scout reading; ==audited== and safe to merge';

describe('the selection→span mapping addresses the exact Y.XmlText span', () => {
  it('maps a DOM range to the raw Y.XmlText offsets, and the reader re-reads that exact passage', () => {
    const convo = seededDoc(msg('m1', T));
    const body = nn(convo.body('m1'));
    expect(body.toString()).toBe(T); // the substrate holds the RAW text, markers and all

    const { root, textNodeOf } = renderCertifyBodyDom(CertifyBody, renderBodyModel(body));
    // Sanity: the rendered body's index length equals the Y.XmlText length.
    expect(bodyLengthOf(root)).toBe(body.length);
    expect(bodyModelLength(renderBodyModel(body))).toBe(body.length);

    // INDEPENDENT expected offsets — from the fixture string, not the mapper.
    const passage = '==audited==';
    const i = T.indexOf(passage);
    const j = i + passage.length;
    expect(i).toBeGreaterThan(0);

    const range = root.ownerDocument.createRange();
    const tn = textNodeOf(0); // the single text run
    range.setStart(tn, i);
    range.setEnd(tn, j);

    const span = nn(spanFromRange(root, range));
    expect(span).toEqual({ start: i, end: j });
    // BYTE-FOR-BYTE: the mapped offsets slice exactly the selected passage.
    expect(T.slice(span.start, span.end)).toBe(passage);
    // END-TO-END: the PRODUCTION reader, handed those offsets, re-reads the SAME
    // passage — independent witness, not a self-agreeing resolver.
    expect(readerText(convo, 'm1', span)).toBe(passage);
  });

  it('MOVES with the selection — shift, flip, and grow the range (the mutation gate)', () => {
    const convo = seededDoc(msg('m1', T));
    const body = nn(convo.body('m1'));
    const { root, textNodeOf } = renderCertifyBodyDom(CertifyBody, renderBodyModel(body));
    const tn = textNodeOf(0);
    const rangeAt = (a: number, b: number) => {
      const r = root.ownerDocument.createRange();
      r.setStart(tn, a);
      r.setEnd(tn, b);
      return r;
    };

    const base = nn(spanFromRange(root, rangeAt(9, 15))); // '@scout'
    expect(base).toEqual({ start: 9, end: 15 });
    expect(T.slice(base.start, base.end)).toBe('@scout');
    expect(readerText(convo, 'm1', base)).toBe('@scout');

    // SHIFT right by 15 chars — the whole span moves by 15, not stays put.
    const shifted = nn(spanFromRange(root, rangeAt(24, 30)));
    expect(shifted.start).toBe(base.start + 15);
    expect(shifted.end).toBe(base.end + 15);
    expect(shifted).not.toEqual(base);
    expect(readerText(convo, 'm1', shifted)).toBe(T.slice(24, 30));

    // FLIP the boundaries — a BACKWARDS selection (anchor after focus, which only
    // `Selection` can express; a `Range` auto-normalizes). spanFromSelection must
    // normalize min/max and still yield the same [9,15) passage.
    const win = nn(root.ownerDocument.defaultView);
    const sel = nn(win.getSelection());
    sel.removeAllRanges();
    sel.setBaseAndExtent(tn, 15, tn, 9); // anchor=15, focus=9 → backwards
    expect(spanFromSelection(root)).toEqual({ start: 9, end: 15 });

    // GROW the end only — start pinned, end moves.
    const grown = nn(spanFromRange(root, rangeAt(9, 24)));
    expect(grown.start).toBe(base.start);
    expect(grown.end).toBe(base.end + 9);
    expect(grown.end).not.toBe(base.end);
    expect(readerText(convo, 'm1', grown)).toBe(T.slice(9, 24));
  });

  it('a collapsed (empty) selection maps to null — there is no passage to certify', () => {
    const convo = seededDoc(msg('m1', T));
    const body = nn(convo.body('m1'));
    const { root, textNodeOf } = renderCertifyBodyDom(CertifyBody, renderBodyModel(body));
    const r = root.ownerDocument.createRange();
    r.setStart(textNodeOf(0), 4);
    r.setEnd(textNodeOf(0), 4);
    expect(spanFromRange(root, r)).toBeNull();
  });

  it('the LAST character selects to the exact body end (no off-by-one at the tail)', () => {
    const convo = seededDoc(msg('m1', 'hello'));
    const body = nn(convo.body('m1'));
    const { root, textNodeOf } = renderCertifyBodyDom(CertifyBody, renderBodyModel(body));
    const r = root.ownerDocument.createRange();
    r.setStart(textNodeOf(0), 4);
    r.setEnd(textNodeOf(0), 5); // just the final 'o'
    const span = nn(spanFromRange(root, r));
    expect(span).toEqual({ start: 4, end: 5 });
    expect('hello'.slice(4, 5)).toBe('o');
    expect(readerText(convo, 'm1', span)).toBe('o');
  });
});

describe('never-flipped coordinate classes: a naive offset would get these wrong', () => {
  it('a surrogate pair (emoji) is TWO UTF-16 units — the span counts code units, not glyphs', () => {
    const emoji = String.fromCodePoint(0x1f600); // 😀, one glyph, two UTF-16 units
    const text = `a${emoji}b`;
    expect(text.length).toBe(4); // a(1) + emoji(2) + b(1)
    const convo = seededDoc(msg('m1', text));
    const body = nn(convo.body('m1'));
    expect(body.length).toBe(4);
    const { root, textNodeOf } = renderCertifyBodyDom(CertifyBody, renderBodyModel(body));

    // Select just the emoji — INDEPENDENT offsets: after 'a' (1) through the pair (3).
    const r = root.ownerDocument.createRange();
    r.setStart(textNodeOf(0), 1);
    r.setEnd(textNodeOf(0), 3);
    const span = nn(spanFromRange(root, r));
    expect(span).toEqual({ start: 1, end: 3 });
    expect(text.slice(1, 3)).toBe(emoji);
    expect(readerText(convo, 'm1', span)).toBe(emoji);
  });

  it('a combining mark is its OWN unit — selecting base+mark spans two units', () => {
    const combining = String.fromCharCode(0x0301); // combining acute accent
    const text = `e${combining}x`; // "é" (decomposed) + 'x'
    expect(text.length).toBe(3);
    const convo = seededDoc(msg('m1', text));
    const body = nn(convo.body('m1'));
    const { root, textNodeOf } = renderCertifyBodyDom(CertifyBody, renderBodyModel(body));

    const r = root.ownerDocument.createRange();
    r.setStart(textNodeOf(0), 0);
    r.setEnd(textNodeOf(0), 2); // base 'e' + the combining mark
    const span = nn(spanFromRange(root, r));
    expect(span).toEqual({ start: 0, end: 2 });
    expect(text.slice(0, 2)).toBe(`e${combining}`);
    expect(readerText(convo, 'm1', span)).toBe(`e${combining}`);
  });

  it('a newline splits a run into MULTIPLE text nodes — a span across it still maps by raw offset', () => {
    const text = 'line1\nline2';
    expect(text.length).toBe(11); // 5 + 1 (\n) + 5
    const convo = seededDoc(msg('m1', text));
    const body = nn(convo.body('m1'));
    const segments = renderBodyModel(body);
    // The whole thing is one run, but renderRun emits several text nodes for it.
    expect(segments).toHaveLength(1);
    const { root, pointOf } = renderCertifyBodyDom(CertifyBody, segments);
    // More than one descendant text node exists for segment 0 (the newline split) —
    // the old `.firstChild` helper would have addressed only "line1".
    const first = pointOf(0, 0).node;
    expect(first.data).toBe('line1');

    // Select '1\nl' — INDEPENDENT offsets [4, 7) straddling the newline.
    const start = pointOf(0, 4);
    const end = pointOf(0, 7);
    const r = root.ownerDocument.createRange();
    r.setStart(start.node, start.offset);
    r.setEnd(end.node, end.offset);
    const span = nn(spanFromRange(root, r));
    expect(span).toEqual({ start: 4, end: 7 });
    expect(text.slice(4, 7)).toBe('1\nl');
    expect(readerText(convo, 'm1', span)).toBe('1\nl');
  });

  it('a control char is CERTIFIED raw though rendered as U+FFFD — coords align, and the surface warns', () => {
    const rlo = String.fromCharCode(0x202e); // right-to-left override (a bidi attack char)
    const text = `a${rlo}b`;
    expect(text.length).toBe(3);
    const convo = seededDoc(msg('m1', text));
    const body = nn(convo.body('m1'));
    const segments = renderBodyModel(body);

    // FIDELITY (finding #4): the raw body carries a char the surface paints as `�`,
    // so the surface must WARN — what is shown is not byte-for-byte what is certified.
    expect(bodyRenderDivergesFromRaw(segments)).toBe(true);
    // A plain body never trips the warning.
    expect(
      bodyRenderDivergesFromRaw(renderBodyModel(nn(seededDoc(msg('m2', 'plain')).body('m2')))),
    ).toBe(false);

    const { root, textNodeOf } = renderCertifyBodyDom(CertifyBody, segments);
    // The DOM render is length-preserving (the U+FFFD is one unit), so offsets align.
    expect(bodyLengthOf(root)).toBe(3);
    const r = root.ownerDocument.createRange();
    r.setStart(textNodeOf(0), 0);
    r.setEnd(textNodeOf(0), 3);
    const span = nn(spanFromRange(root, r));
    expect(span).toEqual({ start: 0, end: 3 });
    // The reader re-reads the RAW override char — the covenant certifies the bytes,
    // NOT the sanitized `�` the human saw (which is exactly why the surface warns).
    expect(readerText(convo, 'm1', span)).toBe(text);
    expect(readerText(convo, 'm1', span)).toContain(rlo);
  });

  it('render-divergence is DERIVED from the door, with the newline as its one exception', () => {
    // `bodyRenderDivergesFromRaw` is now `neutralizeControlChars(ch) !== ch` per char
    // (not a second hand-kept denylist), so it can never drift from `fileText`'s set.
    const diverges = (raw: string) =>
      bodyRenderDivergesFromRaw(renderBodyModel(nn(seededDoc(msg('mx', raw)).body('mx'))));

    // A NEWLINE is rewritten by the neutralizer, but `renderRun` re-emits it as a real
    // line break, so it renders faithfully here — it must NOT trip the warning.
    expect(diverges('line one\nline two')).toBe(false);
    // TAB survives the door untouched, so it does not diverge either.
    expect(diverges('a\tb')).toBe(false);
    // A surrogate pair (emoji) is left intact — judged as ONE char, never two lone
    // surrogates — so it does not diverge.
    expect(diverges('hi 😀 there')).toBe(false);
    // Any OTHER char the door rewrites diverges — a Unicode line separator (U+2028)
    // the old hand-list happened to include, proving the derived form still covers it.
    expect(diverges(`a${String.fromCharCode(0x2028)}b`)).toBe(true);
    // …and a bidi isolate (U+2066), so a set that GROWS in `fileText` is tracked here
    // for free rather than silently missed by a stale copy.
    expect(diverges(`x${String.fromCharCode(0x2066)}y`)).toBe(true);
  });

  it('a selection in the SECOND message maps to its OWN bodyPath, read from its own body', () => {
    const convo = seededDoc(msg('m1', T), msg('m2', 'the second body here'));
    const path1 = nn(convo.bodyPath('m1'));
    const path2 = nn(convo.bodyPath('m2'));
    expect(path2).not.toEqual(path1); // distinct blocks — not a hand-built [0, 0]

    const body2 = nn(convo.body('m2'));
    const { root, textNodeOf } = renderCertifyBodyDom(CertifyBody, renderBodyModel(body2));
    const passage = 'second';
    const i = 'the second body here'.indexOf(passage);
    const j = i + passage.length;
    const r = root.ownerDocument.createRange();
    r.setStart(textNodeOf(0), i);
    r.setEnd(textNodeOf(0), j);
    const span = nn(spanFromRange(root, r));
    expect(span).toEqual({ start: i, end: j });

    const req = nn(
      objectSpanRequest({
        workspaceSlug: 'ws',
        roomSlug: 'room',
        objectId: '00000000-0000-4000-8000-000000000000',
        bodyPath: convo.bodyPath('m2'),
        span,
      }),
    );
    expect(req.bodyPath).toEqual(path2);
    expect(req.bodyPath).not.toEqual(path1);
    // Read back through m2's OWN path — proves the span addresses m2, not m1.
    expect(readerText(convo, 'm2', span)).toBe(passage);
  });

  it('a selection straddling TWO message bodies maps to null — no single-body span to certify', () => {
    const convo = seededDoc(msg('m1', 'first body'), msg('m2', 'second body'));
    const dom1 = renderCertifyBodyDom(CertifyBody, renderBodyModel(nn(convo.body('m1'))));
    const dom2 = renderCertifyBodyDom(CertifyBody, renderBodyModel(nn(convo.body('m2'))));
    const r = dom1.root.ownerDocument.createRange();
    r.setStart(dom1.textNodeOf(0), 0); // starts in body 1
    r.setEnd(dom2.textNodeOf(0), 3); // ends in body 2
    // Neither root fully contains the range → refuse (never a cross-body span).
    expect(spanFromRange(dom1.root, r)).toBeNull();
    expect(spanFromRange(dom2.root, r)).toBeNull();
  });
});

describe('an embed counts as exactly one unit, and a selection touching it includes it whole', () => {
  it('the embed is one index unit, not its rendered label length, and reads back as one atom', () => {
    const convo = seededDoc(msg('m2', 'AB CD'));
    const body = nn(convo.body('m2'));
    body.insertEmbed(2, { embedType: 'image', src: 'x' }); // between 'AB' and ' CD'
    expect(body.length).toBe(6); // A B <embed> ' ' C D

    const segments = renderBodyModel(body);
    expect(segments.map((s) => s.kind)).toEqual(['text', 'embed', 'text']);
    const { root } = renderCertifyBodyDom(CertifyBody, segments);
    // The rendered embed atom's TEXT is long (⟦image⟧), but its body length is 1.
    expect(bodyLengthOf(root)).toBe(6);

    // Select the whole body — end must be 6 (2 + 1 embed + 3), never the atom's text.
    const whole = root.ownerDocument.createRange();
    whole.selectNodeContents(root);
    const span = nn(spanFromRange(root, whole));
    expect(span).toEqual({ start: 0, end: 6 });
    // INDEPENDENT: the reader re-reads text with the embed as a single opaque unit.
    expect(readerText(convo, 'm2', span)).toBe('AB￼ CD');

    // A span covering JUST the embed is exactly one unit wide.
    const embedEl = nn(root.querySelector('[data-certify-embed]'));
    const justEmbed = root.ownerDocument.createRange();
    justEmbed.selectNode(embedEl);
    const embedSpan = nn(spanFromRange(root, justEmbed));
    expect(embedSpan).toEqual({ start: 2, end: 3 });
    expect(readerText(convo, 'm2', embedSpan)).toBe('￼');
  });

  it('a selection ENDING INSIDE the embed atom INCLUDES it — finding #2, the always-start bug', () => {
    const convo = seededDoc(msg('m2', 'AB CD'));
    const body = nn(convo.body('m2'));
    body.insertEmbed(2, { embedType: 'image', src: 'x' });
    const segments = renderBodyModel(body);
    const { root, textNodeOf } = renderCertifyBodyDom(CertifyBody, segments);

    // A point genuinely INSIDE the embed's inner DOM (its label text node), as the
    // UPPER bound of a selection that started before it.
    const embedEl = nn(root.querySelector('[data-certify-embed]'));
    const embedInner = nn(embedEl.firstChild) as Text; // e.g. the '⟦' text node
    expect(embedInner.nodeType).toBe(3);

    const r = root.ownerDocument.createRange();
    r.setStart(textNodeOf(0), 0); // start of 'AB'
    r.setEnd(embedInner, 1); // INSIDE the embed atom
    const span = nn(spanFromRange(root, r));
    // Before the fix this ended at 2 (embed silently EXCLUDED). It must be 3.
    expect(span).toEqual({ start: 0, end: 3 });
    expect(readerText(convo, 'm2', span)).toBe('AB￼');
  });

  it('a selection ENDING EXACTLY at the embed boundary EXCLUDES it — only what was highlighted', () => {
    const convo = seededDoc(msg('m2', 'AB CD'));
    const body = nn(convo.body('m2'));
    body.insertEmbed(2, { embedType: 'image', src: 'x' });
    const segments = renderBodyModel(body);
    const { root, textNodeOf } = renderCertifyBodyDom(CertifyBody, segments);

    // End exactly at the end of 'AB' — the boundary BEFORE the embed. The embed is
    // NOT touched, so it is excluded (the endpoint is not inside the atom).
    const r = root.ownerDocument.createRange();
    r.setStart(textNodeOf(0), 0);
    r.setEnd(textNodeOf(0), 2); // 'AB', ending at the embed's near boundary
    const span = nn(spanFromRange(root, r));
    expect(span).toEqual({ start: 0, end: 2 });
    expect(readerText(convo, 'm2', span)).toBe('AB');
  });

  it('a selection whose BOTH endpoints fall inside the embed maps to the whole atom (never empty)', () => {
    const convo = seededDoc(msg('m2', 'AB CD'));
    const body = nn(convo.body('m2'));
    body.insertEmbed(2, { embedType: 'image', src: 'x' });
    const segments = renderBodyModel(body);
    const { root } = renderCertifyBodyDom(CertifyBody, segments);

    const embedEl = nn(root.querySelector('[data-certify-embed]'));
    const inner = nn(embedEl.firstChild) as Text;
    const r = root.ownerDocument.createRange();
    r.setStart(inner, 0);
    r.setEnd(inner, 1); // both inside the atom
    const span = nn(spanFromRange(root, r));
    expect(span).toEqual({ start: 2, end: 3 }); // the whole atom, one unit
    expect(readerText(convo, 'm2', span)).toBe('￼');
  });

  // ── ENCODING-INDEPENDENCE (E8 r2 finding: the r1 outward-snap over-included) ──
  //
  // The SAME physical boundary has two Range encodings and the real browser's choice
  // is unobservable here (jsdom differs from Chrome/Firefox). A caret at an embed's
  // LEFT edge is `(parent, indexOfEmbed)` or `(embed, 0)`; at its RIGHT edge it is
  // `(parent, indexOfEmbed + 1)` or `(embed, childCount)`. Both encodings of a
  // boundary MUST map to the same index, or a selection that merely ends at (or, with
  // adjacent embeds, starts at the next atom's edge) grabs an atom the human never
  // highlighted. r1 snapped every touched point outward, so `(embed, 0)` as an upper
  // bound wrongly INCLUDED the atom. These pin the fix: the child-index (parent)
  // encoding and the on-element encoding agree, and neither over-includes.
  const embedIndexInRoot = (root: HTMLElement, embedEl: Element): number =>
    Array.prototype.indexOf.call(root.childNodes, embedEl);

  it('a selection ending at the embed LEFT edge excludes it — BOTH Range encodings agree', () => {
    const convo = seededDoc(msg('m2', 'AB CD'));
    const body = nn(convo.body('m2'));
    body.insertEmbed(2, { embedType: 'image', src: 'x' });
    const segments = renderBodyModel(body);
    const { root, textNodeOf } = renderCertifyBodyDom(CertifyBody, segments);
    const embedEl = nn(root.querySelector('[data-certify-embed]'));
    const iEmbed = embedIndexInRoot(root, embedEl);

    // (embed, 0) — the point lands ON the atom element at offset 0 (its left edge).
    const rInner = root.ownerDocument.createRange();
    rInner.setStart(textNodeOf(0), 0);
    rInner.setEnd(embedEl, 0);
    expect(nn(spanFromRange(root, rInner))).toEqual({ start: 0, end: 2 });

    // (parent, indexOfEmbed) — the SAME left edge, on the parent as a child index.
    const rParent = root.ownerDocument.createRange();
    rParent.setStart(textNodeOf(0), 0);
    rParent.setEnd(root, iEmbed);
    expect(nn(spanFromRange(root, rParent))).toEqual({ start: 0, end: 2 });

    // The atom is NOT in either span — the reader re-reads only 'AB'.
    expect(readerText(convo, 'm2', { start: 0, end: 2 })).toBe('AB');
  });

  it('a selection starting at the embed RIGHT edge excludes it — BOTH Range encodings agree', () => {
    const convo = seededDoc(msg('m2', 'AB CD'));
    const body = nn(convo.body('m2'));
    body.insertEmbed(2, { embedType: 'image', src: 'x' }); // body: A B <embed> ' ' C D (len 6)
    const segments = renderBodyModel(body);
    const { root, textNodeOf } = renderCertifyBodyDom(CertifyBody, segments);
    const embedEl = nn(root.querySelector('[data-certify-embed]'));
    const iEmbed = embedIndexInRoot(root, embedEl);

    // (embed, childCount) — the point lands ON the atom element at its end (right edge).
    const rInner = root.ownerDocument.createRange();
    rInner.setStart(embedEl, embedEl.childNodes.length);
    rInner.setEnd(textNodeOf(2), 3); // ' CD' end → body end (6)
    expect(nn(spanFromRange(root, rInner))).toEqual({ start: 3, end: 6 });

    // (parent, indexOfEmbed + 1) — the SAME right edge, on the parent as a child index.
    const rParent = root.ownerDocument.createRange();
    rParent.setStart(root, iEmbed + 1);
    rParent.setEnd(textNodeOf(2), 3);
    expect(nn(spanFromRange(root, rParent))).toEqual({ start: 3, end: 6 });

    // The atom is excluded — the reader re-reads only ' CD'.
    expect(readerText(convo, 'm2', { start: 3, end: 6 })).toBe(' CD');
  });

  it('ADJACENT embeds: a selection starting on the second must not grab the first — every encoding', () => {
    const convo = seededDoc(msg('m2', 'AB'));
    const body = nn(convo.body('m2'));
    body.insertEmbed(2, { embedType: 'image', src: 'a' }); // A B <eA>          (len 3)
    body.insertEmbed(3, { embedType: 'image', src: 'b' }); // A B <eA> <eB>      (len 4)
    const segments = renderBodyModel(body);
    expect(segments.map((s) => s.kind)).toEqual(['text', 'embed', 'embed']);
    const { root } = renderCertifyBodyDom(CertifyBody, segments);
    const [eA, eB] = Array.from(root.querySelectorAll('[data-certify-embed]'));
    const iA = embedIndexInRoot(root, nn(eA));

    // The boundary BETWEEN the two atoms (body index 3) has three encodings; a
    // selection from there to the body end must cover ONLY the second atom.
    const endAtBodyEnd = (r: Range) => {
      r.setEnd(root, root.childNodes.length); // after eB → body end (4)
    };

    // (eB, 0) — left edge of the second atom.
    const rB0 = root.ownerDocument.createRange();
    rB0.setStart(nn(eB), 0);
    endAtBodyEnd(rB0);
    expect(nn(spanFromRange(root, rB0))).toEqual({ start: 3, end: 4 });

    // (eA, childCount) — right edge of the FIRST atom (same physical point). r1 snapped
    // this outward to eA's near edge and so wrongly INCLUDED eA.
    const rAend = root.ownerDocument.createRange();
    rAend.setStart(nn(eA), nn(eA).childNodes.length);
    endAtBodyEnd(rAend);
    expect(nn(spanFromRange(root, rAend))).toEqual({ start: 3, end: 4 });

    // (parent, indexOfEA + 1) — the same boundary on the parent as a child index.
    const rParent = root.ownerDocument.createRange();
    rParent.setStart(root, iA + 1);
    endAtBodyEnd(rParent);
    expect(nn(spanFromRange(root, rParent))).toEqual({ start: 3, end: 4 });

    // Only the second atom is covered — one opaque unit, the first atom untouched.
    expect(readerText(convo, 'm2', { start: 3, end: 4 })).toBe('￼');
  });

  // ── DESCENDANT-ENCODING edges (E8 r3 residual) ──
  //
  // The r2 fix classified the ELEMENT encoding of an embed edge — `(embed, 0)` /
  // `(embed, childCount)` — but a DESCENDANT encoding of the SAME physical edge —
  // `(embed.firstChild, 0)` at the left, `(embed.lastChild, textLen)` at the right —
  // fell to the interior branch and rounded include-whole regardless of coverage: a
  // selection merely ENDING at the left edge (or STARTING at the right edge) over-
  // included the atom. These pin the class closed: every text-node encoding of an edge
  // maps to the same boundary the element/parent encodings do, and the ACTUAL span
  // spanFromRange returns is fed to the reader.
  const embedTextNodes = (embedEl: Element): Text[] => {
    const out: Text[] = [];
    const visit = (n: Node) => {
      if (n.nodeType === 3) return void out.push(n as Text);
      for (let i = 0; i < n.childNodes.length; i++) {
        const c = n.childNodes[i];
        if (c) visit(c);
      }
    };
    visit(embedEl);
    return out;
  };

  it('a selection ending at the embed LEFT edge as (firstChild,0) excludes it — descendant encoding', () => {
    const convo = seededDoc(msg('m2', 'AB CD'));
    const body = nn(convo.body('m2'));
    body.insertEmbed(2, { embedType: 'image', src: 'x' });
    const segments = renderBodyModel(body);
    const { root, textNodeOf } = renderCertifyBodyDom(CertifyBody, segments);
    const embedEl = nn(root.querySelector('[data-certify-embed]'));
    const firstInner = nn(embedTextNodes(embedEl)[0]);

    // Upper bound at the atom's LEFT edge, encoded as the FIRST descendant text node
    // at offset 0. The old else-branch rounded this (upper) to `within=1` → end 3.
    const r = root.ownerDocument.createRange();
    r.setStart(textNodeOf(0), 0);
    r.setEnd(firstInner, 0);
    const span = nn(spanFromRange(root, r));
    expect(span).toEqual({ start: 0, end: 2 }); // atom EXCLUDED
    expect(readerText(convo, 'm2', span)).toBe('AB');
  });

  it('a selection starting at the embed RIGHT edge as (lastChild,len) excludes it — descendant encoding', () => {
    const convo = seededDoc(msg('m2', 'AB CD'));
    const body = nn(convo.body('m2'));
    body.insertEmbed(2, { embedType: 'image', src: 'x' }); // A B <embed> ' ' C D (len 6)
    const segments = renderBodyModel(body);
    const { root, textNodeOf } = renderCertifyBodyDom(CertifyBody, segments);
    const embedEl = nn(root.querySelector('[data-certify-embed]'));
    const inner = embedTextNodes(embedEl);
    const lastInner = nn(inner[inner.length - 1]);

    // Lower bound at the atom's RIGHT edge, encoded as the LAST descendant text node
    // at its end. The old else-branch rounded this (lower) to `within=0` → start 2,
    // grabbing the atom the human did not highlight.
    const r = root.ownerDocument.createRange();
    r.setStart(lastInner, lastInner.data.length);
    r.setEnd(textNodeOf(2), 3);
    const span = nn(spanFromRange(root, r));
    expect(span).toEqual({ start: 3, end: 6 }); // atom EXCLUDED
    expect(readerText(convo, 'm2', span)).toBe(' CD');
  });

  it('ADJACENT embeds, descendant encoding: starting at (eB.firstChild,0) must not grab eA', () => {
    const convo = seededDoc(msg('m2', 'AB'));
    const body = nn(convo.body('m2'));
    body.insertEmbed(2, { embedType: 'image', src: 'a' }); // A B <eA>      (len 3)
    body.insertEmbed(3, { embedType: 'image', src: 'b' }); // A B <eA> <eB>  (len 4)
    const segments = renderBodyModel(body);
    const { root } = renderCertifyBodyDom(CertifyBody, segments);
    const [eA, eB] = Array.from(root.querySelectorAll('[data-certify-embed]'));

    // Left edge of the SECOND atom as its first descendant text node — the same
    // physical point as eA's right edge. Must cover ONLY eB.
    const bFirst = nn(embedTextNodes(nn(eB))[0]);
    const aInner = embedTextNodes(nn(eA));
    const aLast = nn(aInner[aInner.length - 1]);

    const r1 = root.ownerDocument.createRange();
    r1.setStart(bFirst, 0);
    r1.setEnd(root, root.childNodes.length); // → body end (4)
    expect(nn(spanFromRange(root, r1))).toEqual({ start: 3, end: 4 });

    // eA's right edge as ITS last descendant text node — the same point, must agree.
    const r2 = root.ownerDocument.createRange();
    r2.setStart(aLast, aLast.data.length);
    r2.setEnd(root, root.childNodes.length);
    expect(nn(spanFromRange(root, r2))).toEqual({ start: 3, end: 4 });

    expect(readerText(convo, 'm2', { start: 3, end: 4 })).toBe('￼'); // only eB
  });

  it('an inline mark wrapper adds no units — offsets are unchanged by emphasis', () => {
    const convo = seededDoc(msg('m3', 'bold word here'));
    const body = nn(convo.body('m3'));
    body.format(0, 4, { bold: true }); // 'bold' is emphasised
    const segments = renderBodyModel(body);
    expect(segments[0]).toMatchObject({ kind: 'text', text: 'bold', marks: ['bold'] });

    const { root } = renderCertifyBodyDom(CertifyBody, segments);
    // The mark wrapper is present in the DOM but contributes no extra units.
    expect(root.querySelector('[data-marks]')).not.toBeNull();
    expect(bodyLengthOf(root)).toBe('bold word here'.length);

    const whole = root.ownerDocument.createRange();
    whole.selectNodeContents(root);
    expect(spanFromRange(root, whole)).toEqual({ start: 0, end: 'bold word here'.length });
    expect(readerText(convo, 'm3', { start: 0, end: 14 })).toBe('bold word here');
  });
});

describe('objectSpanRequest assembles exactly the strict certify payload (wiring, not mapping)', () => {
  it('carries the six wire fields and nothing resolution-bearing', () => {
    const convo = seededDoc(msg('m1', T));
    const req = objectSpanRequest({
      workspaceSlug: 'ws',
      roomSlug: 'room',
      objectId: '00000000-0000-4000-8000-000000000000',
      bodyPath: convo.bodyPath('m1'),
      span: { start: 9, end: 15 },
    });
    expect(req).not.toBeNull();
    const ok = nn(req);
    expect(Object.keys(ok).sort()).toEqual(
      ['bodyPath', 'end', 'objectId', 'roomSlug', 'start', 'workspaceSlug'].sort(),
    );
    expect(ok.bodyPath).toEqual(convo.bodyPath('m1'));
    expect(ok.start).toBe(9);
    expect(ok.end).toBe(15);
  });

  it('the mapped request PASSES the real certifyObjectSpanAction strict schema (wiring closes)', () => {
    const convo = seededDoc(msg('m1', T));
    const req = nn(
      objectSpanRequest({
        workspaceSlug: 'ws',
        roomSlug: 'room',
        objectId: '00000000-0000-4000-8000-000000000000',
        bodyPath: convo.bodyPath('m1'),
        span: { start: 9, end: 15 },
      }),
    );
    // The exact object the affordance hands `certifyObjectSpanAction` parses clean —
    // and carries NO extra (resolution-bearing) field the .strict() schema refuses.
    // NOTE: schema-parse proves the WIRE SHAPE, not the mapping (see the header).
    const parsed = CertifyObjectSpanInput.safeParse(req);
    expect(parsed.success).toBe(true);
  });

  it('is null when the message has no resolvable body path (honestly inert)', () => {
    const convo = seededDoc(msg('m1', T));
    expect(
      objectSpanRequest({
        workspaceSlug: 'ws',
        roomSlug: 'room',
        objectId: 'o',
        bodyPath: convo.bodyPath('no-such-message'),
        span: { start: 0, end: 1 },
      }),
    ).toBeNull();
  });

  it('a mapped span is a well-formed, in-range covenant input (round-trip sanity, NOT a mapping proof)', () => {
    const convo = seededDoc(msg('m1', T));
    // This only asserts the request is in-range and structurally certifiable; the
    // MAPPING correctness lives in the byte-for-byte + reader-re-read tests above.
    expect(roundTripStatus(convo, 'm1', { start: 9, end: 15 })).toBe('ok');
  });
});
