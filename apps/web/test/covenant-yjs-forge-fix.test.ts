import { type CovenantAnchor, certifyAnchor } from '@atrium/core';
import type { Database } from '@atrium/db';
import { afterEach, describe, expect, it } from 'vitest';
import { XmlElement as YXmlElement, XmlText as YXmlText } from 'yjs';
import { anchorCertifies, precomputedGlyphResolver } from '@/lib/covenant-read';
import { readerForLiveDoc } from '@/lib/covenant-reader';
import { DisplayFreshnessGate } from '@/lib/display-freshness';
import { liveCovenantDoc } from '@/lib/live-covenant-doc';
import { roomCovenantReads } from '@/lib/room-covenant-reads';
import {
  clearServerReplicas,
  registerServerReplica,
  ServerRoomReplica,
  type WriterIdentity,
} from '@/lib/server-room-replica';
import type { ChatMsg } from '../app/prototype/types';
import { ConversationDoc } from '../app/prototype/yjs-conversation';

/* ═══════════════════════════════════════════════════════════════════════════
 * #220 / T6 — THE COVENANT-SOUNDNESS FIX ROUND, as the attacks (regression tests).
 *
 * The cross-lineage gauntlet found one root defect with two exploits: the object
 * identity a `✓` renders under is DECOUPLED from the content the anchor signed.
 *
 *   F1 (CRITICAL, agent-reachable false-`✓`): the glyph is keyed by `message.id` and
 *       the DISPLAY resolves a line's body by the mutable `mid` attribute, but the
 *       anchor's sweep re-resolves FROZEN relative positions (CRDT identity, never
 *       `mid`). An agent appends hostile text with `mid=A` and retargets the genuine
 *       block's `mid` away → `body(A)` returns the hostile text while the anchor still
 *       resolves the untouched genuine span `ok` → `✓` over unsigned content.
 *   F2 (HIGH, human-reachable forge): `certifyYjsSpanAction` accepts a client `objectId`
 *       and `bodyPath` independently; nothing checks `objectId` names the block at
 *       `bodyPath` → certify `objectId=A` over `bodyPath=M` → `✓` on A's line, M's content.
 *   Freshness (MEDIUM): a live `✓` can stand over already-edited text until the client
 *       poke → server re-verdict lands.
 *
 * These pin each attack and prove the fix demotes it to `~` (fail-closed).
 * ═════════════════════════════════════════════════════════════════════════ */

const ROOM = 'room_forge';
const ALICE: WriterIdentity = { userId: 'u_alice', principalKind: 'human' };
const CERT_ALICE = { kind: 'human', userId: 'u_alice' } as const;
const AT = '2026-08-18T12:00:00.000Z';
const NO_LAZY_START = { acquire: async () => {} } as const;

afterEach(() => clearServerReplicas());

function msg(id: string, text: string): ChatMsg {
  return { id, time: '10:00', kind: 'human', who: 'Alice', text };
}

/** A caught-up replica of one room, seeded with one authored rich-text body under `id`. */
function seedReplica(id: string, text: string): ServerRoomReplica {
  const replica = new ServerRoomReplica().seedAuthored([msg(id, text)], ALICE);
  registerServerReplica(ROOM, replica);
  return replica;
}

/** Derive a REAL anchor the way the certify gate does — server reader over the replica. */
function deriveAnchor(
  replica: ServerRoomReplica,
  objectId: string,
  span: { start: number; end: number },
): CovenantAnchor {
  const path = replica.conversation.bodyPath(objectId) as number[];
  const live = liveCovenantDoc(ROOM);
  const reader = readerForLiveDoc(
    live.provider,
    { path, start: span.start, end: span.end },
    live.options,
  );
  const anchor = certifyAnchor(reader, {
    objectId,
    roomId: ROOM,
    certifier: CERT_ALICE,
    certifiedAt: AT,
  });
  if (anchor === null) throw new Error('deriveAnchor: capture failed');
  return anchor;
}

