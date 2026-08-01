/**
 * What each socket has said it holds — the only evidence the head frame is
 * allowed to stop on.
 *
 * ## The finding this answers (#22 gauntlet r3 delta, blocking 1)
 *
 * > head recovery is marked done at fan-out time, so a quiet room can still
 * > strand a subscriber. `reconciler.ts:109–116` sets `announcedHeads` from a
 * > successful `onEntries` and `:127–129` then skips `onHead` when
 * > `announcedHeads >= head`. That treats "we called broadcast" as "the client
 * > received it". […] Fix: head is a function of what a client has
 * > *acknowledged*, not of what the server attempted.
 *
 * Round 3's bookkeeping was a record of **attempts**, kept per room. Two things
 * were wrong with it and they compound:
 *
 *  1. A successful `hub.broadcast` means the frame was handed to `ws.send`. It
 *     does not mean it left the machine, and it certainly does not mean a
 *     particular socket applied it. A `head` frame suppressed on that evidence is
 *     a gap signal withheld on the strength of the thing that just failed.
 *  2. It was keyed by **room**, so one subscriber being up to date silenced the
 *     head frame for every other subscriber in the room — including one that
 *     joined mid-burst, or one whose socket dropped the very frame the room's
 *     bookkeeping is counting as delivered.
 *
 * So the record is of **acknowledgements**, and it is per socket. A client
 * replies `ack_head` with the cursor it actually holds, and only that reply
 * retires the head frame — for that socket alone.
 *
 * ## The invariant, exactly
 *
 * **A subscriber is told its room's head on every reconciliation pass until it
 * has acknowledged a position at or past that head.** Nothing the server sends
 * advances the record; only what the client says does.
 *
 * Two consequences worth stating rather than discovering:
 *
 *  - **A client that never acknowledges is told the head every pass, forever.**
 *    That is the safe direction and it is deliberate: an old client, a client
 *    mid-catch-up, a client whose ack was itself lost, all degrade to the
 *    unconditional per-room heartbeat r3 was trying to avoid — which costs one
 *    small frame per subscribed room per interval and never costs a delivery.
 *    The frame is idempotent at the client (compare with the cursor, ask if
 *    behind), so a repeat is not a second event.
 *  - **A client can silence its own head frames by acknowledging a position it
 *    does not hold.** It can, and it only hurts itself: this record gates
 *    delivery to that one socket and is never read as a fact about the room, the
 *    ledger, or anybody else's cursor. A client lying here is a client choosing
 *    not to be told about its own gap, which it could equally achieve by ignoring
 *    the frame.
 *
 * ## What the record is allowed to contain (#22 gauntlet r4 delta, major)
 *
 * > ACK bookkeeping is unbounded for a live socket — `head-acks.ts:96` records
 * > arbitrary room ids with no subscription or authorization check.
 *
 * Round 4's `record` created a map entry for whatever room id arrived, so one
 * open socket could grow this map without limit by sending `ack_head` frames
 * naming rooms that do not exist. The cleanup on close was correct and irrelevant:
 * a socket that stays open never reaches it.
 *
 * The bound is not a cap, because a cap picks an arbitrary number and still lets
 * a client fill it with lies. It is the **subscription set**: `record` writes only
 * where `subscribed(socket, room)` says the socket is in the room right now, and
 * `subscribe` is where authorization happens (`requireMembership`, before
 * `hub.subscribe`). So the entries a socket can hold are exactly the rooms it is
 * both subscribed to and authorized for, which is the same set the reconciler
 * would send it head frames about — and the map is bounded by the user's own room
 * count rather than by anything the client says. An unsubscribe or a close empties
 * it the way it always did.
 *
 * This also removes the affordance rather than validating it: a room the socket
 * cannot be told the head of has no acknowledgement worth recording.
 */

