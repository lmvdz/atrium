import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  type PersistedYdocUpdate,
  RoomReplicaManager,
  writerFromRow,
  type YdocStreamSource,
} from '@/lib/room-replica-manager';
import { clearServerReplicas, serverReplicaFor } from '@/lib/server-room-replica';
import type { ChatMsg } from '../app/prototype/types';
import { ConversationDoc } from '../app/prototype/yjs-conversation';

/* ═══════════════════════════════════════════════════════════════════════════
 * E3 (#203) — the room-replica LIFECYCLE: lazy-start, idle-evict (fail-closed),
 * re-register. Driven against a fake in-memory {@link YdocStreamSource}; the
 * real Postgres source is proven in `integration/web/server-replica-restart.test.ts`.
 * ═════════════════════════════════════════════════════════════════════════ */

const ROOM = 'room_e3_mgr';
const ALICE = { userId: 'u_alice', principalKind: 'human' as const };

afterEach(() => clearServerReplicas());

function msg(id: string, text: string): ChatMsg {
  return { id, time: '10:00', kind: 'human', who: 'you', text };
}

/**
 * A durable row WITHOUT its `stream_seq` — {@link FakeSource} mints the per-room,
 * gap-free seq (1..N) from the stored array order, exactly as migration 0055's
 * append function does, so a test never has to hand-assign one.
 */
type UnsequencedRow = Omit<PersistedYdocUpdate, 'streamSeq'>;

/** A persisted row from a single-message doc, stamped to `writerUserId`/`writerKind`. */
function row(
  id: string,
  text: string,
  writerUserId: string | null,
  writerKind: PersistedYdocUpdate['writerKind'],
): UnsequencedRow {
  const c = new ConversationDoc();
  c.append(msg(id, text));
  return { op: Y.encodeStateAsUpdate(c.doc), writerUserId, writerKind };
}

class FakeSource implements YdocStreamSource {
  calls = { snapshot: 0, head: 0 };
  constructor(private readonly store: Map<string, UnsequencedRow[]>) {}
  async snapshot(roomId: string): Promise<readonly PersistedYdocUpdate[]> {
    this.calls.snapshot += 1;
    // Mint the per-room gap-free stream_seq (1..N) from the stored order — the
    // stable row identity the replica dedupes and gap-detects on (#203). A bigint,
    // exactly as `dbYdocStreamSource` now carries it.
    return (this.store.get(roomId) ?? []).map((r, i) => ({ ...r, streamSeq: BigInt(i + 1) }));
  }
  async head(roomId: string): Promise<bigint> {
    this.calls.head += 1;
    // The head is the MAX stream_seq; the store is gap-free from 1, so that is its length.
    return BigInt((this.store.get(roomId) ?? []).length);
  }
}

describe('writerFromRow maps the persisted stamp to a writer identity', () => {
  it('human/agent rows become a writer; system / inconsistent rows are unattributed', () => {
    expect(writerFromRow({ writerUserId: 'u_a', writerKind: 'human' })).toEqual({
      userId: 'u_a',
      principalKind: 'human',
    });
    expect(writerFromRow({ writerUserId: 'ag', writerKind: 'agent' })).toEqual({
      userId: 'ag',
      principalKind: 'agent',
    });
    expect(writerFromRow({ writerUserId: null, writerKind: 'system' })).toBeNull();
    // A malformed stamp (authored kind, no user) is fail-closed to unattributed.
    expect(writerFromRow({ writerUserId: null, writerKind: 'human' })).toBeNull();
  });
});

