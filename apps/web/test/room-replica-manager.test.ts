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

/** A persisted row from a single-message doc, stamped to `writerUserId`/`writerKind`. */
function row(
  id: string,
  text: string,
  writerUserId: string | null,
  writerKind: PersistedYdocUpdate['writerKind'],
): PersistedYdocUpdate {
  const c = new ConversationDoc();
  c.append(msg(id, text));
  return { op: Y.encodeStateAsUpdate(c.doc), writerUserId, writerKind };
}

class FakeSource implements YdocStreamSource {
  calls = { snapshot: 0, head: 0 };
  constructor(private readonly store: Map<string, PersistedYdocUpdate[]>) {}
  async snapshot(roomId: string): Promise<readonly PersistedYdocUpdate[]> {
    this.calls.snapshot += 1;
    return this.store.get(roomId) ?? [];
  }
  async head(roomId: string): Promise<number> {
    this.calls.head += 1;
    return (this.store.get(roomId) ?? []).length;
  }
}

describe('writerFromRow maps the persisted stamp to a writer identity', () => {
  it('human/agent rows become a writer; system / inconsistent rows are unattributed', () => {
    expect(
      writerFromRow({ op: new Uint8Array(), writerUserId: 'u_a', writerKind: 'human' }),
    ).toEqual({
      userId: 'u_a',
      principalKind: 'human',
    });
    expect(
      writerFromRow({ op: new Uint8Array(), writerUserId: 'ag', writerKind: 'agent' }),
    ).toEqual({
      userId: 'ag',
      principalKind: 'agent',
    });
    expect(
      writerFromRow({ op: new Uint8Array(), writerUserId: null, writerKind: 'system' }),
    ).toBeNull();
    // A malformed stamp (authored kind, no user) is fail-closed to unattributed.
    expect(
      writerFromRow({ op: new Uint8Array(), writerUserId: null, writerKind: 'human' }),
    ).toBeNull();
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
    expect(replica?.consumedStreamPosition()).toBe(1);
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
    expect(warm?.consumedStreamPosition()).toBe(1);
    expect(warm?.conversation.body('m2')).toBeNull(); // m2 not yet appended

    // A new durable row is appended. Without a live subscription the warm replica has
    // not seen it — a second acquire must catch it up (the permanent-lag blocker).
    rows.push(row('m2', 'review it', 'u_alice', 'human'));
    const caughtUp = await manager.acquire(ROOM);

    expect(caughtUp).toBe(warm); // same object…
    expect(caughtUp?.consumedStreamPosition()).toBe(2); // …now caught up to head
    expect(caughtUp?.conversation.body('m2')?.toString()).toBe('review it');
    expect(await manager.streamHead(ROOM)).toBe(2);
  });
});

describe('BLOCKER-2: a poison row does not crash acquire — it is quarantined, the room reads as lagging', () => {
  it('acquire skips an unparseable row (never throws), and the replica trails the head ⇒ fail-closed', async () => {
    // A member PUTs garbage bytes through the E2 door (stored verbatim). The good row
    // before it folds; the poison row throws inside catchUp and must be caught.
    const poison: PersistedYdocUpdate = {
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
    expect(replica?.consumedStreamPosition()).toBe(1); // one of two rows applied
    // Head counts both rows, so the replica trails it — certify refuses cleanly.
    expect(await manager.streamHead(ROOM)).toBe(2);
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
      head: async () => 0,
    };
    const manager = new RoomReplicaManager({ source });
    const replica = await manager.acquire(ROOM);
    expect(replica).toBeNull();
    expect(serverReplicaFor(ROOM)).toBeNull();
  });
});

describe('streamHead reports the durable head for the freshness gate', () => {
  it('delegates to the source and reflects appended rows', async () => {
    const rows = [row('m1', 'a', 'u_alice', 'human')];
    const store = new Map([[ROOM, rows]]);
    const manager = new RoomReplicaManager({ source: new FakeSource(store) });
    expect(await manager.streamHead(ROOM)).toBe(1);
    rows.push(row('m2', 'b', 'u_alice', 'human'));
    expect(await manager.streamHead(ROOM)).toBe(2);
  });
});
