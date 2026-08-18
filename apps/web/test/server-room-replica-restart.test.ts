import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ServerRoomReplica, type WriterIdentity } from '@/lib/server-room-replica';
import type { ChatMsg } from '../app/prototype/types';
import { ConversationDoc } from '../app/prototype/yjs-conversation';

/* ═══════════════════════════════════════════════════════════════════════════
 * E3 (#203) — AUTHORSHIP SURVIVES A COLD RESTART VIA DATA, RANGE-EXACT.
 *
 * The load-bearing property: a replica rebuilt from the durable stream after a
 * restart replays each row's PERSISTED writer stamp (E2's `writer_user_id` /
 * `writer_kind`, migration 0054) into the ledger as it folds the row, so
 * `authenticatedAuthorOf` returns the ORIGINAL writers — never fail-closed-unknown.
 *
 * These are the in-memory proofs of the replay mechanics (`catchUp(op, writer)`);
 * `integration/web/server-replica-restart.test.ts` proves the same end-to-end over
 * a REAL Postgres `ydoc_updates` stream written through the E2 door.
 * ═════════════════════════════════════════════════════════════════════════ */

const ALICE: WriterIdentity = { userId: 'u_alice', principalKind: 'human' };
const BOB: WriterIdentity = { userId: 'u_bob', principalKind: 'human' };
const MALLORY: WriterIdentity = { userId: 'u_mallory', principalKind: 'human' };
const HEXI: WriterIdentity = { userId: 'agent_hexi', principalKind: 'agent' };

function msg(id: string, text: string): ChatMsg {
  return { id, time: '10:00', kind: 'human', who: 'you', text };
}

describe('authorship survives a cold restart — the stamp is replayed into the ledger', () => {
  it('a replica rebuilt from persisted rows returns the ORIGINAL writers (not unknown)', () => {
    // Alice and Bob each write a message (two durable rows, from two clients).
    const alice = new ConversationDoc();
    alice.append(msg('m1', 'ship the migration'));
    const rowAlice = Y.encodeStateAsUpdate(alice.doc);

    const bob = new ConversationDoc();
    Y.applyUpdate(bob.doc, rowAlice);
    bob.append(msg('m2', 'reviewed and approved'));
    const rowBob = Y.encodeStateAsUpdate(bob.doc, Y.encodeStateVector(alice.doc));

    // COLD RESTART: a fresh process, an empty ledger, rebuilding from the rows +
    // their persisted stamps.
    const restarted = new ServerRoomReplica();
    restarted.catchUp(rowAlice, ALICE);
    restarted.catchUp(rowBob, BOB);

    expect(restarted.conversation.body('m1')?.toString()).toBe('ship the migration');
    expect(restarted.conversation.body('m2')?.toString()).toBe('reviewed and approved');
    // The whole point: NOT null (the pre-E3 fail-closed-unknown), the original writers.
    expect(restarted.authenticatedAuthorOf('m1')).toEqual(ALICE);
    expect(restarted.authenticatedAuthorOf('m2')).toEqual(BOB);
  });

  it('an agent stamp rides through the replay (principalKind is data, not guessed)', () => {
    const hexi = new ConversationDoc();
    hexi.append({ id: 'a1', time: '10:00', kind: 'agent', who: 'hexi', text: 'the reading' });
    const row = Y.encodeStateAsUpdate(hexi.doc);

    const restarted = new ServerRoomReplica();
    restarted.catchUp(row, HEXI);
    expect(restarted.authenticatedAuthorOf('a1')).toEqual(HEXI);
  });

  it('a system row (no authenticated author) folds content WITHOUT authorship — fail-closed', () => {
    const c = new ConversationDoc();
    c.append(msg('m1', 'arrived with no author'));
    const row = Y.encodeStateAsUpdate(c.doc);

    const restarted = new ServerRoomReplica();
    restarted.catchUp(row, null); // a `system` row maps to a null writer
    expect(restarted.conversation.body('m1')?.toString()).toBe('arrived with no author');
    expect(restarted.authenticatedAuthorOf('m1')).toBeNull();
  });
});

