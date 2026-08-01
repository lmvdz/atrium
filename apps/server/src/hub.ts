/**
 * Room fan-out: who is listening to what.
 *
 * Deliberately a plain in-process registry, with no persistence and no
 * cross-node bus. init.md prescribes one application server, and the durable
 * half of "did you get it?" is not this map — it is the ledger. A subscriber
 * that misses a broadcast (bad socket, GC pause, the process restarting) does
 * not lose the event; it reconnects and asks `since(room, room_seq)`. That is
 * the whole reason fan-out is allowed to be this simple, and why adding a
 * message bus later changes nothing about correctness.
 */

export interface Subscriber<T> {
  id: string;
  /** Deliver one frame. Must not throw; a dead socket is the caller's problem. */
  send: (frame: T) => void;
}

export interface Hub<T> {
  subscribe: (roomId: string, subscriber: Subscriber<T>) => void;
  unsubscribe: (roomId: string, subscriberId: string) => void;
  /** Drop a subscriber from every room — one call on socket close. */
  drop: (subscriberId: string) => void;
  /** Rooms this subscriber is in, for the reconnect/catch-up bookkeeping. */
  roomsOf: (subscriberId: string) => string[];
  /**
   * Every room with at least one subscriber on this instance.
   *
   * The reconciler's read: it costs one head query per pass over exactly the
   * rooms somebody is listening to, rather than over every room that has ever
   * existed. A room with no subscribers here needs no head frame, because there
   * is nobody on this instance to tell.
   */
  activeRooms: () => string[];
  /**
   * The room's subscribers, so a caller can decide per socket rather than per
   * room.
   *
   * `broadcast` is the right shape for an event — every subscriber wants it, by
   * definition. It is the wrong shape for a `head` frame, whose whole question is
   * *which* socket still needs telling (#22 r3 delta, blocking 1): a room-wide
   * broadcast is how r3's bookkeeping came to be keyed by room, and a per-room
   * key cannot say "bob has it, alice does not".
   *
   * A snapshot array rather than the live map, because the caller sends into
   * these and a `send` that closes a socket would otherwise mutate the map
   * mid-iteration.
   */
  subscribers: (roomId: string) => Subscriber<T>[];
  broadcast: (roomId: string, frame: T) => number;
  /**
   * Everyone in the room except one subscriber. Used for nothing today — the
   * sender wants its own ack *and* its own event, because the ack carries the
   * `room_seq` and the event carries the canonical body. Kept because "echo to
   * everyone but me" is the first thing anyone reaches for, and it should be
   * one call rather than a filtered loop written twice.
   */
  broadcastExcept: (roomId: string, exceptId: string, frame: T) => number;
  roomCount: () => number;
  subscriberCount: (roomId: string) => number;
}

export function createHub<T>(): Hub<T> {
  const rooms = new Map<string, Map<string, Subscriber<T>>>();
  const bySubscriber = new Map<string, Set<string>>();

  function subscribe(roomId: string, subscriber: Subscriber<T>): void {
    let members = rooms.get(roomId);
    if (!members) {
      members = new Map();
      rooms.set(roomId, members);
    }
    members.set(subscriber.id, subscriber);
    let joined = bySubscriber.get(subscriber.id);
    if (!joined) {
      joined = new Set();
      bySubscriber.set(subscriber.id, joined);
    }
    joined.add(roomId);
  }

  function unsubscribe(roomId: string, subscriberId: string): void {
    const members = rooms.get(roomId);
    if (members) {
      members.delete(subscriberId);
      // An empty room map is a leak with a slow fuse: one entry per room ever
      // visited, forever.
      if (members.size === 0) rooms.delete(roomId);
    }
    const joined = bySubscriber.get(subscriberId);
    if (joined) {
      joined.delete(roomId);
      if (joined.size === 0) bySubscriber.delete(subscriberId);
    }
  }

  return {
    subscribe,
    unsubscribe,
    drop: (subscriberId) => {
      for (const roomId of [...(bySubscriber.get(subscriberId) ?? [])]) {
        unsubscribe(roomId, subscriberId);
      }
      bySubscriber.delete(subscriberId);
    },
    roomsOf: (subscriberId) => [...(bySubscriber.get(subscriberId) ?? [])],
    // `unsubscribe` deletes a room's map when its last member leaves, so the
    // keys of `rooms` are exactly the rooms with a live subscriber.
    activeRooms: () => [...rooms.keys()],
    subscribers: (roomId) => [...(rooms.get(roomId)?.values() ?? [])],
    broadcast: (roomId, frame) => {
      const members = rooms.get(roomId);
      if (!members) return 0;
      let delivered = 0;
      for (const subscriber of members.values()) {
        subscriber.send(frame);
        delivered += 1;
      }
      return delivered;
    },
    broadcastExcept: (roomId, exceptId, frame) => {
      const members = rooms.get(roomId);
      if (!members) return 0;
      let delivered = 0;
      for (const subscriber of members.values()) {
        if (subscriber.id === exceptId) continue;
        subscriber.send(frame);
        delivered += 1;
      }
      return delivered;
    },
    roomCount: () => rooms.size,
    subscriberCount: (roomId) => rooms.get(roomId)?.size ?? 0,
  };
}