/** Everything this record needs from the outside: who is in which room. */
export interface HeadAcksOptions {
  /**
   * Is this socket currently subscribed to this room? Backed by `hub`, which is
   * the same map the head frame is delivered from — so "recorded" and
   * "deliverable" cannot describe different sets.
   */
  subscribed: (subscriberId: string, roomId: string) => boolean;
}

export interface HeadAcks {
  /**
   * Record what a socket says it holds. Monotonic per (socket, room): a cursor
   * cannot go backwards within one subscription, and a late-arriving ack that
   * names an older position must not re-open head frames the client has already
   * answered.
   *
   * Returns whether the acknowledgement was recorded. `false` means the socket is
   * not subscribed to that room, and nothing is stored — see the note above on
   * why the bound is the subscription set. The caller uses the answer to log; it
   * is deliberately not an error frame, because a `subscribe`/`unsubscribe` and an
   * in-flight `ack_head` can legitimately cross on the wire.
   */
  record: (subscriberId: string, roomId: string, roomSeq: number) => boolean;
  /** Does this socket still need to be told `head`? */
  behind: (subscriberId: string, roomId: string, head: number) => boolean;
  /** The acknowledged cursor, for tests and diagnostics. 0 when never told. */
  acknowledged: (subscriberId: string, roomId: string) => number;
  /**
   * A fresh subscription knows nothing. Called on `subscribe` so a re-join —
   * after an unsubscribe, or by a client that reset its journal — starts from
   * "has acknowledged nothing" rather than inheriting the previous run's word.
   */
  reset: (subscriberId: string, roomId: string) => void;
  /** One room, on unsubscribe. */
  forgetRoom: (subscriberId: string, roomId: string) => void;
  /**
   * Every room, on socket close. Without this the map grows one entry per
   * connection for the life of the process — the same slow-fuse leak `hub`'s
   * empty-room deletion exists to avoid.
   */
  forget: (subscriberId: string) => void;
  /** Sockets currently tracked. Asserted by a test, so the leak stays closed. */
  size: () => number;
  /** Rooms tracked for one socket. Asserted by a test, so the bound stays real. */
  roomCount: (subscriberId: string) => number;
}

export function createHeadAcks({ subscribed }: HeadAcksOptions): HeadAcks {
  const bySubscriber = new Map<string, Map<string, number>>();

  const rooms = (subscriberId: string): Map<string, number> => {
    let existing = bySubscriber.get(subscriberId);
    if (!existing) {
      existing = new Map();
      bySubscriber.set(subscriberId, existing);
    }
    return existing;
  };

  return {
    record: (subscriberId, roomId, roomSeq) => {
      if (!Number.isFinite(roomSeq) || roomSeq < 0) return false;
      // The bound, and the authorization: a socket may only speak about rooms it
      // is in, and it is only in rooms `handleSubscribe` let it into. Checked
      // before the map is touched, so a refused frame allocates nothing at all —
      // a check after `rooms(subscriberId)` would still have created the entry
      // this exists to prevent.
      if (!subscribed(subscriberId, roomId)) return false;
      const held = rooms(subscriberId);
      held.set(roomId, Math.max(held.get(roomId) ?? 0, roomSeq));
      return true;
    },
    behind: (subscriberId, roomId, head) =>
      (bySubscriber.get(subscriberId)?.get(roomId) ?? 0) < head,
    acknowledged: (subscriberId, roomId) => bySubscriber.get(subscriberId)?.get(roomId) ?? 0,
    reset: (subscriberId, roomId) => {
      rooms(subscriberId).set(roomId, 0);
    },
    forgetRoom: (subscriberId, roomId) => {
      const held = bySubscriber.get(subscriberId);
      if (!held) return;
      held.delete(roomId);
      if (held.size === 0) bySubscriber.delete(subscriberId);
    },
    forget: (subscriberId) => {
      bySubscriber.delete(subscriberId);
    },
    size: () => bySubscriber.size,
    roomCount: (subscriberId) => bySubscriber.get(subscriberId)?.size ?? 0,
  };
}