describe('the replay is RANGE-EXACT — a row’s stamp lands on its OWN items, never a neighbor’s', () => {
  it('two contiguous rows on ONE client attribute to their OWN row’s writer (off-by-one pin)', () => {
    // One client (one clientID) writes m1 then m2 in two batches, so their clock
    // ranges are ADJACENT in the same client's clock space — the exact place an
    // off-by-one range would bleed one row's stamp onto the other's items.
    const convo = new ConversationDoc();
    convo.append(msg('m1', 'the first reading'));
    const rowA = Y.encodeStateAsUpdate(convo.doc);
    const svA = Y.encodeStateVector(convo.doc);
    convo.append(msg('m2', 'the second reading'));
    const rowB = Y.encodeStateAsUpdate(convo.doc, svA); // only m2's items, starting at A's frontier

    const restarted = new ServerRoomReplica();
    restarted.catchUp(rowA, ALICE); // rowA's declared range ⇒ Alice
    restarted.catchUp(rowB, BOB); // rowB's declared range ⇒ Bob

    // Range-exact: m1's content is entirely Alice's, m2's entirely Bob's. An
    // off-by-one that let rowB's stamp reach one clock into rowA's range would make
    // m1 CONTESTED (null); one that let rowA's stamp reach into rowB would make m2
    // contested. Both being a clean single writer is the boundary pinned exactly.
    expect(restarted.authenticatedAuthorOf('m1')).toEqual(ALICE);
    expect(restarted.authenticatedAuthorOf('m2')).toEqual(BOB);
  });

  it('the ledger is ORDER-INDEPENDENT — replaying rows in REVERSE yields the same attribution', () => {
    // rowB causally depends on rowA (m2's clocks follow m1's on the same client).
    const convo = new ConversationDoc();
    convo.append(msg('m1', 'the first reading'));
    const rowA = Y.encodeStateAsUpdate(convo.doc);
    const svA = Y.encodeStateVector(convo.doc);
    convo.append(msg('m2', 'the second reading'));
    const rowB = Y.encodeStateAsUpdate(convo.doc, svA);

    // Replay B BEFORE A. B's structs are pending (their dep is not integrated yet),
    // so an after-minus-before state-vector delta would attribute NOTHING to Bob and
    // then mis-charge B's items to A when A's apply integrates them. Recording each
    // row's OWN declared range from the bytes makes order irrelevant.
    const restarted = new ServerRoomReplica();
    restarted.catchUp(rowB, BOB);
    restarted.catchUp(rowA, ALICE);

    expect(restarted.conversation.body('m1')?.toString()).toBe('the first reading');
    expect(restarted.conversation.body('m2')?.toString()).toBe('the second reading');
    expect(restarted.authenticatedAuthorOf('m1')).toEqual(ALICE);
    expect(restarted.authenticatedAuthorOf('m2')).toEqual(BOB);
  });

  it('re-consuming a row (a duplicate stream read) is a no-op — first-writer-wins holds', () => {
    const convo = new ConversationDoc();
    convo.append(msg('m1', 'the reading'));
    const row = Y.encodeStateAsUpdate(convo.doc);

    const restarted = new ServerRoomReplica();
    restarted.catchUp(row, ALICE);
    // The same row read again, and even (adversarially) with a different stamp: Yjs
    // dedupes the items and first-writer-wins keeps Alice — never re-homed.
    restarted.catchUp(row, MALLORY);
    expect(restarted.authenticatedAuthorOf('m1')).toEqual(ALICE);
  });
});

describe('a peer racing appends around a restart cannot poison replayed attribution', () => {
  it('a live authenticated write after catch-up gets the PEER’s items, never the replayed writer’s', () => {
    const alice = new ConversationDoc();
    alice.append(msg('m1', 'the original reading'));
    const row = Y.encodeStateAsUpdate(alice.doc);

    // Restart: catch up Alice's row.
    const restarted = new ServerRoomReplica();
    restarted.catchUp(row, ALICE);
    expect(restarted.authenticatedAuthorOf('m1')).toEqual(ALICE);

    // Mallory races an authenticated append of m2 right after the restart.
    const mallory = new ConversationDoc();
    Y.applyUpdate(mallory.doc, Y.encodeStateAsUpdate(restarted.doc));
    mallory.append(msg('m2', 'the peer reading'));
    restarted.applyAuthenticatedUpdate(
      Y.encodeStateAsUpdate(mallory.doc, Y.encodeStateVector(restarted.doc)),
      MALLORY,
    );

    // m1's replayed authorship is untouched; m2 is Mallory's own.
    expect(restarted.authenticatedAuthorOf('m1')).toEqual(ALICE);
    expect(restarted.authenticatedAuthorOf('m2')).toEqual(MALLORY);
  });

  it('a peer’s byte-replay of a replayed row does not re-home it', () => {
    const alice = new ConversationDoc();
    alice.append(msg('m1', 'the original reading'));
    const row = Y.encodeStateAsUpdate(alice.doc);

    const restarted = new ServerRoomReplica();
    restarted.catchUp(row, ALICE);
    // Mallory replays Alice's exact bytes over her own authenticated connection.
    restarted.applyAuthenticatedUpdate(row, MALLORY);
    expect(restarted.authenticatedAuthorOf('m1')).toEqual(ALICE);
  });
});

describe('the freshness position advances one per consumed row', () => {
  it('consumedStreamPosition equals the number of rows folded in', () => {
    const convo = new ConversationDoc();
    convo.append(msg('m1', 'one'));
    const rowA = Y.encodeStateAsUpdate(convo.doc);
    const svA = Y.encodeStateVector(convo.doc);
    convo.append(msg('m2', 'two'));
    const rowB = Y.encodeStateAsUpdate(convo.doc, svA);

    const restarted = new ServerRoomReplica();
    expect(restarted.consumedStreamPosition()).toBe(0);
    restarted.catchUp(rowA, ALICE);
    expect(restarted.consumedStreamPosition()).toBe(1);
    restarted.catchUp(rowB, BOB);
    expect(restarted.consumedStreamPosition()).toBe(2);
    // A live authenticated write is content, NOT a consumed stream row — position holds.
    const peer = new ConversationDoc();
    Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(restarted.doc));
    peer.append(msg('m3', 'three'));
    restarted.applyAuthenticatedUpdate(
      Y.encodeStateAsUpdate(peer.doc, Y.encodeStateVector(restarted.doc)),
      MALLORY,
    );
    expect(restarted.consumedStreamPosition()).toBe(2);
  });
});
