import { type CovenantAnchor, certifyAnchor, resolveCovenant } from '@atrium/core';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { readerForLiveDoc } from '@/lib/covenant-reader';
import { liveCovenantDoc } from '@/lib/live-covenant-doc';
import {
  clearServerReplicas,
  registerServerReplica,
  ServerRoomReplica,
  type WriterIdentity,
} from '@/lib/server-room-replica';
import { InMemoryConversationHub } from '../app/prototype/conversation-transport';
import type { ChatMsg } from '../app/prototype/types';
import { ConversationDoc } from '../app/prototype/yjs-conversation';

/* ═══════════════════════════════════════════════════════════════════════════
 * P6F-2 / #196 — the SERVER-AUTHORITATIVE REPLICA + the live covenant-doc handle.
 *
 * Proves the acceptance test end-to-end at the seam the sandbox CAN stand up (the
 * real Electric durable stream cannot — see server-room-replica.ts's named gap):
 *
 *   - certify goes from `derive_failed` → a REAL anchor, server-derived from the
 *     authoritative replica (not client bytes);
 *   - the replica converges with client edits;
 *   - an ABSENT share (and an unregistered room) fails CLOSED;
 *   - the anchor resolves the CORRECT span under message reorder / body split /
 *     merge (SL-2 forward-note);
 *   - an AUTHENTICATED writer's identity — not a peer-crafted client id, a
 *     byte-replay, or CRDT position — determines authorship, and a peer cannot
 *     inherit another writer's authorship.
 *
 * Each security proof is MUTATION-PINNED: flip the input and the protection still
 * fires; a peer's forgery reads as its OWN authorship or as unknown, never the
 * victim's.
 * ═════════════════════════════════════════════════════════════════════════ */

const ROOM = 'room_p6f2';
const ALICE: WriterIdentity = { userId: 'u_alice', principalKind: 'human' };
const HEXI: WriterIdentity = { userId: 'agent_hexi', principalKind: 'agent' };
const MALLORY: WriterIdentity = { userId: 'u_mallory', principalKind: 'human' };
const CERT_ALICE = { kind: 'human', userId: 'u_alice' } as const;
const AT = '2026-08-17T12:00:00.000Z';

afterEach(() => clearServerReplicas());

/** A message with a rich-text body. */
function msg(id: string, text: string, who = 'you'): ChatMsg {
  return { id, time: '10:00', kind: 'human', who, text };
}

/**
 * Build the reader EXACTLY as `certifyObjectSpanAction` does — through
 * `liveCovenantDoc(roomId)` and `readerForLiveDoc(provider, selection, options)` —
 * so the test exercises the real production wiring, not a hand-made reader.
 */
function actionReader(roomId: string, bodyPath: number[], span: { start: number; end: number }) {
  const live = liveCovenantDoc(roomId);
  return readerForLiveDoc(
    live.provider,
    { path: bodyPath, start: span.start, end: span.end },
    live.options,
  );
}

/** The exact derive-and-sign the certify gate performs. `null` ⇒ `derive_failed`. */
function deriveAnchor(reader: ReturnType<typeof actionReader>): CovenantAnchor | null {
  return certifyAnchor(reader, {
    objectId: 'o_span',
    roomId: ROOM,
    certifier: CERT_ALICE,
    certifiedAt: AT,
  });
}