describe('lazy-start: a replica is built from the stream on first need and registered', () => {
  it('acquire catches up a replica, registers it, and replays authorship from the rows', async () => {
    const store = new Map([[ROOM, [row('m1', 'ship it', 'u_alice', 'human')]]]);
    const manager = new RoomReplicaManager({ source: new FakeSource(store) });

    expect(serverReplicaFor(ROOM)).toBeNull(); // nothing before first need
    const replica = await manager.acquire(ROOM);
    expect(replica).not.toBeNull();
    expect(serverReplicaFor(ROOM)).toBe(replica); // registered for liveCovenantDoc
    expect(replica?.conversation.body('m1')?.toString()).toBe('ship it');
    expect(replica?.authenticatedAuthorOf('m1')).toEqual(ALICE); // stamp replayed
    expect(replica?.consumedStreamPosition()).toBe(1n);
  });

  it('a second acquire REUSES the same replica OBJECT — it does not rebuild from scratch', async () => {
    const store = new Map([[ROOM, [row('m1', 'ship it', 'u_alice', 'human')]]]);
    const source = new FakeSource(store);
    const manager = new RoomReplicaManager({ source });

    const first = await manager.acquire(ROOM);
    const second = await manager.acquire(ROOM);
    expect(second).toBe(first); // the warm replica object is reused, never rebuilt
  });

  it('BLOCKER-1: a warm replica RE-CATCHES-UP on acquire — a row appended after it warmed is folded in (no manual evict)', async () => {
    const rows = [row('m1', 'ship it', 'u_alice', 'human')];
    const store = new Map([[ROOM, rows]]);
    const manager = new RoomReplicaManager({ source: new FakeSource(store) });

    const warm = await manager.acquire(ROOM);
    expect(warm?.consumedStreamPosition()).toBe(1n);
    expect(warm?.conversation.body('m2')).toBeNull(); // m2 not yet appended

    // A new durable row is appended. Without a live subscription the warm replica has
    // not seen it — a second acquire must catch it up (the permanent-lag blocker).
    rows.push(row('m2', 'review it', 'u_alice', 'human'));
    const caughtUp = await manager.acquire(ROOM);

    expect(caughtUp).toBe(warm); // same object…
    expect(caughtUp?.consumedStreamPosition()).toBe(2n); // …now caught up to head
    expect(caughtUp?.conversation.body('m2')?.toString()).toBe('review it');
    expect(await manager.streamHead(ROOM)).toBe(2n);
  });
});

describe('#203 CLASS: a visibility-hole reorder folds the missing middle row (stable seq, not array index)', () => {
  it('a snapshot that first HIDES a middle seq then reveals it folds that row on re-acquire — the gate does not pass until it is', async () => {
    // Three durable rows on one client: m1, m2, m3 — seqs 1, 2, 3. The first snapshot
    // is missing the MIDDLE row (seq 2) — the visibility hole: seq 3 committed and is
    // visible, but seq 2's in-flight txn is not yet. A source that keys the fold on the
    // ARRAY INDEX would, on the second (full) snapshot, see m2 at index 1 — an index
    // an already-folded row owns — and DEDUPE IT AWAY while the count still reached the
    // head: the false-pass this class produces. Keyed on the stable stream_seq, m2 is a
    // distinct seq that folds cleanly.
    const c = new ConversationDoc();
    c.append(msg('m1', 'one'));
    const r1 = { op: Y.encodeStateAsUpdate(c.doc), streamSeq: 1n };
    const sv1 = Y.encodeStateVector(c.doc);
    c.append(msg('m2', 'two'));
    const r2 = { op: Y.encodeStateAsUpdate(c.doc, sv1), streamSeq: 2n };
    const sv2 = Y.encodeStateVector(c.doc);
    c.append(msg('m3', 'three'));
    const r3 = { op: Y.encodeStateAsUpdate(c.doc, sv2), streamSeq: 3n };

    const mk = (r: { op: Uint8Array; streamSeq: bigint }): PersistedYdocUpdate => ({
      op: r.op,
      writerUserId: 'u_alice',
      writerKind: 'human',
      streamSeq: r.streamSeq,
    });

    // The head sees seq 3 as the max throughout (seq 3 is committed); the snapshot is
    // what momentarily hides seq 2, then reveals it.
    let reveal = false;
    const source: YdocStreamSource = {
      async snapshot() {
        return reveal ? [mk(r1), mk(r2), mk(r3)] : [mk(r1), mk(r3)];
      },
      async head() {
        return 3n;
      },
    };
    const manager = new RoomReplicaManager({ source });

    // First acquire: seq 2 is hidden, so only seqs 1 and 3 fold. The contiguous
    // position is 1 (the gap at seq 2), BELOW the head of 3 — the gate would refuse.
    const first = await manager.acquire(ROOM);
    expect(first?.conversation.body('m2')).toBeNull(); // the middle row is not here yet
    expect(first?.consumedStreamPosition()).toBe(1n);
    expect(first?.consumedStreamPosition()).toBeLessThan(await manager.streamHead(ROOM));

    // The hole fills. A re-acquire re-catches-up: seq 2 folds (it never deduped away),
    // and the contiguous position closes to 3 — caught up, gate passes, content present.
    reveal = true;
    const caughtUp = await manager.acquire(ROOM);
    expect(caughtUp).toBe(first); // same warm object
    expect(caughtUp?.conversation.body('m2')?.toString()).toBe('two'); // the once-missing row
    expect(caughtUp?.consumedStreamPosition()).toBe(3n);
    expect(caughtUp?.consumedStreamPosition()).toBe(await manager.streamHead(ROOM));
  });
});

