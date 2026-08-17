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
 * `Y.XmlText`. These tests prove it three ways that cannot all pass by accident:
 *
 *   1. RAW-INDEX, NOT RENDERED. The offsets index the raw `Y.XmlText` string
 *      (`body.toString()`), so `T.slice(start, end)` is exactly the selected
 *      passage — a rendered-offset mapping would land elsewhere.
 *   2. THE RESOLVER AGREES. Feeding those offsets to the production
 *      `CovenantDocReaderProd` (the same class the server certify path uses),
 *      `certifyAnchor` + `resolveCovenant` return `ok` — the span the resolver
 *      re-reads is the span we mapped.
 *   3. IT MOVES (the mutation gate). Flip / shift / grow the selection and the
 *      mapped span moves with it, character-for-character. If the output did not
 *      move when the input did, the mapping would be ornament — that is the whole
 *      point of E8, so it is asserted directly.
 *
 * Embeds count as exactly one unit and inline marks as zero (the reader's index
 * space), proven the same way.
 * ═════════════════════════════════════════════════════════════════════════ */

const ALICE = { kind: 'human', userId: 'u_alice' } as const;
const AT = '2026-08-17T12:00:00.000Z';

/** Non-null assert without the `!` operator (the repo forbids it) — throws on null. */
function nn<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('expected a non-null value in test setup');
  return value;
}

function seededDoc(message: ChatMsg): ConversationDoc {
  return new ConversationDoc().seed([message]);
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

const statusOf = (convo: ConversationDoc, id: string, anchorSpan: { start: number; end: number }) =>
  resolveCovenant(readerFor(convo, id, anchorSpan), certify(convo, id, anchorSpan)).covenantStatus;

// A raw body deliberately carrying source markers a RENDERED view would transform
// (a `@mention`, a `==highlight==`) — so a rendered-offset mapping would be caught.
const T = 'ship the @scout reading; ==audited== and safe to merge';

describe('the selection→span mapping addresses the exact Y.XmlText span', () => {
  it('maps a DOM range to the raw Y.XmlText offsets, and the resolver re-reads that span', () => {
    const convo = seededDoc({ id: 'm1', time: '12:00', kind: 'human', who: 'you', text: T });
    const body = nn(convo.body('m1'));
    expect(body.toString()).toBe(T); // the substrate holds the RAW text, markers and all

    const { root, textNodeOf } = renderCertifyBodyDom(CertifyBody, renderBodyModel(body));
    // Sanity: the rendered body's index length equals the Y.XmlText length.
    expect(bodyLengthOf(root)).toBe(body.length);
    expect(bodyModelLength(renderBodyModel(body))).toBe(body.length);

    const passage = '==audited==';
    const i = T.indexOf(passage);
    const j = i + passage.length;

    // A human's selection: a Range over the body's text at raw offsets [i, j).
    const range = root.ownerDocument.createRange();
    const tn = textNodeOf(0); // the single text run
    range.setStart(tn, i);
    range.setEnd(tn, j);

    const span = nn(spanFromRange(root, range));
    expect(span).toEqual({ start: i, end: j });
    // BYTE-FOR-BYTE: the mapped offsets slice exactly the selected passage out of
    // the raw Y.XmlText string — not a rendered/transformed offset.
    expect(T.slice(span.start, span.end)).toBe(passage);

    // THE RESOLVER AGREES: certifying [i,j) and resolving it returns ok.
    expect(statusOf(convo, 'm1', span)).toBe('ok');
  });

  it('MOVES with the selection — shift, flip, and grow the range (the mutation gate)', () => {
    const convo = seededDoc({ id: 'm1', time: '12:00', kind: 'human', who: 'you', text: T });
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

    // SHIFT right by 15 chars — the whole span moves by 15, not stays put.
    const shifted = nn(spanFromRange(root, rangeAt(24, 30)));
    expect(shifted.start).toBe(base.start + 15);
    expect(shifted.end).toBe(base.end + 15);
    expect(shifted).not.toEqual(base);
    expect(T.slice(shifted.start, shifted.end)).toBe(T.slice(24, 30));

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

    // Each distinct span the resolver re-reads round-trips ok — the mapping is live,
    // not a constant.
    expect(statusOf(convo, 'm1', base)).toBe('ok');
    expect(statusOf(convo, 'm1', shifted)).toBe('ok');
    expect(statusOf(convo, 'm1', grown)).toBe('ok');
  });

  it('a collapsed (empty) selection maps to null — there is no passage to certify', () => {
    const convo = seededDoc({ id: 'm1', time: '12:00', kind: 'human', who: 'you', text: T });
    const body = nn(convo.body('m1'));
    const { root, textNodeOf } = renderCertifyBodyDom(CertifyBody, renderBodyModel(body));
    const r = root.ownerDocument.createRange();
    r.setStart(textNodeOf(0), 4);
    r.setEnd(textNodeOf(0), 4);
    expect(spanFromRange(root, r)).toBeNull();
  });
});

describe('an embed counts as exactly one unit; inline marks as zero', () => {
  it('the embed is one index unit, not its rendered label length, and the resolver agrees', () => {
    const convo = seededDoc({ id: 'm2', time: '12:00', kind: 'human', who: 'you', text: 'AB CD' });
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
    expect(statusOf(convo, 'm2', span)).toBe('ok');

    // A span covering JUST the embed is exactly one unit wide.
    const embedEl = nn(root.querySelector('[data-certify-embed]'));
    const justEmbed = root.ownerDocument.createRange();
    justEmbed.selectNode(embedEl);
    const embedSpan = nn(spanFromRange(root, justEmbed));
    expect(embedSpan.end - embedSpan.start).toBe(1);
    expect(embedSpan).toEqual({ start: 2, end: 3 });
  });

  it('an inline mark wrapper adds no units — offsets are unchanged by emphasis', () => {
    const convo = seededDoc({
      id: 'm3',
      time: '12:00',
      kind: 'human',
      who: 'you',
      text: 'bold word here',
    });
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
  });
});

describe('objectSpanRequest assembles exactly the strict certify payload', () => {
  it('carries the six wire fields and nothing resolution-bearing', () => {
    const convo = seededDoc({ id: 'm1', time: '12:00', kind: 'human', who: 'you', text: T });
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
    const convo = seededDoc({ id: 'm1', time: '12:00', kind: 'human', who: 'you', text: T });
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
    const parsed = CertifyObjectSpanInput.safeParse(req);
    expect(parsed.success).toBe(true);
  });

  it('is null when the message has no resolvable body path (honestly inert)', () => {
    const convo = seededDoc({ id: 'm1', time: '12:00', kind: 'human', who: 'you', text: T });
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
});
