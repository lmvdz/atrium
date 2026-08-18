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
    restarted.catchUp(rowAlice, ALICE, 1n);
    restarted.catchUp(rowBob, BOB, 2n);

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
    restarted.catchUp(row, HEXI, 1n);
    expect(restarted.authenticatedAuthorOf('a1')).toEqual(HEXI);
  });

  it('a system row (no authenticated author) folds content WITHOUT authorship — fail-closed', () => {
    const c = new ConversationDoc();
    c.append(msg('m1', 'arrived with no author'));
    const row = Y.encodeStateAsUpdate(c.doc);

    const restarted = new ServerRoomReplica();
    restarted.catchUp(row, null, 1n); // a `system` row maps to a null writer
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
    restarted.catchUp(rowA, ALICE, 1n); // rowA's declared range ⇒ Alice
    restarted.catchUp(rowB, BOB, 2n); // rowB's declared range ⇒ Bob

    // Range-exact: m1's content is entirely Alice's, m2's entirely Bob's. An
    // off-by-one that let rowB's stamp reach one clock into rowA's range would make
    // m1 CONTESTED (null); one that let rowA's stamp reach into rowB would make m2
    // contested. Both being a clean single writer is the boundary pinned exactly.
    expect(restarted.authenticatedAuthorOf('m1')).toEqual(ALICE);
    expect(restarted.authenticatedAuthorOf('m2')).toEqual(BOB);
  });

  it('ORDER-INDEPENDENT over the OVERLAP branch — a full-state row re-declaring an earlier writer’s structs attributes the ORIGINAL writer, either replay order', () => {
    // Alice (her own client) writes m1; her row declares client-Alice [0,n).
    const alice = new ConversationDoc();
    alice.append(msg('m1', 'the original reading'));
    const rowAlice = Y.encodeStateAsUpdate(alice.doc); // stream seq 1

    // Bob catches up Alice's content, writes m2, and — the reachable-in-theory case
    // this hardens against — appends a FULL-STATE update (not a delta). Bob's row
    // therefore DECLARES BOTH client-Bob's own new structs AND client-Alice's [0,n),
    // re-contained. A first-listed-match fold would let arrival order decide who owns
    // client-Alice's clocks; the earliest-stream-position rule must pin them to Alice.
    const bob = new ConversationDoc();
    Y.applyUpdate(bob.doc, rowAlice);
    bob.append(msg('m2', 'the reviewer reading'));
    const rowBobFull = Y.encodeStateAsUpdate(bob.doc); // FULL state, seq 2

    // The row's stream seq is INTRINSIC (seq 1 = Alice's, 2 = Bob's),
    // regardless of the order they are replayed in.
    const forward = new ServerRoomReplica();
    forward.catchUp(rowAlice, ALICE, 1n);
    forward.catchUp(rowBobFull, BOB, 2n);

    const reverse = new ServerRoomReplica();
    reverse.catchUp(rowBobFull, BOB, 2n); // Bob's full-state row replayed FIRST…
    reverse.catchUp(rowAlice, ALICE, 1n); // …then Alice's genuine row.

    for (const replica of [forward, reverse]) {
      expect(replica.conversation.body('m1')?.toString()).toBe('the original reading');
      expect(replica.conversation.body('m2')?.toString()).toBe('the reviewer reading');
      // m1's content is client-Alice's clocks, declared by BOTH rows — the earlier
      // stream row (Alice's, seq 1) wins: the original writer, both orders.
      expect(replica.authenticatedAuthorOf('m1')).toEqual(ALICE);
      // m2 is only Bob's, attributed to Bob.
      expect(replica.authenticatedAuthorOf('m2')).toEqual(BOB);
    }
  });

  it('re-consuming a row (a duplicate stream read at the SAME stream position) is a no-op — the original writer holds', () => {
    const convo = new ConversationDoc();
    convo.append(msg('m1', 'the reading'));
    const row = Y.encodeStateAsUpdate(convo.doc);

    const restarted = new ServerRoomReplica();
    restarted.catchUp(row, ALICE, 1n);
    // The same durable row (same stream seq) read again, and even (adversarially)
    // with a different stamp: the seq is already applied, so the second read is a
    // no-op — Alice is never re-homed, and the freshness position does not inflate.
    restarted.catchUp(row, MALLORY, 1n);
    expect(restarted.authenticatedAuthorOf('m1')).toEqual(ALICE);
    expect(restarted.consumedStreamPosition()).toBe(1n);
  });
});

describe('a peer racing appends around a restart cannot poison replayed attribution', () => {
  it('a live authenticated write after catch-up gets the PEER’s items, never the replayed writer’s', () => {
    const alice = new ConversationDoc();
    alice.append(msg('m1', 'the original reading'));
    const row = Y.encodeStateAsUpdate(alice.doc);

    // Restart: catch up Alice's row.
    const restarted = new ServerRoomReplica();
    restarted.catchUp(row, ALICE, 1n);
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
    restarted.catchUp(row, ALICE, 1n);
    // Mallory replays Alice's exact bytes over her own authenticated connection.
    restarted.applyAuthenticatedUpdate(row, MALLORY);
    expect(restarted.authenticatedAuthorOf('m1')).toEqual(ALICE);
  });
});