describe('BLOCKER-2: a poison row does not crash acquire — it is quarantined, the room reads as lagging', () => {
  it('acquire skips an unparseable row (never throws), and the replica trails the head ⇒ fail-closed', async () => {
    // A member PUTs garbage bytes through the E2 door (stored verbatim). The good row
    // before it folds; the poison row throws inside catchUp and must be caught.
    const poison: UnsequencedRow = {
      op: Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      writerUserId: 'u_mallory',
      writerKind: 'human',
    };
    const store = new Map([[ROOM, [row('m1', 'the honest reading', 'u_alice', 'human'), poison]]]);
    const manager = new RoomReplicaManager({ source: new FakeSource(store) });

    // acquire does NOT throw (the whole point — certify would otherwise 500 for the room).
    const replica = await manager.acquire(ROOM);
    expect(replica).not.toBeNull();
    // The good row folded; the poison row was quarantined (not counted).
    expect(replica?.conversation.body('m1')?.toString()).toBe('the honest reading');
    expect(replica?.consumedStreamPosition()).toBe(1n); // one of two rows applied
    // Head counts both rows, so the replica trails it — certify refuses cleanly.
    expect(await manager.streamHead(ROOM)).toBe(2n);
    expect(replica?.consumedStreamPosition()).toBeLessThan(await manager.streamHead(ROOM));
  });
});

describe('idle-evict and explicit evict are FAIL-CLOSED (serverReplicaFor ⇒ null)', () => {
  it('sweepIdle drops a replica idle past idleMs, and serverReplicaFor then yields null', async () => {
    let clock = 1_000;
    const store = new Map([[ROOM, [row('m1', 'ship it', 'u_alice', 'human')]]]);
    const manager = new RoomReplicaManager({
      source: new FakeSource(store),
      idleMs: 100,
      now: () => clock,
    });

    await manager.acquire(ROOM);
    expect(serverReplicaFor(ROOM)).not.toBeNull();

    clock = 1_050; // within the idle window — not yet evicted
    manager.sweepIdle();
    expect(serverReplicaFor(ROOM)).not.toBeNull();

    clock = 1_201; // past idleMs since last use
    manager.sweepIdle();
    expect(serverReplicaFor(ROOM)).toBeNull(); // fail-closed: the reader now yields ~
  });

  it('a reused replica’s idle timer resets, so use keeps it alive', async () => {
    let clock = 0;
    const store = new Map([[ROOM, [row('m1', 'ship it', 'u_alice', 'human')]]]);
    const manager = new RoomReplicaManager({
      source: new FakeSource(store),
      idleMs: 100,
      now: () => clock,
    });
    await manager.acquire(ROOM);
    clock = 90;
    await manager.acquire(ROOM); // touch — resets lastUsed to 90
    clock = 150; // 60 since last use, < 100
    manager.sweepIdle();
    expect(serverReplicaFor(ROOM)).not.toBeNull();
  });

  it('explicit evict tears the replica down immediately', async () => {
    const store = new Map([[ROOM, [row('m1', 'ship it', 'u_alice', 'human')]]]);
    const manager = new RoomReplicaManager({ source: new FakeSource(store) });
    const replica = await manager.acquire(ROOM);
    manager.evict(ROOM);
    expect(serverReplicaFor(ROOM)).toBeNull();
    expect(replica?.conversation.isDestroyed()).toBe(true);
  });

  it('a replica evicted out-of-band is rebuilt on the next acquire (re-register)', async () => {
    const store = new Map([[ROOM, [row('m1', 'ship it', 'u_alice', 'human')]]]);
    const source = new FakeSource(store);
    const manager = new RoomReplicaManager({ source });
    const first = await manager.acquire(ROOM);
    // Something clears the registry underneath the manager (a teardown elsewhere).
    clearServerReplicas();
    const rebuilt = await manager.acquire(ROOM);
    expect(rebuilt).not.toBe(first);
    expect(serverReplicaFor(ROOM)).toBe(rebuilt);
    expect(source.calls.snapshot).toBe(2);
  });
});