/** The `covenant_anchors` ROW a real anchor persists as (what `loadCovenantAnchor` reads). */
function rowFrom(anchor: CovenantAnchor) {
  return {
    id: 'anchor_row_1',
    roomId: anchor.roomId,
    objectId: anchor.objectId,
    revision: anchor.revision,
    relStart: anchor.relStart,
    relEnd: anchor.relEnd,
    stateVector: anchor.stateVector,
    deleteSet: anchor.deleteSet,
    enclosedItems: anchor.enclosedItems,
    renderedDigest: anchor.renderedDigest,
    certifierKind: anchor.certifier.kind,
    certifierId: anchor.certifier.userId,
    certifiedAt: new Date(anchor.certifiedAt),
    createdAt: new Date(anchor.certifiedAt),
  };
}

function stubDb(rows: unknown[]): Pick<Database, 'select'> {
  const chain = { from: () => chain, where: () => chain, limit: () => Promise.resolve(rows) };
  return { select: () => chain } as unknown as Pick<Database, 'select'>;
}

/** The genuine `<message mid=id>` block in a conversation's content share. */
function blockFor(convo: ConversationDoc, id: string): YXmlElement {
  for (const child of convo.contentFragment().toArray()) {
    if (child instanceof YXmlElement && child.getAttribute('mid') === id) return child;
  }
  throw new Error(`no content block for ${id}`);
}

/**
 * THE F1 MID-REMAP ATTACK, as a peer with ydoc write access performs it: append a
 * hostile block carrying `mid=victimId` with hostile text, and retarget the genuine
 * block's `mid` AWAY — so `body(victimId)` now resolves to the hostile block while the
 * anchor's frozen relative positions still resolve the untouched genuine span.
 */
function midRemapAttack(convo: ConversationDoc, victimId: string, hostile: string): void {
  const genuine = blockFor(convo, victimId);
  const frag = convo.contentFragment();
  convo.doc.transact(() => {
    const block = new YXmlElement('message');
    const xtext = new YXmlText();
    frag.insert(frag.length, [block]);
    block.setAttribute('mid', victimId);
    block.insert(0, [xtext]);
    xtext.insert(0, hostile);
    // Retarget the genuine block away, so the ONLY `mid=victimId` block is the hostile one.
    genuine.setAttribute('mid', `${victimId}-evicted`);
  });
}

describe('F1 (CRITICAL) — the mid-remap forge is demoted to ~ (display↔sign identity guard)', () => {
  it('BASELINE: an untampered certified span resolves ok (the guard does not over-demote)', async () => {
    const replica = seedReplica('m_alice', 'Ready ship it now');
    const anchor = deriveAnchor(replica, 'm_alice', { start: 0, end: 5 }); // "Ready"
    const reads = await roomCovenantReads(
      stubDb([rowFrom(anchor)]),
      ROOM,
      ['m_alice'],
      NO_LAZY_START,
    );
    expect(reads.m_alice).toBe('ok');
    expect(anchorCertifies(precomputedGlyphResolver(reads), 'm_alice')).toBe(true);
  });

  it('a mid-remap that swaps the displayed body for hostile text ⇒ drift (~), never a false ✓', async () => {
    const replica = seedReplica('m_alice', 'Ready ship it now');
    const anchor = deriveAnchor(replica, 'm_alice', { start: 0, end: 5 });

    // Sanity: pre-attack the display binds the anchor (same Y.XmlText).
    expect(replica.conversation.displayBindsAnchor('m_alice', anchor)).toBe(true);

    // The agent forges: body('m_alice') now returns hostile text; the anchor's frozen
    // positions still resolve the (untouched, digest-identical) genuine span.
    midRemapAttack(replica.conversation, 'm_alice', 'DELETE PRODUCTION NOW');
    expect(replica.conversation.body('m_alice')?.toString()).toBe('DELETE PRODUCTION NOW');
    // The identity binding is now BROKEN — the sole enforcement point for the sweep/read.
    expect(replica.conversation.displayBindsAnchor('m_alice', anchor)).toBe(false);

    // So the read path serves ~, not the forged ✓ — even though the anchor's own span
    // digest is unchanged (the attack never touched the genuine XmlText).
    const reads = await roomCovenantReads(
      stubDb([rowFrom(anchor)]),
      ROOM,
      ['m_alice'],
      NO_LAZY_START,
    );
    expect(reads.m_alice).toBe('drift');
    expect(anchorCertifies(precomputedGlyphResolver(reads), 'm_alice')).toBe(false);
  });

  it('a mid retargeted away with NO planted block (body absent) ⇒ drift (~), fail-closed', async () => {
    const replica = seedReplica('m_alice', 'Ready ship it now');
    const anchor = deriveAnchor(replica, 'm_alice', { start: 0, end: 5 });
    // Just evict the genuine block's mid: body('m_alice') is now null.
    replica.conversation.doc.transact(() => {
      blockFor(replica.conversation, 'm_alice').setAttribute('mid', 'm_alice-evicted');
    });
    expect(replica.conversation.body('m_alice')).toBeNull();
    expect(replica.conversation.displayBindsAnchor('m_alice', anchor)).toBe(false);
    const reads = await roomCovenantReads(
      stubDb([rowFrom(anchor)]),
      ROOM,
      ['m_alice'],
      NO_LAZY_START,
    );
    expect(reads.m_alice).toBe('drift');
  });
});

