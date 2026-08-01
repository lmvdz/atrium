import { describe, expect, it, vi } from 'vitest';
import type { LedgerEntry } from '../src/ledger.js';
import { createLogger } from '../src/logger.js';
import { createReconciler } from '../src/reconciler.js';
import type { RoomEvent } from '../src/room-events.js';

/**
 * The reconciler's contract, without a database (#22 gauntlet r2 delta,
 * blocking 1).
 *
 * The finding was that `LISTEN/NOTIFY` was consumed once at startup and never
 * again, so a lost notification stranded every subscriber on that instance. The
 * fix is a loop that does not care whether a notification ever arrived, and
 * these tests are about that indifference: what it delivers, what it announces,
 * and — the part a "just poll it" implementation gets wrong — what it does *not*
 * repeat.
 *
 * The real thing against a real Postgres, with the listener severed mid-run, is
 * `integration/server/reconcile.test.ts`.
 */

const logger = createLogger('error');
const ROOM_A = 'room-a';
const ROOM_B = 'room-b';

function entry(roomId: string, roomSeq: number): LedgerEntry {
  return {
    seq: roomSeq,
    roomSeq,
    roomId,
    actor: { kind: 'human', userId: 'u1' },
    event: {
      id: `e${roomSeq}`,
      at: `2026-08-01T00:00:${String(roomSeq).padStart(2, '0')}.000Z`,
      type: 'message_posted',
      roomId,
      messageId: `m${roomSeq}`,
      body: 'hi',
      replyToId: null,
      clientMessageId: null,
      attachments: [],
    } as RoomEvent,
  };
}

interface Harness {
  reconciler: ReturnType<typeof createReconciler>;
  delivered: LedgerEntry[];
  heads: Array<{ roomId: string; head: number }>;
  sync: ReturnType<typeof vi.fn>;
  headsOf: ReturnType<typeof vi.fn>;
}

function harness(options: { rooms?: string[] } = {}): Harness {
  const delivered: LedgerEntry[] = [];
  const heads: Array<{ roomId: string; head: number }> = [];
  const sync = vi.fn(async () => [] as LedgerEntry[]);
  const headsOf = vi.fn(async () => new Map<string, number>());
  const reconciler = createReconciler({
    ledger: { sync, heads: headsOf },
    logger,
    intervalMs: 10_000,
    subscribedRooms: () => options.rooms ?? [],
    onEntries: (entries) => delivered.push(...entries),
    onHead: (roomId, head) => heads.push({ roomId, head }),
  });
  return { reconciler, delivered, heads, sync, headsOf };
}

describe('reconciliation delivers without a doorbell', () => {
  it('fans out every row the ledger folded on this pass', async () => {
    const h = harness();
    h.sync.mockResolvedValueOnce([entry(ROOM_A, 1), entry(ROOM_A, 2)]);
    await h.reconciler.reconcile();
    expect(h.delivered.map((e) => e.roomSeq)).toEqual([1, 2]);
  });

  it('carries the trusted actor onto the fan-out rather than dropping it', async () => {
    // Catches: building the broadcast envelope from the event alone. The actor
    // is a column now, so a fan-out that forgets it hands the client an envelope
    // whose `actor` is undefined — and `reconcilePending` then never matches a
    // person's own message echo, so every optimistic row sticks forever.
    const h = harness();
    h.sync.mockResolvedValueOnce([entry(ROOM_A, 1)]);
    await h.reconciler.reconcile();
    expect(h.delivered[0]?.actor).toEqual({ kind: 'human', userId: 'u1' });
  });

  it('announces a room head that has moved past what subscribers were told', async () => {
    const h = harness({ rooms: [ROOM_A, ROOM_B] });
    h.headsOf.mockResolvedValueOnce(
      new Map([
        [ROOM_A, 7],
        [ROOM_B, 3],
      ]),
    );
    await h.reconciler.reconcile();
    expect(h.heads).toEqual([
      { roomId: ROOM_A, head: 7 },
      { roomId: ROOM_B, head: 3 },
    ]);
  });

  it('does not re-announce a head it has already announced', async () => {
    // Catches: dropping the `announcedHeads` bookkeeping. Without it every tick
    // broadcasts a head frame to every subscribed room forever — a heartbeat
    // nobody asked for, which trains a client to ignore the one signal that
    // exists to be believed.
    const h = harness({ rooms: [ROOM_A] });
    h.headsOf.mockResolvedValue(new Map([[ROOM_A, 4]]));
    await h.reconciler.reconcile();
    await h.reconciler.reconcile();
    await h.reconciler.reconcile();
    expect(h.heads).toEqual([{ roomId: ROOM_A, head: 4 }]);
  });

  it('says nothing about a room it just delivered every row of', async () => {
    // A row folded on this pass has already been sent to this room's
    // subscribers, so its head is announced by construction. Catches: announcing
    // the head unconditionally after a sync, which sends a `head` frame
    // immediately after the `event` frame that reached the same position.
    const h = harness({ rooms: [ROOM_A] });
    h.sync.mockResolvedValueOnce([entry(ROOM_A, 1), entry(ROOM_A, 2)]);
    h.headsOf.mockResolvedValue(new Map([[ROOM_A, 2]]));
    await h.reconciler.reconcile();
    expect(h.delivered.map((e) => e.roomSeq)).toEqual([1, 2]);
    expect(h.heads).toEqual([]);
  });

  it('reads no heads at all when nothing is subscribed', async () => {
    // The "cheap and bounded" half of the claim, asserted rather than intended:
    // the head query is scoped to rooms with a live subscriber, so an idle
    // instance's timer costs one range scan and nothing else. Catches: passing
    // every room the ledger knows about instead of the hub's active set.
    const h = harness({ rooms: [] });
    await h.reconciler.reconcile();
    expect(h.headsOf).not.toHaveBeenCalled();
  });
});

describe('reconciliation is safe to trigger from three places at once', () => {
  it('coalesces overlapping passes rather than queueing them', async () => {
    // The timer, the doorbell and a listener resubscribe can all fire together.
    // Catches: dropping the `inFlight` guard, which lets three callers each open
    // their own pass and queue on the ledger's in-process mutex behind each
    // other for no benefit.
    const h = harness();
    let release: () => void = () => undefined;
    h.sync.mockImplementationOnce(
      () =>
        new Promise<LedgerEntry[]>((resolve) => {
          release = () => resolve([]);
        }),
    );
    const passes = [h.reconciler.reconcile(), h.reconciler.reconcile(), h.reconciler.reconcile()];
    release();
    await Promise.all(passes);
    expect(h.sync).toHaveBeenCalledTimes(1);
  });

  it('survives a failing pass and reconciles again on the next one', async () => {
    // A reconciler that dies on one bad pass is a reconciler that stops being
    // the durable path exactly when the database was having a bad minute.
    // Catches: letting the rejection escape `reconcile`, which — on the timer's
    // un-awaited call — becomes an unhandled rejection and takes the process
    // down by `index.ts`'s own policy.
    const h = harness();
    h.sync.mockRejectedValueOnce(new Error('connection reset'));
    await expect(h.reconciler.reconcile()).resolves.toBeUndefined();
    h.sync.mockResolvedValueOnce([entry(ROOM_A, 1)]);
    await h.reconciler.reconcile();
    expect(h.delivered.map((e) => e.roomSeq)).toEqual([1]);
  });
});