describe('a stream that cannot be read fails closed — no half-caught-up replica is registered', () => {
  it('acquire returns null and registers nothing when the source throws', async () => {
    const source: YdocStreamSource = {
      snapshot: async () => {
        throw new Error('stream unreachable');
      },
      head: async () => 0n,
    };
    const manager = new RoomReplicaManager({ source });
    const replica = await manager.acquire(ROOM);
    expect(replica).toBeNull();
    expect(serverReplicaFor(ROOM)).toBeNull();
  });
});

/* `streamHead` reports the durable head (max stream_seq) for the freshness gate.
 * The old unit test here asserted `streamHead === FakeSource.head`, where the fake's
 * head is `store.length` — a tautology (it proved the fake, not that the head is the
 * MAX stream_seq rather than a row count). Deleted rather than kept, because the REAL
 * property is covered where it can actually be exercised:
 *   - HEAD-IS-MAX-NOT-COUNT, with a gap: the '#203 CLASS' test above drives a source
 *     whose head is a constant 3 while the snapshot exposes only 2 rows (seq 2 hidden),
 *     so the gate compares against the max (3), not the visible count (2);
 *   - HEAD = real `max(stream_seq)` over a gapped stream: `integration/web/
 *     server-replica-restart.test.ts` runs the real `dbYdocStreamSource.head` against
 *     Postgres and asserts head = 3 with a quarantined seq-2 gap (and head = 2 with a
 *     poison row) — the actual SQL a unit fake can never stand in for. */

describe('#203 BIGINT HYGIENE: big stream positions carry through the manager without narrowing', () => {
  it('a head above 2^31 and 2^53 is returned EXACTLY, and a big seq folds/dedupes with no throw', async () => {
    // Heads a JS `number` mishandles: >2^31 (an `::int` head would 500) and >2^53
    // (Number.MAX_SAFE_INTEGER — a number would lose the low bits). streamHead must
    // carry each as an exact bigint.
    const HEAD_31 = 2n ** 31n + 7n;
    const HEAD_53 = 2n ** 53n + 7n;

    // A durable row that genuinely SITS at a big seq — its op folds, its big seq is the
    // dedupe/gap key. The head sits one above it, so the replica lags (fail-closed).
    const c = new ConversationDoc();
    c.append(msg('m1', 'ship it'));
    const bigRow: PersistedYdocUpdate = {
      op: Y.encodeStateAsUpdate(c.doc),
      writerUserId: 'u_alice',
      writerKind: 'human',
      streamSeq: HEAD_53,
    };

    for (const head of [HEAD_31, HEAD_53]) {
      const source: YdocStreamSource = {
        async snapshot() {
          return [bigRow];
        },
        async head() {
          return head;
        },
      };
      const manager = new RoomReplicaManager({ source });

      // No throw at any boundary, and the head is the EXACT bigint (not narrowed).
      expect(await manager.streamHead(ROOM)).toBe(head);

      // The big-seq row folds (content present, seq deduped), and — since seq 1..N-1 are
      // absent — the contiguous position stays 0, strictly below the head: the replica
      // correctly reads as lagging rather than false-passing off a narrowed compare.
      const replica = await manager.acquire(ROOM);
      expect(replica?.conversation.body('m1')?.toString()).toBe('ship it');
      expect(replica?.consumedStreamPosition()).toBe(0n); // gap from seq 1 holds it at 0
      expect(replica?.consumedStreamPosition()).toBeLessThan(await manager.streamHead(ROOM));

      manager.evictAll();
      clearServerReplicas();
    }
  });
});