describe('F2 (HIGH) — cross-certify is refused: objectId must name the block at bodyPath', () => {
  it('bodyPathNamesDisplayBody is TRUE for a legit self-certify and FALSE for a cross-certify', () => {
    const convo = new ConversationDoc();
    convo.append(msg('m_alice', 'Alice authored this line'));
    convo.append(msg('m_mallory', 'Mallory authored this other line'));
    const pathAlice = convo.bodyPath('m_alice') as number[];
    const pathMallory = convo.bodyPath('m_mallory') as number[];

    // Legit: the object id names the block at its own bodyPath.
    expect(convo.bodyPathNamesDisplayBody('m_alice', pathAlice)).toBe(true);
    expect(convo.bodyPathNamesDisplayBody('m_mallory', pathMallory)).toBe(true);

    // The F2 forge: certify objectId=A while signing message M's body (and the reverse).
    // The glyph would paint on A's line over M's content — refused.
    expect(convo.bodyPathNamesDisplayBody('m_alice', pathMallory)).toBe(false);
    expect(convo.bodyPathNamesDisplayBody('m_mallory', pathAlice)).toBe(false);
  });

  it('a bodyPath that resolves to no live body ⇒ FALSE (fail-closed)', () => {
    const convo = new ConversationDoc();
    convo.append(msg('m_alice', 'Alice authored this line'));
    expect(convo.bodyPathNamesDisplayBody('m_alice', [99])).toBe(false); // no such block index
    expect(convo.bodyPathNamesDisplayBody('m_absent', convo.bodyPath('m_alice') as number[])).toBe(
      false,
    ); // objectId has no displayed body
  });
});

describe('Freshness (MEDIUM) — no ✓ over content newer than the verdict', () => {
  it('withholds ✓ the instant displayed text changes, and restores it only on a fresh verdict', () => {
    const gate = new DisplayFreshnessGate();
    const verdictA = Symbol('verdict-1'); // a covenant_status delta / resolver identity

    // A verdict lands over the certified body "Ready ship it now".
    gate.onRender(verdictA, [{ id: 'A', text: 'Ready ship it now' }]);
    expect(gate.fresh('A', 'Ready ship it now')).toBe(true); // ✓ may show

    // An in-range edit changes the displayed text with NO new verdict (same token). The
    // gate must WITHHOLD ✓ — no ✓ over already-edited text at any frame.
    gate.onRender(verdictA, [{ id: 'A', text: 'ReXady ship it now' }]);
    expect(gate.fresh('A', 'ReXady ship it now')).toBe(false);

    // Only a genuinely newer verdict re-baselines the current content and restores freshness.
    const verdictB = Symbol('verdict-2');
    gate.onRender(verdictB, [{ id: 'A', text: 'ReXady ship it now' }]);
    expect(gate.fresh('A', 'ReXady ship it now')).toBe(true);
  });

  it('an id with no captured verdict reads stale (fail-closed)', () => {
    const gate = new DisplayFreshnessGate();
    expect(gate.fresh('A', 'anything')).toBe(false); // no verdict folded yet ⇒ ~
    gate.onRender(Symbol('v'), [{ id: 'A', text: 'x' }]);
    expect(gate.fresh('B', 'y')).toBe(false); // a different, un-verdicted id ⇒ ~
  });
});
