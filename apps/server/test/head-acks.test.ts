import { describe, expect, it } from 'vitest';
import { createHeadAcks, type HeadAcks } from '../src/head-acks.js';

/**
 * The record that decides whether a socket still needs a `head` frame
 * (#22 gauntlet r3 delta, blocking 1).
 *
 * Round 3's version of this lived in `reconciler.ts`, was keyed by room, and was
 * written from **attempts** — a successful `hub.broadcast` marked the room's head
 * as announced. The finding:
 *
 * > That treats "we called broadcast" as "the client received it" […] After
 * > fan-out, a quiet room with a dropped frame gets no further signal.
 *
 * These tests are about the two properties that fix it — nothing the server does
 * writes to this record, and the record is per socket rather than per room — and,
 * since round 5, about the third: what the record is *allowed to contain*.
 */

const ROOM = 'room-a';
const OTHER = 'room-b';

/**
 * A head-ack record plus the subscription set it is bounded by.
 *
 * The production `subscribed` is `hub.isSubscribed`, and the hub is only written
 * by `handleSubscribe`, which runs `requireMembership` first. The stub is the
 * same shape: a socket is in a room because something put it there, never because
 * it said so.
 */
function harness(): {
  acks: HeadAcks;
  join: (subscriberId: string, roomId: string) => void;
  leave: (subscriberId: string, roomId: string) => void;
} {
  const rooms = new Map<string, Set<string>>();
  const acks = createHeadAcks({
    subscribed: (subscriberId, roomId) => rooms.get(subscriberId)?.has(roomId) ?? false,
  });
  return {
    acks,
    join: (subscriberId, roomId) => {
      const held = rooms.get(subscriberId) ?? new Set<string>();
      held.add(roomId);
      rooms.set(subscriberId, held);
    },
    leave: (subscriberId, roomId) => {
      rooms.get(subscriberId)?.delete(roomId);
    },
  };
}

/** The common case: everybody named is in every room named. */
function subscribedEverywhere(): HeadAcks {
  return createHeadAcks({ subscribed: () => true });
}

describe('a head frame is retired by acknowledgement, never by attempt', () => {
  it('starts every socket behind, so the first pass always tells it', () => {
    // Catches: seeding a new subscriber at the room's current head, which is r3's
    // inference wearing a different hat — a socket that has been told nothing is
    // not a socket that holds everything.
    const acks = subscribedEverywhere();
    expect(acks.behind('c1', ROOM, 1)).toBe(true);
    expect(acks.acknowledged('c1', ROOM)).toBe(0);
  });

  it('stops telling a socket once it acknowledges the head', () => {
    // The other half: an acknowledgement really does retire the frame, so the
    // steady state is silent rather than a permanent per-room heartbeat.
    // Catches: ignoring `ack_head` — correct but noisy forever, and a client
    // trained to ignore a frame it receives every two seconds.
    const acks = subscribedEverywhere();
    acks.record('c1', ROOM, 7);
    expect(acks.behind('c1', ROOM, 7)).toBe(false);
    expect(acks.behind('c1', ROOM, 8)).toBe(true);
  });

  it('keeps one socket’s acknowledgement out of another’s', () => {
    /**
     * The half r3 could not express at all. Its map was keyed by room, so one
     * caught-up subscriber silenced the head frame for everybody else in the
     * room — including the socket that had just dropped the frame the room-level
     * record was counting as delivered.
     *
     * Catches: keying this record by room, or by room plus anything that is not
     * the subscriber.
     */
    const acks = subscribedEverywhere();
    acks.record('caught-up', ROOM, 9);
    expect(acks.behind('caught-up', ROOM, 9)).toBe(false);
    expect(acks.behind('lost-a-frame', ROOM, 9)).toBe(true);
  });

  it('keeps one room’s acknowledgement out of another’s', () => {
    // Catches: keying by subscriber alone. A client caught up in one room is not
    // caught up in every room it is in, and a single cursor per socket would say
    // it was.
    const acks = subscribedEverywhere();
    acks.record('c1', ROOM, 5);
    expect(acks.behind('c1', ROOM, 5)).toBe(false);
    expect(acks.behind('c1', OTHER, 1)).toBe(true);
  });

  it('never lets an acknowledgement move backwards', () => {
    /**
     * Two head frames in flight are answered in whatever order the socket
     * delivers them, and a client mid-catch-up answers the first with a cursor
     * it has already passed. Taking the later, smaller number would re-open head
     * frames the client has already answered — harmless in isolation, and a
     * livelock with a client that answers every one of them.
     *
     * Catches: dropping the `Math.max` in `record`.
     */
    const acks = subscribedEverywhere();
    acks.record('c1', ROOM, 12);
    acks.record('c1', ROOM, 4);
    expect(acks.acknowledged('c1', ROOM)).toBe(12);
    expect(acks.behind('c1', ROOM, 12)).toBe(false);
  });

  it('ignores a nonsensical cursor rather than storing it', () => {
    // A negative or non-finite `roomSeq` cannot be a position. Storing it would
    // make `behind` answer arithmetic about `NaN`, which is false for every
    // comparison — so a single junk frame would silence this socket's head
    // frames permanently. Catches: recording without the finiteness guard.
    const acks = subscribedEverywhere();
    acks.record('c1', ROOM, Number.NaN);
    acks.record('c1', ROOM, -3);
    expect(acks.acknowledged('c1', ROOM)).toBe(0);
    expect(acks.behind('c1', ROOM, 1)).toBe(true);
  });

  it('forgets what a re-subscribing socket said last time', () => {
    // A client that re-joins may have thrown its journal away. Catches: dropping
    // the `reset` on subscribe, which would let a stale acknowledgement suppress
    // the head frames a freshly emptied client needs most.
    const acks = subscribedEverywhere();
    acks.record('c1', ROOM, 20);
    acks.reset('c1', ROOM);
    expect(acks.acknowledged('c1', ROOM)).toBe(0);
    expect(acks.behind('c1', ROOM, 1)).toBe(true);
  });

  it('forgets a socket entirely when it closes', () => {
    // Catches: dropping `forget` on close. Nothing observable breaks — which is
    // the point: the map would grow one entry per connection for the life of the
    // process, and a leak with no symptom is a leak nobody finds.
    const acks = subscribedEverywhere();
    acks.record('c1', ROOM, 3);
    acks.record('c1', OTHER, 4);
    acks.record('c2', ROOM, 5);
    expect(acks.size()).toBe(2);
    acks.forget('c1');
    expect(acks.size()).toBe(1);
    expect(acks.acknowledged('c1', ROOM)).toBe(0);
    expect(acks.acknowledged('c2', ROOM)).toBe(5);
  });

  it('drops a socket’s last room rather than keeping an empty shell', () => {
    // The same leak one level down: unsubscribing from every room must leave no
    // entry behind. Catches: `forgetRoom` deleting the room without collapsing
    // an emptied socket.
    const acks = subscribedEverywhere();
    acks.record('c1', ROOM, 3);
    acks.forgetRoom('c1', ROOM);
    expect(acks.size()).toBe(0);
  });
});

