import { type CovenantAnchor, certifyAnchor } from '@atrium/core';
import { describe, expect, it } from 'vitest';
import { conversationContentRoot, ConversationDoc } from '@/app/prototype/yjs-conversation';
import { webCovenantReadAuthority } from '@/lib/covenant-read';
import { CovenantDocReaderProd } from '@/lib/covenant-reader';

/**
 * #220 / T6 — THE YJS-SPAN → COVENANT-OBJECT BINDING, at the covenant layer.
 *
 * This proves the certify-on-yjs SEMANTICS over the REAL live conversation substrate
 * (`ConversationDoc`, the `conversation-content` share the yjs surface renders and
 * writes), through the SAME resolution path the production certify action uses:
 *
 *   - the object id IS the message id (one-accepted-object-per-certified-span);
 *   - the span is resolved by `ConversationDoc.bodyPath(messageId)` + char offsets —
 *     exactly the `{ objectId, bodyPath, start, end }` the client sends and
 *     `certifyYjsSpanAction` derives the anchor from;
 *   - the flip is decided ENTIRELY by the span-scoped re-resolution against the anchor
 *     (`resolveCovenant`), so an in-range edit drifts and an out-of-range one does not;
 *   - re-validation is UNDO-ONLY (#213): an exact undo (delete the inserted item)
 *     restores `✓`, but a re-type of identical characters (new Yjs items) STAYS `~`.
 *
 * The DB-backed half of the binding (the `accepted_objects` row `ensureObject` mints so
 * the anchor's composite FK resolves, and the `covenant_status` projection the sweep
 * writes) is exercised end-to-end by the two-real-browser acceptance
 * (`e2e/two-browser-acceptance.spec.ts`, rubric 12). This unit test pins the
 * covenant meaning the gauntlet scrutinises, over the production reader and body shape.
 */

const ALICE = { kind: 'human', userId: 'u_alice' } as const;
const ROOM = 'room_t6';
const AT = '2026-08-18T12:00:00.000Z';

/** Seat a single human message and return the live doc + its message id. */
function docWithMessage(text: string): { doc: ConversationDoc; messageId: string } {
  const doc = new ConversationDoc();
  const messageId = 'm_span_1';
  doc.append({ id: messageId, time: '12:00', kind: 'human', who: 'Alice', text });
  return { doc, messageId };
}

/**
 * Certify a span of a message body EXACTLY as the yjs surface does: the object id is
 * the message id, the reader is bound to the `conversation-content` share at the
 * message's `bodyPath`, and the span is the human's [start, end).
 */
function certifySpan(
  doc: ConversationDoc,
  messageId: string,
  start: number,
  end: number,
): CovenantAnchor {
  const bodyPath = doc.bodyPath(messageId);
  if (bodyPath === null) throw new Error('the message has no resolvable body');
  const reader = new CovenantDocReaderProd(
    doc.doc,
    { path: bodyPath, start, end },
    { resolveRoot: conversationContentRoot },
  );
  const anchor = certifyAnchor(reader, {
    // THE BINDING: object id === message id (one object per certified span).
    objectId: messageId,
    roomId: ROOM,
    certifier: ALICE,
    certifiedAt: AT,
  });
  if (anchor === null) throw new Error('span capture failed');
  return anchor;
}

/** Resolve the anchor's CURRENT verdict against the live doc through a fresh authority. */
async function statusOf(doc: ConversationDoc, anchor: CovenantAnchor): Promise<string> {
  const reader = new CovenantDocReaderProd(doc.doc, undefined, {
    resolveRoot: conversationContentRoot,
  });
  const authority = webCovenantReadAuthority({
    loadAnchor: async () => anchor,
    reader,
    expectedRoomId: ROOM,
  });
  return (await authority.resolve(anchor.objectId)).covenantStatus;
}

describe('T6 yjs-span certify: the object id is the message id, the anchor binds the span', () => {
  it('a freshly certified span over an unchanged body resolves ok, bound to the message id', async () => {
    const { doc, messageId } = docWithMessage('Ready ship it now');
    const anchor = certifySpan(doc, messageId, 0, 5); // "Ready"
    expect(anchor.objectId).toBe(messageId);
    expect(await statusOf(doc, anchor)).toBe('ok');
  });

  it('an IN-RANGE peer edit drifts the span (✓→~)', async () => {
    const { doc, messageId } = docWithMessage('Ready ship it now');
    const anchor = certifySpan(doc, messageId, 0, 5);
    expect(await statusOf(doc, anchor)).toBe('ok');
    // A peer inserts a character INSIDE the certified [0,5) span.
    doc.body(messageId)?.insert(2, 'X'); // "ReXady ship it now"
    expect(await statusOf(doc, anchor)).toBe('drift');
  });

  it('an OUT-OF-RANGE peer edit leaves the span certified (✓ stays)', async () => {
    const { doc, messageId } = docWithMessage('Ready ship it now');
    const anchor = certifySpan(doc, messageId, 0, 5); // "Ready"
    expect(await statusOf(doc, anchor)).toBe('ok');
    // An edit AFTER the span boundary (in "ship it now") does not move the span.
    doc.body(messageId)?.insert(12, 'ZZ');
    expect(await statusOf(doc, anchor)).toBe('ok');
  });

  it('EXACT UNDO re-validates (delete the inserted item restores the original items → ✓)', async () => {
    const { doc, messageId } = docWithMessage('Ready ship it now');
    const anchor = certifySpan(doc, messageId, 0, 5);
    doc.body(messageId)?.insert(2, 'X'); // drift
    expect(await statusOf(doc, anchor)).toBe('drift');
    // The exact undo of the insert: delete the character that was inserted. The
    // original items are untouched, so the anchor's snapshot re-verifies.
    doc.body(messageId)?.delete(2, 1); // "Ready ship it now" again, original items
    expect(await statusOf(doc, anchor)).toBe('ok');
  });

  it('a RE-TYPE of identical characters STAYS ~ (undo-only, #213): new Yjs items are not the signed ones', async () => {
    const { doc, messageId } = docWithMessage('Ready ship it now');
    const anchor = certifySpan(doc, messageId, 0, 5);
    expect(await statusOf(doc, anchor)).toBe('ok');
    const body = doc.body(messageId);
    if (!body) throw new Error('no body');
    // Delete the whole certified span, then RE-TYPE the identical characters. The
    // rendered bytes match (revert-stable digest) but the CRDT items are NEW, so the
    // anchor's snapshot verification rejects it — a re-type never re-validates.
    body.delete(0, 5);
    expect(await statusOf(doc, anchor)).toBe('drift');
    body.insert(0, 'Ready');
    expect(await statusOf(doc, anchor)).toBe('drift');
  });

  it('flip-the-input: a SECOND independent reader at the same drifted span is never ok', async () => {
    const { doc, messageId } = docWithMessage('Ready ship it now');
    const anchor = certifySpan(doc, messageId, 0, 5);
    doc.body(messageId)?.insert(1, 'Q'); // drift inside the span
    // A fresh authority resolving before any warm cache also refuses ok.
    expect(await statusOf(doc, anchor)).toBe('drift');
    expect(await statusOf(doc, anchor)).not.toBe('ok');
  });
});
