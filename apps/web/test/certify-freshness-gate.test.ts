import type { CovenantDocReader } from '@atrium/core';
import type { Database } from '@atrium/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { certifyObjectSpan, REPLICA_ABSENT_POSITION } from '@/lib/certify-anchor';
import {
  clearServerReplicas,
  registerServerReplica,
  ServerRoomReplica,
  serverReplicaFor,
} from '@/lib/server-room-replica';
import { ConversationDoc } from '../app/prototype/yjs-conversation';

/* ═══════════════════════════════════════════════════════════════════════════
 * E3 (#203) — the SERVER-REPLICA STREAM-POSITION FRESHNESS GATE on certifyObjectSpan.
 *
 * A certify is REFUSED (`replica_lagging`) when the replica the reader resolves
 * against trails the durable stream head captured at request time — never anchor
 * content the server replica has not caught up to. The refusal fires BEFORE the
 * reader is touched or any transaction opens, so it is provable with no database;
 * the PASS path (a fresh replica mints a real anchor) is proven end-to-end over a
 * real Postgres in `integration/web/server-replica-restart.test.ts`.
 *
 * This gate is DISTINCT from #209's client freshness witness — it is about the
 * SERVER replica's position on the stream, not a client's observed fragment.
 * ═════════════════════════════════════════════════════════════════════════ */

const HUMAN = { userId: 'u_alice', principalKind: 'human' as const };

/** A database/reader the lag path must NEVER touch — accessing either fails the test. */
function forbiddenDatabase(): Database {
  return new Proxy(
    {},
    {
      get() {
        throw new Error('the freshness gate must refuse before touching the database');
      },
    },
  ) as unknown as Database;
}
function forbiddenReader(): CovenantDocReader {
  return new Proxy(
    {},
    {
      get() {
        throw new Error('the freshness gate must refuse before touching the reader');
      },
    },
  ) as unknown as CovenantDocReader;
}

describe('the freshness gate refuses a lagging replica before deriving anything', () => {
  it('refuses replica_lagging when the consumed position trails the required head', async () => {
    const consumedPosition = vi.fn(() => 3n);
    const outcome = await certifyObjectSpan({
      database: forbiddenDatabase(),
      session: HUMAN,
      authorizedRoomId: 'room_1',
      objectId: 'o_span',
      reader: forbiddenReader(),
      streamFreshness: { requiredPosition: 5n, consumedPosition },
    });
    expect(outcome).toEqual({ ok: false, reason: 'replica_lagging' });
    expect(consumedPosition).toHaveBeenCalled();
  });

  it('an evicted/absent replica (consumedPosition REPLICA_ABSENT_POSITION) is refused too', async () => {
    const outcome = await certifyObjectSpan({
      database: forbiddenDatabase(),
      session: HUMAN,
      authorizedRoomId: 'room_1',
      objectId: 'o_span',
      reader: forbiddenReader(),
      streamFreshness: { requiredPosition: 0n, consumedPosition: () => REPLICA_ABSENT_POSITION },
    });
    expect(outcome).toEqual({ ok: false, reason: 'replica_lagging' });
  });

  it('a non-human session is still refused first — the gate does not shadow the covenant reason', async () => {
    const outcome = await certifyObjectSpan({
      database: forbiddenDatabase(),
      session: { userId: 'agent_x', principalKind: 'agent' },
      authorizedRoomId: 'room_1',
      objectId: 'o_span',
      reader: forbiddenReader(),
      streamFreshness: { requiredPosition: 5n, consumedPosition: () => 0n },
    });
    expect(outcome).toEqual({ ok: false, reason: 'not_human' });
  });
});

/* THE #203 BIGINT-HYGIENE BOUNDARY. The stream position is a Postgres `bigint`, so the
 * gate must compare it as a JS `bigint` end-to-end. Two failure modes the old `number`
 * path had: a head above `2^31` would 500 (`integer out of range`) off the `::int` cast
 * before the gate even ran, and a head above `2^53` (Number.MAX_SAFE_INTEGER) would
 * silently narrow so two DISTINCT seqs compare EQUAL — a false pass. These prove the gate
 * neither throws nor narrows at either boundary. */
