/* Unit tests for the E-slice client covenant resolver (#212). The glyph authority
 * the drivable demo renders from: a certified span resolves ✓ while its exact
 * content stands, ~ on any drift, ✓ again on an EXACT revert, ~ on a look-alike
 * swap, and — fail-closed — ~ whenever the span cannot be verified. These flip the
 * signed content and assert the verdict actually moves (the covenant honesty bar,
 * criteria 3/6/8/10; and 5 — an edit outside the span does not stale it). */

import { certifyAnchor } from '@atrium/core';
import { describe, expect, it } from 'vitest';
import {
  certifyClientAnchor,
  type DemoAnchor,
  resolveClientAnchor,
} from '@/app/prototype/covenant-demo/client-covenant';
import { CovenantDocReaderProd } from '@/lib/covenant-reader';
import { conversationContentRoot, ConversationDoc } from '@/app/prototype/yjs-conversation';

const ROOM = 'billing-rewrite';
const USER = 'u-you';
const MSG = 'm-agent';
const TEXT = 'hello world';

/** Seed a one-message doc and certify the span `[start,end)` of its body. */
function seededAnchor(start: number, end: number): { doc: ConversationDoc; demo: DemoAnchor } {
  const doc = new ConversationDoc().seed([
    { id: MSG, time: '10:00', kind: 'agent', who: 'hexi', text: TEXT },
  ]);
  const bodyPath = doc.bodyPath(MSG);
  expect(bodyPath).not.toBeNull();
  const demo = certifyClientAnchor(doc, {
    objectId: MSG,
    roomId: ROOM,
    userId: USER,
    messageId: MSG,
    bodyPath: bodyPath as number[],
    start,
    end,
  });
  expect(demo).not.toBeNull();
  return { doc, demo: demo as DemoAnchor };
}

describe('client covenant resolver (#212 E-slice)', () => {
  it('digest match → ✓ (rubric 1): a just-certified span resolves ok', () => {
    const { doc, demo } = seededAnchor(0, 5); // "hello"
    expect(resolveClientAnchor(doc, demo.anchor)).toBe('ok');
  });

  it('one-character edit inside the span → ~ (rubric 3)', () => {
    const { doc, demo } = seededAnchor(0, 5);
    const body = doc.body(MSG)!;
    doc.doc.transact(() => body.insert(2, 'X')); // "heXllo world" — inside [0,5)
    expect(resolveClientAnchor(doc, demo.anchor)).toBe('drift');
  });

  it('a mark/format change on the span → ~ (rubric 4)', () => {
    const { doc, demo } = seededAnchor(0, 5);
    const body = doc.body(MSG)!;
    doc.doc.transact(() => body.format(0, 5, { bold: true }));
    expect(resolveClientAnchor(doc, demo.anchor)).toBe('drift');
  });

  it('an edit OUTSIDE the span does not stale it → ✓ (rubric 5)', () => {
    const { doc, demo } = seededAnchor(0, 5); // "hello"
    const body = doc.body(MSG)!;
    doc.doc.transact(() => body.insert(6, 'X')); // inside "world", outside [0,5)
    expect(resolveClientAnchor(doc, demo.anchor)).toBe('ok');
  });

  it('exact revert (undo) → re-validate ✓ (rubric 6): no re-certify', () => {
    const { doc, demo } = seededAnchor(0, 5);
    const body = doc.body(MSG)!;
    doc.doc.transact(() => body.insert(2, 'X')); // drift
    expect(resolveClientAnchor(doc, demo.anchor)).toBe('drift');
    // Undo the exact edit — delete the inserted item, leaving the original items
    // untouched (a true revert; the certified content stands byte-for-byte again).
    doc.doc.transact(() => body.delete(2, 1));
    expect(resolveClientAnchor(doc, demo.anchor)).toBe('ok');
  });

  it('look-alike swap (zero-width) → ~ (rubric 10)', () => {
    const { doc, demo } = seededAnchor(0, 5);
    const body = doc.body(MSG)!;
    doc.doc.transact(() => body.insert(2, '​')); // ZWSP inside the span
    expect(resolveClientAnchor(doc, demo.anchor)).toBe('drift');
  });

  it('look-alike swap (homoglyph) → ~ (rubric 10)', () => {
    const { doc, demo } = seededAnchor(0, 5);
    const body = doc.body(MSG)!;
    doc.doc.transact(() => {
      body.delete(4, 1); // 'o' (Latin U+006F) → the 5th char of "hello"
      body.insert(4, 'о'); // Cyrillic 'о' U+043E — visually identical
    });
    expect(resolveClientAnchor(doc, demo.anchor)).toBe('drift');
  });

  it('fail-closed (unverifiable) → ~ (rubric 7/8): span cannot resolve', () => {
    const { demo } = seededAnchor(0, 5);
    // Resolve the anchor against a DIFFERENT, empty doc: the relative positions do
    // not resolve, so the reader fails closed to DRIFT rather than a false ✓.
    const other = new ConversationDoc();
    expect(resolveClientAnchor(other, demo.anchor)).toBe('drift');
  });

  it('machine never certifies (rubric 2): the human capture mints only a human ✓', () => {
    const { demo } = seededAnchor(0, 5);
    // certifyClientAnchor hardcodes { kind: 'human' } — there is NO code path by which
    // the demo mints a non-human certifier.
    expect(demo.anchor.certifier.kind).toBe('human');
  });

  it('machine never certifies (rubric 2/9): the core refuses a non-human certifier', () => {
    const doc = new ConversationDoc().seed([
      { id: MSG, time: '10:00', kind: 'agent', who: 'hexi', text: TEXT },
    ]);
    const bodyPath = doc.bodyPath(MSG) as number[];
    const reader = new CovenantDocReaderProd(
      doc.doc,
      { path: bodyPath, start: 0, end: 5 },
      { resolveRoot: conversationContentRoot },
    );
    // Reach past certifyClientAnchor and hand the primitive an AGENT certifier as
    // untyped data — the round the forged-cert case (rubric 9) turns on. The core
    // refuses it: no row, no ✓, ever.
    const forged = certifyAnchor(reader, {
      objectId: MSG,
      roomId: ROOM,
      certifier: { kind: 'agent', userId: 'a-hexi' } as never,
      certifiedAt: new Date().toISOString(),
    });
    expect(forged).toBeNull();
  });
});