/** The whole-doc diff a client would ship to the server for a room's replica. */
function clientDiff(clientDoc: Y.Doc, replica: ServerRoomReplica): Uint8Array {
  return Y.encodeStateAsUpdate(clientDoc, Y.encodeStateVector(replica.doc));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. CERTIFY: `derive_failed` → a REAL anchor against the authoritative replica.
// ─────────────────────────────────────────────────────────────────────────────

describe('certify goes from derive_failed to a real anchor, server-derived from the replica', () => {
  it('an UNREGISTERED room fails closed: the provider is null and derivation refuses (derive_failed)', () => {
    // No replica registered — exactly the pre-P6F-2 behaviour, still fail-closed.
    const reader = actionReader(ROOM, [0, 0], { start: 0, end: 4 });
    expect(liveCovenantDoc(ROOM).provider()).toBeNull();
    expect(deriveAnchor(reader)).toBeNull(); // ⇒ the gate returns derive_failed
  });

  it('a live seeded replica yields a REAL anchor (renderedDigest + SV), and resolves OK', () => {
    const replica = new ServerRoomReplica().seedAuthored([msg('m1', 'ship the migration')], ALICE);
    registerServerReplica(ROOM, replica);

    const path = replica.conversation.bodyPath('m1');
    expect(path).not.toBeNull();
    const reader = actionReader(ROOM, path as number[], { start: 0, end: 4 }); // 'ship'

    const anchor = deriveAnchor(reader);
    // NOT derive_failed — a real, server-derived anchor with real signed fields.
    expect(anchor).not.toBeNull();
    expect((anchor as CovenantAnchor).renderedDigest).toMatch(/./);
    expect((anchor as CovenantAnchor).stateVector).toMatch(/./);
    expect((anchor as CovenantAnchor).relStart).toMatch(/./);

    // It reads OK against the SAME authoritative replica, and DRIFTs when the
    // certified sub-range is edited on the authority.
    expect(resolveCovenant(reader, anchor as CovenantAnchor).covenantStatus).toBe('ok');
    replica.conversation.body('m1')?.insert(2, 'X');
    expect(resolveCovenant(reader, anchor as CovenantAnchor).covenantStatus).toBe('drift');
  });

  it('MUTATION PIN — the certify is derived from the REPLICA, not the request: a client-only edit is invisible until it reaches the replica', () => {
    const replica = new ServerRoomReplica().seedAuthored([msg('m1', 'ship the migration')], ALICE);
    registerServerReplica(ROOM, replica);
    const path = replica.conversation.bodyPath('m1') as number[];
    const reader = actionReader(ROOM, path, { start: 0, end: 4 });
    const anchor = deriveAnchor(reader) as CovenantAnchor;
    expect(anchor).not.toBeNull();

    // A client mutates its OWN doc but never ships it. The authority is unchanged,
    // so the anchor stays OK — the server signed the replica, never client bytes.
    const client = new ConversationDoc();
    Y.applyUpdate(client.doc, Y.encodeStateAsUpdate(replica.doc));
    client.body('m1')?.insert(2, 'X');
    expect(resolveCovenant(reader, anchor).covenantStatus).toBe('ok');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. AN ABSENT SHARE FAILS CLOSED.
// ─────────────────────────────────────────────────────────────────────────────

describe('an absent / empty conversation-content share fails closed', () => {
  it('a registered but EMPTY replica has a null authoritative doc ⇒ derive_failed', () => {
    const replica = new ServerRoomReplica(); // seeded with nothing
    registerServerReplica(ROOM, replica);
    expect(replica.authoritativeDoc()).toBeNull();
    expect(liveCovenantDoc(ROOM).provider()).toBeNull();
    const reader = actionReader(ROOM, [0, 0], { start: 0, end: 4 });
    expect(deriveAnchor(reader)).toBeNull();
  });

  it('a torn-down replica fails closed too', () => {
    const replica = new ServerRoomReplica().seedAuthored([msg('m1', 'hello world')], ALICE);
    registerServerReplica(ROOM, replica);
    expect(replica.authoritativeDoc()).not.toBeNull();
    replica.destroy();
    expect(replica.authoritativeDoc()).toBeNull();
    expect(liveCovenantDoc(ROOM).provider()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE REPLICA CONVERGES WITH CLIENT EDITS.
// ─────────────────────────────────────────────────────────────────────────────

describe('the server replica converges with client edits', () => {
  it('an authenticated client update lands on the replica and is certifiable', () => {
    const replica = new ServerRoomReplica();
    registerServerReplica(ROOM, replica);

    // A client composes a message locally and ships the diff over its authenticated
    // connection; the server folds it into the authoritative replica.
    const client = new ConversationDoc();
    client.append(msg('m1', 'converged body'));
    replica.applyAuthenticatedUpdate(clientDiff(client.doc, replica), ALICE);

    expect(replica.conversation.body('m1')?.toString()).toBe('converged body');
    const path = replica.conversation.bodyPath('m1') as number[];
    const reader = actionReader(ROOM, path, { start: 0, end: 9 }); // 'converged'
    expect(resolveCovenant(reader, deriveAnchor(reader) as CovenantAnchor).covenantStatus).toBe(
      'ok',
    );
  });

  it('convergence also flows over the in-memory hub (the durable-stream stand-in)', () => {
    const hub = new InMemoryConversationHub(new Y.Doc());
    const replica = new ServerRoomReplica();
    const client = new ConversationDoc();
    replica.connect(hub.transport());
    client.connect(hub.transport());

    client.append(msg('h1', 'history body'));
    expect(replica.conversation.body('h1')?.toString()).toBe('history body');

    // …and a later in-body edit converges into the replica live.
    client.body('h1')?.insert(0, 'the ');
    expect(replica.conversation.body('h1')?.toString()).toBe('the history body');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE ANCHOR RESOLVES THE CORRECT SPAN UNDER REORDER / SPLIT / MERGE (SL-2).
// ─────────────────────────────────────────────────────────────────────────────

describe('the anchor resolves the correct span under message reorder / body split / merge', () => {
  it('reordering OTHER messages and editing OTHER bodies does not move a certified span', () => {
    const replica = new ServerRoomReplica().seedAuthored(
      [msg('m1', 'first message'), msg('m2', 'ship the migration'), msg('m3', 'third message')],
      ALICE,
    );
    registerServerReplica(ROOM, replica);

    const path = replica.conversation.bodyPath('m2') as number[];
    const reader = actionReader(ROOM, path, { start: 0, end: 4 }); // 'ship' in m2
    const anchor = deriveAnchor(reader) as CovenantAnchor;
    expect(resolveCovenant(reader, anchor).covenantStatus).toBe('ok');

    // REORDER — a new message arrives at the front of the index (relative positions
    // in m2's Y.XmlText are unaffected).
    const client = new ConversationDoc();
    Y.applyUpdate(client.doc, Y.encodeStateAsUpdate(replica.doc));
    const arr = client.doc.getArray<string>('messages');
    client.doc.transact(() => {
      arr.insert(0, [JSON.stringify({ id: 'm0', time: '09:59', kind: 'human', who: 'you' })]);
    });
    // SPLIT / MERGE a DIFFERENT body: edit m1 and m3 heavily.
    client.body('m1')?.insert(0, 'PREFIX ');
    client.body('m3')?.delete(0, 5);
    replica.applyAuthenticatedUpdate(clientDiff(client.doc, replica), ALICE);

    // The anchor still resolves m2's [0,4) — 'ship' — OK. Span precision holds.
    const readerAfter = actionReader(ROOM, replica.conversation.bodyPath('m2') as number[], {
      start: 0,
      end: 4,
    });
    expect(resolveCovenant(readerAfter, anchor).covenantStatus).toBe('ok');
  });

  it('an edit BEFORE the certified span within the SAME body keeps the span (relative positions ride along)', () => {
    const replica = new ServerRoomReplica().seedAuthored([msg('m1', 'alpha beta gamma')], ALICE);
    registerServerReplica(ROOM, replica);
    // Certify 'gamma' (offset 11..16) via relative positions.
    const reader = actionReader(ROOM, replica.conversation.bodyPath('m1') as number[], {
      start: 11,
      end: 16,
    });
    const anchor = deriveAnchor(reader) as CovenantAnchor;
    expect(resolveCovenant(reader, anchor).covenantStatus).toBe('ok');

    // Insert text BEFORE the span — a split/merge upstream. The relative anchor
    // follows the content, so it still resolves 'gamma' OK, not a shifted window.
    replica.conversation.body('m1')?.insert(0, 'ZZZ ');
    expect(resolveCovenant(reader, anchor).covenantStatus).toBe('ok');
    // And editing INSIDE the certified 'gamma' drifts it.
    replica.conversation.body('m1')?.insert(15, 'X'); // 11 + 'ZZZ '(4) = offset 15 is inside gamma
    expect(resolveCovenant(reader, anchor).covenantStatus).toBe('drift');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. AUTHENTICATED WRITER — not a crafted client id / replay / position — decides
//    authorship, and a peer cannot inherit another writer's authorship.
// ─────────────────────────────────────────────────────────────────────────────

describe('the authenticated writer determines authorship (a peer cannot inherit it)', () => {
  it('authorship is the authenticated writer of the content seat', () => {
    const replica = new ServerRoomReplica();
    const alice = new ConversationDoc();
    alice.append(msg('m1', 'the honest reading'));
    replica.applyAuthenticatedUpdate(clientDiff(alice.doc, replica), ALICE);

    const author = replica.authenticatedAuthorOf('m1');
    expect(author?.userId).toBe('u_alice');
    expect(author?.principalKind).toBe('human');
  });

  it('BYTE-REPLAY: a peer re-applies Alice’s exact update under its own identity — authorship stays Alice (Yjs dedupes; no re-attribution)', () => {
    const replica = new ServerRoomReplica();
    const alice = new ConversationDoc();
    alice.append(msg('m1', 'the honest reading'));
    const aliceBytes = clientDiff(alice.doc, replica);
    replica.applyAuthenticatedUpdate(aliceBytes, ALICE);
    expect(replica.authenticatedAuthorOf('m1')?.userId).toBe('u_alice');

    // Mallory replays Alice's identical bytes over Mallory's authenticated connection.
    replica.applyAuthenticatedUpdate(aliceBytes, MALLORY);
    // The item is deduped — no new items — so the ledger is untouched: still Alice.
    expect(replica.authenticatedAuthorOf('m1')?.userId).toBe('u_alice');
  });

  it('CLIENT-ID IMPERSONATION: items claiming Alice’s client number, delivered by Mallory, are authored by MALLORY (the client field buys nothing)', () => {
    const replica = new ServerRoomReplica();
    const alice = new ConversationDoc(new Y.Doc());
    alice.doc.clientID = 5;
    alice.append(msg('m1', 'alice content'));
    replica.applyAuthenticatedUpdate(clientDiff(alice.doc, replica), ALICE);
    expect(replica.authenticatedAuthorOf('m1')?.userId).toBe('u_alice');

    // Mallory catches up, then REUSES Alice's client id (5) to write NEW content —
    // the impersonation attempt. New clocks, delivered over Mallory's connection.
    const mallory = new ConversationDoc(new Y.Doc());
    Y.applyUpdate(mallory.doc, Y.encodeStateAsUpdate(replica.doc));
    mallory.doc.clientID = 5; // same as Alice — the forge
    mallory.append(msg('m2', 'mallory content posing as alice'));
    replica.applyAuthenticatedUpdate(clientDiff(mallory.doc, replica), MALLORY);

    // m2's content is authored by the authenticated DELIVERER (Mallory), NOT Alice,
    // even though its items carry client id 5. FLIP: were authorship read off the
    // client field, this would read 'u_alice' — the forgery. It reads Mallory.
    expect(replica.authenticatedAuthorOf('m2')?.userId).toBe('u_mallory');
    // …and Alice's real message is untouched.
    expect(replica.authenticatedAuthorOf('m1')?.userId).toBe('u_alice');
  });

  it('CRAFTED LOW CLIENT ID (positional/seat hijack): the peer that crafts the winning seat authors its OWN forgery — never the victim', () => {
    const replica = new ServerRoomReplica();
    // Alice writes m1 with a HIGH client id.
    const alice = new ConversationDoc(new Y.Doc());
    alice.doc.clientID = 9;
    alice.append(msg('m1', 'the genuine reading'));
    replica.applyAuthenticatedUpdate(clientDiff(alice.doc, replica), ALICE);
    expect(replica.authenticatedAuthorOf('m1')?.userId).toBe('u_alice');

    // Mallory catches up, then seats a COLLIDING body block for m1 with a LOWER
    // client id (1) — the "earliest item identity wins the seat" hijack.
    const mallory = new ConversationDoc(new Y.Doc());
    Y.applyUpdate(mallory.doc, Y.encodeStateAsUpdate(replica.doc));
    mallory.doc.clientID = 1; // lower than Alice's 9 → wins the genuine-seat rule
    mallory.doc.transact(() => {
      const frag = mallory.contentFragment();
      const block = new Y.XmlElement('message');
      const xtext = new Y.XmlText();
      frag.insert(0, [block]);
      block.setAttribute('mid', 'm1');
      block.insert(0, [xtext]);
      xtext.insert(0, 'FORGED READING');
    });
    replica.applyAuthenticatedUpdate(clientDiff(mallory.doc, replica), MALLORY);

    // The crafted seat may now win the CRDT genuine-seat resolution — but its
    // authenticated author is MALLORY (the crafter), never Alice. A peer crafting a
    // low client id becomes the author of its own forgery; it does not inherit
    // Alice's authorship.
    const author = replica.authenticatedAuthorOf('m1');
    expect(author?.userId).not.toBe('u_alice');
    expect(author?.userId).toBe('u_mallory');
  });

  it('UNATTRIBUTED (convergence-only) content reads as unknown — fail-closed, never a guessed author', () => {
    const replica = new ServerRoomReplica();
    const client = new ConversationDoc();
    client.append(msg('m1', 'arrived over the raw stream'));
    // catchUp is the convergence-only path (a durable-stream replay this process
    // did not authenticate) — content lands, authorship does not.
    replica.catchUp(Y.encodeStateAsUpdate(client.doc));
    expect(replica.conversation.body('m1')?.toString()).toBe('arrived over the raw stream');
    expect(replica.authenticatedAuthorOf('m1')).toBeNull();
  });

  it('an agent writer is carried faithfully (principalKind rides through)', () => {
    const replica = new ServerRoomReplica();
    const hexi = new ConversationDoc();
    hexi.append({ id: 'a1', time: '10:00', kind: 'agent', who: 'hexi', text: 'the reading' });
    replica.applyAuthenticatedUpdate(clientDiff(hexi.doc, replica), HEXI);
    expect(replica.authenticatedAuthorOf('a1')).toEqual(HEXI);
  });
});