describe('the freshness gate compares BIG stream positions exactly (bigint, #203)', () => {
  /** A reader that resolves nothing ⇒ the gate was PASSED and derivation returns derive_failed. */
  function nullReader(): CovenantDocReader {
    return {
      captureSelection: () => null,
      authoritativeContext: () => null,
    } as unknown as CovenantDocReader;
  }

  const BIG_31 = 2n ** 31n + 5n; // above int32 max — an `::int` head would 500 here

  it('above 2^31: consumed one below the head refuses (no throw); consumed == head passes the gate', async () => {
    const refused = await certifyObjectSpan({
      database: forbiddenDatabase(),
      session: HUMAN,
      authorizedRoomId: 'room_1',
      objectId: 'o_span',
      reader: forbiddenReader(),
      streamFreshness: { requiredPosition: BIG_31, consumedPosition: () => BIG_31 - 1n },
    });
    expect(refused).toEqual({ ok: false, reason: 'replica_lagging' });

    // consumed == required: the gate lets it through to derivation (nullReader ⇒
    // derive_failed) — proving it neither threw nor false-refused at a >2^31 position.
    const passed = await certifyObjectSpan({
      database: forbiddenDatabase(),
      session: HUMAN,
      authorizedRoomId: 'room_1',
      objectId: 'o_span',
      reader: nullReader(),
      streamFreshness: { requiredPosition: BIG_31, consumedPosition: () => BIG_31 },
    });
    expect(passed).toEqual({ ok: false, reason: 'derive_failed' });
  });

  it('above 2^53: two positions that NARROW to the same JS number stay DISTINCT ⇒ refuse (no false pass)', async () => {
    // Number(2^53 + 1) === Number(2^53) === 9007199254740992, so a number-narrowed gate
    // would read consumed == required and FALSE-PASS a lagging replica. As bigints,
    // 2^53 < 2^53 + 1, so the gate correctly refuses.
    const head = 2n ** 53n + 1n;
    const consumed = 2n ** 53n;
    expect(Number(head)).toBe(Number(consumed)); // the narrowing that used to hide the lag
    expect(consumed < head).toBe(true); // …but as bigints they are distinct

    const refused = await certifyObjectSpan({
      database: forbiddenDatabase(),
      session: HUMAN,
      authorizedRoomId: 'room_1',
      objectId: 'o_span',
      reader: forbiddenReader(),
      streamFreshness: { requiredPosition: head, consumedPosition: () => consumed },
    });
    expect(refused).toEqual({ ok: false, reason: 'replica_lagging' });
  });
});

/* The gate as the certify ACTION actually wires it (covenant-actions.ts): the
 * consumed position is `serverReplicaFor(room)?.consumedStreamPosition() ??
 * REPLICA_ABSENT_POSITION`, and the required position is the durable head. This asserts
 * that WIRING — an unregistered room refuses, and a caught-up registered replica is let
 * through — not just the arithmetic `3n < 5n`. */