describe('the freshness position is the highest CONTIGUOUS seq, and a live apply never advances it', () => {
  it('consumedStreamPosition is the highest-CONTIGUOUS seq (NOT a row count), and a live authenticated apply holds it', () => {
    // Four seqs exist (1,2,3,4) but seq 3 is a GAP: fold seqs 1, 2, 4. A COUNT of
    // folded rows would read 3 (the old, tautological claim); the highest CONTIGUOUS
    // seq is 2 — seq 4 is stranded above the hole at 3. This is the property that
    // matters, distinct from the {1,3}-then-2 test below (which closes a gap): here the
    // gap PERSISTS and holds the position down even though a strictly-higher seq folded.
    const convo = new ConversationDoc();
    convo.append(msg('m1', 'one'));
    const row1 = Y.encodeStateAsUpdate(convo.doc);
    const sv1 = Y.encodeStateVector(convo.doc);
    convo.append(msg('m2', 'two'));
    const row2 = Y.encodeStateAsUpdate(convo.doc, sv1);
    const sv2 = Y.encodeStateVector(convo.doc);
    convo.append(msg('m3', 'three'));
    const row3 = Y.encodeStateAsUpdate(convo.doc, sv2); // will be folded at seq 4, leaving 3 a gap

    const restarted = new ServerRoomReplica();
    expect(restarted.consumedStreamPosition()).toBe(0n);
    restarted.catchUp(row1, ALICE, 1n);
    expect(restarted.consumedStreamPosition()).toBe(1n);
    restarted.catchUp(row2, BOB, 2n);
    expect(restarted.consumedStreamPosition()).toBe(2n);
    // Fold a row at seq 4 — three rows are now folded, but seq 3 is absent, so the
    // CONTIGUOUS position stays at 2, NOT the count of 3. (A size-based counter would
    // wrongly read 3 and could reach a head of 4 with the seq-3 hole still open.)
    restarted.catchUp(row3, ALICE, 4n);
    expect(restarted.consumedStreamPosition()).toBe(2n);

    // A live authenticated write is content, NOT a consumed stream row — position holds.
    const peer = new ConversationDoc();
    Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(restarted.doc));
    peer.append(msg('m4', 'four'));
    restarted.applyAuthenticatedUpdate(
      Y.encodeStateAsUpdate(peer.doc, Y.encodeStateVector(restarted.doc)),
      MALLORY,
    );
    expect(restarted.consumedStreamPosition()).toBe(2n);
  });

  it('the position is the highest CONTIGUOUS seq — a GAP below the head holds it back even if a later seq folds (the #203 class)', () => {
    // Three durable rows on one client, seqs 1..3. Fold seq 1 and seq 3 but SKIP
    // seq 2 (the visibility-hole reorder: a later-committed middle row not yet folded).
    const convo = new ConversationDoc();
    convo.append(msg('m1', 'one'));
    const row1 = Y.encodeStateAsUpdate(convo.doc);
    const sv1 = Y.encodeStateVector(convo.doc);
    convo.append(msg('m2', 'two'));
    const row2 = Y.encodeStateAsUpdate(convo.doc, sv1);
    const sv2 = Y.encodeStateVector(convo.doc);
    convo.append(msg('m3', 'three'));
    const row3 = Y.encodeStateAsUpdate(convo.doc, sv2);

    const replica = new ServerRoomReplica();
    replica.catchUp(row1, ALICE, 1n);
    // seq 3 folds, but seq 2 is still a GAP. A COUNT (appliedRows.size) would read 2
    // and could reach a head of 3 with content missing — the false-pass this fix ends.
    // The contiguous-prefix position stays at 1: the gate refuses while seq 2 is absent.
    replica.catchUp(row3, ALICE, 3n);
    expect(replica.consumedStreamPosition()).toBe(1n); // NOT 2 — the gap holds it back

    // Fold the missing seq 2. The prefix now closes past both 2 and the already-folded
    // 3 in one step — the row is folded (counted), never skipped-yet-counted.
    replica.catchUp(row2, ALICE, 2n);
    expect(replica.consumedStreamPosition()).toBe(3n);
    expect(replica.conversation.body('m2')?.toString()).toBe('two');
  });

  it('ATOMICITY (B2): a row that throws on integration records NO ledger stamp and consumes NO seq', () => {
    const alice = new ConversationDoc();
    alice.append(msg('m1', 'the honest reading'));
    const good = Y.encodeStateAsUpdate(alice.doc);

    const replica = new ServerRoomReplica();
    replica.catchUp(good, ALICE, 1n);
    expect(replica.consumedStreamPosition()).toBe(1n);

    // A poison row at seq 2: parseUpdateMeta/applyUpdate throws. catchUp propagates
    // (the manager quarantines it), but the throw must leave NOTHING behind — no
    // consumed seq, no phantom ledger entry — so a later good seq-2 row folds cleanly.
    const poison = Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(() => replica.catchUp(poison, MALLORY, 2n)).toThrow();
    expect(replica.consumedStreamPosition()).toBe(1n); // seq 2 is a gap, not consumed

    // The seq-2 slot is still free: a genuine row folds there and closes the prefix.
    const bob = new ConversationDoc();
    Y.applyUpdate(bob.doc, good);
    const sv = Y.encodeStateVector(bob.doc);
    bob.append(msg('m2', 'the review'));
    replica.catchUp(Y.encodeStateAsUpdate(bob.doc, sv), BOB, 2n);
    expect(replica.consumedStreamPosition()).toBe(2n);
    expect(replica.authenticatedAuthorOf('m2')).toEqual(BOB);
    // …and the poison writer (Mallory) never got a phantom stamp on m1's content.
    expect(replica.authenticatedAuthorOf('m1')).toEqual(ALICE);
  });
});
