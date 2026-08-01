import { describe, expect, it, vi } from 'vitest';
import type { LedgerEntry } from '../src/ledger.js';
import { createLogger } from '../src/logger.js';
import { createReconciler } from '../src/reconciler.js';
import type { RoomEvent } from '../src/room-events.js';

/**
 * The reconciler's contract, without a database (#22 gauntlet r2 delta,
 * blocking 1; corrected by the r3 delta's blocking 1).
 *
 * The r2 finding was that `LISTEN/NOTIFY` was consumed once at startup and never
 * again, so a lost notification stranded every subscriber on that instance. The
 * fix is a loop that does not care whether a notification ever arrived, and
 * these tests are about that indifference: what it delivers and what it reports.
 *
 * The r3 delta found the second half of it wrong in the other direction. This
 * module used to decide *not* to send a head frame, on bookkeeping that treated
 * a successful broadcast as a successful delivery — so the one failure the head
 * frame exists for was the one it could not cover. It now reports every
 * subscribed room's head every pass and makes no delivery decision at all; who
 * still needs to hear it is `head-acks.test.ts`'s subject, decided by what each
 * socket has acknowledged.
 *
 * The real thing against a real Postgres — the listener severed mid-run, and an
 * event frame dropped after a successful fan-out — is
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

  it('reports the head again on a pass where nothing changed', async () => {
    /**
     * The r3-delta correction, from the reconciler's side (#22 gauntlet r3
     * delta, blocking 1). Round 3 kept an `announcedHeads` map here and skipped
     * a room whose head it had already announced — which reads as thrift and is
     * actually the server deciding, with no evidence, that a frame it sent
     * arrived. Whether a *socket* still needs telling is `head-acks.ts`'s
     * question and is answered by that socket; this module's job is to say where
     * the room is, every pass, so that answer has something to gate.
     *
     * Catches: reinstating any bookkeeping here that suppresses a repeat — the
     * `announcedHeads` map, a "only when it moved" guard, a per-room latch.
     * Under r3 the second and third passes are silent, so a socket that dropped
     * the frame carrying the first one is never told again.
     */
    const h = harness({ rooms: [ROOM_A] });
    h.headsOf.mockResolvedValue(new Map([[ROOM_A, 4]]));
    await h.reconciler.reconcile();
    await h.reconciler.reconcile();
    await h.reconciler.reconcile();
    expect(h.heads).toEqual([
      { roomId: ROOM_A, head: 4 },
      { roomId: ROOM_A, head: 4 },
      { roomId: ROOM_A, head: 4 },
    ]);
  });

  it('reports the head of a room it just delivered every row of', async () => {
    /**
     * The same finding at its sharpest. r3 said a room it had just fanned rows
     * out to needed no head frame, "because its head is announced by
     * construction" — but the fan-out is precisely the send that may have been
     * lost, so the room that just received rows is the one most in need of being
     * told where it is. The `head` frame exists for exactly that failure and r3
     * suppressed it on the evidence of the failure itself.
     *
     * Catches: skipping `onHead` for a room named in this pass's `sync` result.
     */
    const h = harness({ rooms: [ROOM_A] });
    h.sync.mockResolvedValueOnce([entry(ROOM_A, 1), entry(ROOM_A, 2)]);
    h.headsOf.mockResolvedValue(new Map([[ROOM_A, 2]]));
    await h.reconciler.reconcile();
    expect(h.delivered.map((e) => e.roomSeq)).toEqual([1, 2]);
    expect(h.heads).toEqual([{ roomId: ROOM_A, head: 2 }]);
  });

  it('says nothing about a room with no history at all', async () => {
    // `head: 0` tells a client at 0 that it is up to date, which it already
    // believes — a frame that can only ever be a no-op. Catches: dropping the
    // `head === 0` guard, which puts one useless frame per empty room per pass
    // on every socket in it.
    const h = harness({ rooms: [ROOM_A] });
    h.headsOf.mockResolvedValue(new Map());
    await h.reconciler.reconcile();
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