describe('the freshness gate wired the way the certify action wires it', () => {
  const ROOM = 'room_gate_wiring';
  afterEach(() => clearServerReplicas());

  /** The action's exact consumed-position lambda: registry ⇒ position, else absent. */
  const consumedFromRegistry = (roomId: string) => () =>
    serverReplicaFor(roomId)?.consumedStreamPosition() ?? REPLICA_ABSENT_POSITION;

  /** A reader whose derivation resolves nothing ⇒ certifyAnchor returns null (derive_failed). */
  function nullReader(): CovenantDocReader {
    return {
      captureSelection: () => null,
      authoritativeContext: () => null,
    } as unknown as CovenantDocReader;
  }

  it('serverReplicaFor null (no replica registered) ⇒ replica_lagging, before the DB', async () => {
    // Nothing registered — the wired lambda reads REPLICA_ABSENT_POSITION and the gate refuses.
    const outcome = await certifyObjectSpan({
      database: forbiddenDatabase(),
      session: HUMAN,
      authorizedRoomId: ROOM,
      objectId: 'o_span',
      reader: forbiddenReader(),
      streamFreshness: { requiredPosition: 1n, consumedPosition: consumedFromRegistry(ROOM) },
    });
    expect(outcome).toEqual({ ok: false, reason: 'replica_lagging' });
  });

  it('a registered replica caught up to the head (consumed == required) is LET THROUGH the gate', async () => {
    // A replica caught up to one durable row (stream_seq 1), registered as acquire would.
    const convo = new ConversationDoc();
    convo.append({ id: 'm1', time: '10:00', kind: 'human', who: 'you', text: 'ready' });
    const replica = new ServerRoomReplica();
    replica.catchUp(Y.encodeStateAsUpdate(convo.doc), HUMAN, 1n);
    registerServerReplica(ROOM, replica);
    expect(replica.consumedStreamPosition()).toBe(1n);

    // consumed (1) == required (1): the gate must NOT refuse replica_lagging. It
    // proceeds to derive-and-sign, which here resolves nothing ⇒ derive_failed —
    // proving the gate was passed WITHOUT ever touching the database (transaction only
    // runs on a non-null anchor, and the DB here would throw if touched).
    const outcome = await certifyObjectSpan({
      database: forbiddenDatabase(),
      session: HUMAN,
      authorizedRoomId: ROOM,
      objectId: 'o_span',
      reader: nullReader(),
      streamFreshness: { requiredPosition: 1n, consumedPosition: consumedFromRegistry(ROOM) },
    });
    expect(outcome).toEqual({ ok: false, reason: 'derive_failed' });
  });

  it('THE #203 CLASS AT THE GATE: a replica with a GAP below the head (a reordered/skipped seq) is REFUSED, even though it folded a LATER seq', async () => {
    // Three durable rows, seqs 1..3 (one client, three appended message bodies). The
    // replica folds seq 1 and seq 3 but NOT seq 2 — the visibility-hole reorder: the
    // middle row was skipped/not-yet-folded while a later one was. A COUNT-based
    // position (appliedRows.size) would read 2 and, against a head of 3, still be a
    // lag here — but the false-pass this class produces is when the count REACHES the
    // head with a hole. The contiguous-prefix position makes the hole itself the
    // refusal: consumed is 1 (seq 2 absent), so the gate refuses regardless of seq 3.
    const convo = new ConversationDoc();
    convo.append({ id: 'm1', time: '10:00', kind: 'human', who: 'you', text: 'one' });
    const r1 = Y.encodeStateAsUpdate(convo.doc);
    const sv1 = Y.encodeStateVector(convo.doc);
    convo.append({ id: 'm2', time: '10:01', kind: 'human', who: 'you', text: 'two' });
    const r2 = Y.encodeStateAsUpdate(convo.doc, sv1);
    const sv2 = Y.encodeStateVector(convo.doc);
    convo.append({ id: 'm3', time: '10:02', kind: 'human', who: 'you', text: 'three' });
    const r3 = Y.encodeStateAsUpdate(convo.doc, sv2);

    const replica = new ServerRoomReplica();
    replica.catchUp(r1, HUMAN, 1n);
    replica.catchUp(r3, HUMAN, 3n); // seq 2 skipped — the reorder hole
    registerServerReplica(ROOM, replica);
    expect(replica.consumedStreamPosition()).toBe(1n); // the gap holds the prefix at 1

    // requiredPosition = head = max(stream_seq) = 3. The gate must REFUSE — never
    // certify over content the replica has not folded — WITHOUT touching the DB/reader.
    const refused = await certifyObjectSpan({
      database: forbiddenDatabase(),
      session: HUMAN,
      authorizedRoomId: ROOM,
      objectId: 'o_span',
      reader: forbiddenReader(),
      streamFreshness: { requiredPosition: 3n, consumedPosition: consumedFromRegistry(ROOM) },
    });
    expect(refused).toEqual({ ok: false, reason: 'replica_lagging' });

    // Fold the missing seq 2: the prefix closes to 3 and the SAME gate now passes to
    // derivation (nullReader ⇒ derive_failed) — the hole, once filled, is caught up.
    replica.catchUp(r2, HUMAN, 2n);
    expect(replica.consumedStreamPosition()).toBe(3n);
    const passed = await certifyObjectSpan({
      database: forbiddenDatabase(),
      session: HUMAN,
      authorizedRoomId: ROOM,
      objectId: 'o_span',
      reader: nullReader(),
      streamFreshness: { requiredPosition: 3n, consumedPosition: consumedFromRegistry(ROOM) },
    });
    expect(passed).toEqual({ ok: false, reason: 'derive_failed' });
  });
});
