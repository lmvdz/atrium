import { describe, expect, it } from 'vitest';
import { createHeadAcks } from '../src/head-acks.js';

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
 * These tests are about the two properties that fixes it: nothing the server does
 * writes to this record, and the record is per socket rather than per room.
 */

const ROOM = 'room-a';
const OTHER = 'room-b';

describe('a head frame is retired by acknowledgement, never by attempt', () => {
  it('starts every socket behind, so the first pass always tells it', () => {
    // Catches: seeding a new subscriber at the room's current head, which is r3's
    // inference wearing a different hat — a socket that has been told nothing is
    // not a socket that holds everything.
    const acks = createHeadAcks();
    expect(acks.behind('c1', ROOM, 1)).toBe(true);
    expect(acks.acknowledged('c1', ROOM)).toBe(0);
  });

  it('stops telling a socket once it acknowledges the head', () => {
    // The other half: an acknowledgement really does retire the frame, so the
    // steady state is silent rather than a permanent per-room heartbeat.
    // Catches: ignoring `ack_head` — correct but noisy forever, and a client
    // trained to ignore a frame it receives every two seconds.
    const acks = createHeadAcks();
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
    const acks = createHeadAcks();
    acks.record('caught-up', ROOM, 9);
    expect(acks.behind('caught-up', ROOM, 9)).toBe(false);
    expect(acks.behind('lost-a-frame', ROOM, 9)).toBe(true);
  });

  it('keeps one room’s acknowledgement out of another’s', () => {
    // Catches: keying by subscriber alone. A client caught up in one room is not
    // caught up in every room it is in, and a single cursor per socket would say
    // it was.
    const acks = createHeadAcks();
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
    const acks = createHeadAcks();
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
    const acks = createHeadAcks();
    acks.record('c1', ROOM, Number.NaN);
    acks.record('c1', ROOM, -3);
    expect(acks.acknowledged('c1', ROOM)).toBe(0);
    expect(acks.behind('c1', ROOM, 1)).toBe(true);
  });

  it('forgets what a re-subscribing socket said last time', () => {
    // A client that re-joins may have thrown its journal away. Catches: dropping
    // the `reset` on subscribe, which would let a stale acknowledgement suppress
    // the head frames a freshly emptied client needs most.
    const acks = createHeadAcks();
    acks.record('c1', ROOM, 20);
    acks.reset('c1', ROOM);
    expect(acks.acknowledged('c1', ROOM)).toBe(0);
    expect(acks.behind('c1', ROOM, 1)).toBe(true);
  });

  it('forgets a socket entirely when it closes', () => {
    // Catches: dropping `forget` on close. Nothing observable breaks — which is
    // the point: the map would grow one entry per connection for the life of the
    // process, and a leak with no symptom is a leak nobody finds.
    const acks = createHeadAcks();
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
    const acks = createHeadAcks();
    acks.record('c1', ROOM, 3);
    acks.forgetRoom('c1', ROOM);
    expect(acks.size()).toBe(0);
  });
});