/**
 * The record is bounded by the socket's own subscriptions (#22 gauntlet r4 delta,
 * major).
 *
 * > ACK bookkeeping is unbounded for a live socket — `head-acks.ts:96` records
 * > arbitrary room ids with no subscription or authorization check.
 *
 * The cleanup on close was already correct and was already beside the point: a
 * socket that never closes never reaches it. These four are about what one live
 * socket can put in the map, and the bound is deliberately the subscription set
 * rather than a number — a cap still lets a client fill it with rooms it invented.
 */
describe('an acknowledgement is bounded by what the socket is subscribed to', () => {
  it('records nothing at all for a room the socket never joined', () => {
    /**
     * The finding, directly. Round 4's `record` called `rooms(subscriberId)`
     * before it did anything else, so even a refused frame would have allocated
     * the socket's map — which is why the assertion is on `size()` and
     * `roomCount()` rather than only on `acknowledged`.
     *
     * Catches: dropping the `subscribed(...)` guard from `record`, and moving it
     * below the `rooms(subscriberId)` call.
     */
    const { acks } = harness();
    expect(acks.record('c1', ROOM, 5)).toBe(false);
    expect(acks.acknowledged('c1', ROOM)).toBe(0);
    expect(acks.roomCount('c1')).toBe(0);
    expect(acks.size()).toBe(0);
    // …and the socket is still told the head, which is the behaviour that
    // matters: a refused acknowledgement must not silence anything.
    expect(acks.behind('c1', ROOM, 1)).toBe(true);
  });

  it('holds one entry per subscribed room however many rooms are invented', () => {
    /**
     * The unbounded-growth half, measured. A live socket sends a thousand
     * acknowledgements naming a thousand room ids it made up; the map holds the
     * one room it is actually in.
     *
     * Catches: any bound expressed as a cap rather than as the subscription set —
     * a cap of 1000 passes every other test in this file and fails this one at
     * 1001.
     */
    const { acks, join } = harness();
    join('c1', ROOM);
    for (let i = 0; i < 1_000; i += 1) {
      expect(acks.record('c1', `invented-${i}`, i + 1)).toBe(false);
    }
    expect(acks.record('c1', ROOM, 4)).toBe(true);
    expect(acks.roomCount('c1')).toBe(1);
    expect(acks.acknowledged('c1', ROOM)).toBe(4);
  });

  it('stops accepting acknowledgements the moment the socket leaves the room', () => {
    // Authorization is not a fact established once at subscribe: leaving the room
    // ends it. Catches: checking the subscription only on the first
    // acknowledgement, or caching the answer per (socket, room).
    const { acks, join, leave } = harness();
    join('c1', ROOM);
    expect(acks.record('c1', ROOM, 4)).toBe(true);
    leave('c1', ROOM);
    expect(acks.record('c1', ROOM, 9)).toBe(false);
    expect(acks.acknowledged('c1', ROOM)).toBe(4);
  });

  it('lets a socket acknowledge every room it really is in', () => {
    // The other half, so the guard cannot be satisfied by refusing everything: a
    // client in three rooms answers for three rooms. Catches: a `subscribed`
    // wired to the wrong argument order, which would refuse every real frame and
    // leave the head heartbeat unconditional — correct, silent, and wrong.
    const { acks, join } = harness();
    for (const room of [ROOM, OTHER, 'room-c']) join('c1', room);
    for (const room of [ROOM, OTHER, 'room-c']) expect(acks.record('c1', room, 2)).toBe(true);
    expect(acks.roomCount('c1')).toBe(3);
    expect(acks.behind('c1', OTHER, 2)).toBe(false);
  });
});
