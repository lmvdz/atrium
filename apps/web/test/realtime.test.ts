import { beforeEach, describe, expect, it } from 'vitest';
import {
  createRealtimeClient,
  localStorageJournal,
  memoryJournal,
  type RealtimeClient,
  type RealtimeClientOptions,
  type RoomEventEnvelope,
  type RoomJournal,
  type ServerFrame,
  type SocketLike,
} from '../src/lib/realtime.js';

/**
 * The client's three rules, exercised against a fake socket: `room_seq` is the
 * only cursor, a gap is always closed by asking, and the sole optimistic thing
 * is your own message row.
 *
 * A fake rather than a real server because these are *client* invariants —
 * what it does when frames arrive late, twice, or not at all. The same
 * behaviours against the real server, over real sockets, are in
 * `integration/server/reconnect.test.ts`.
 */

class FakeSocket implements SocketLike {
  readyState = 1;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  /** Server → client. */
  deliver(frame: ServerFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** The wire dying: no close frame from us, just gone. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  framesOfType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((frame) => frame.type === type);
  }

  commands(): Array<Record<string, unknown>> {
    return this.sent
      .filter((frame) => frame.type === 'command')
      .map((frame) => frame.command as Record<string, unknown>);
  }
}

const ME = 'user-me';
const ROOM = 'room-1';

const sockets: FakeSocket[] = [];
let client: RealtimeClient;
let errors: string[];

function messageEvent(
  roomSeq: number,
  body: string,
  userId = ME,
  clientMessageId: string | null = null,
): RoomEventEnvelope {
  return {
    roomId: ROOM,
    roomSeq,
    seq: roomSeq,
    // Beside the event, never inside it: #21 took the actor out of the payload
    // and the wire follows. A fixture that put one back would be describing a
    // shape the server can no longer produce.
    actor: { kind: 'human', userId },
    event: {
      id: `e${roomSeq}`,
      at: `2026-07-31T00:00:${String(roomSeq).padStart(2, '0')}.000Z`,
      type: 'message_posted',
      roomId: ROOM,
      messageId: `m${roomSeq}`,
      body,
      clientMessageId,
      replyToId: null,
      attachments: [],
    },
  };
}

function latest(): FakeSocket {
  const socket = sockets.at(-1);
  if (!socket) throw new Error('no socket was created');
  return socket;
}

/** A second client over the same fake-socket registry, connected and open. */
async function clientWith(overrides: Partial<RealtimeClientOptions> = {}): Promise<RealtimeClient> {
  const built = createRealtimeClient({
    userId: ME,
    url: 'ws://test/ws',
    reconnect: false,
    socketFactory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    onError: (message) => errors.push(message),
    ...overrides,
  });
  await built.connect();
  latest().open();
  return built;
}

beforeEach(async () => {
  sockets.length = 0;
  errors = [];
  client = createRealtimeClient({
    userId: ME,
    url: 'ws://test/ws',
    reconnect: { initialDelayMs: 1, maxDelayMs: 1, factor: 1 },
    socketFactory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    onError: (message) => errors.push(message),
  });
  await client.connect();
  latest().open();
});

describe('subscribe and catch up', () => {
  it('asks for everything it has never seen when it first joins', () => {
    client.join(ROOM);
    latest().deliver({ type: 'subscribed', roomId: ROOM, head: 3, seenSeq: 0 });
    expect(latest().framesOfType('since').at(-1)).toMatchObject({ roomId: ROOM, roomSeq: 0 });
  });

  it('applies a catch-up in order and moves the cursor to its end', () => {
    client.join(ROOM);
    latest().deliver({ type: 'subscribed', roomId: ROOM, head: 3, seenSeq: 0 });
    latest().deliver({
      type: 'catchup',
      roomId: ROOM,
      from: 0,
      to: 3,
      head: 3,
      more: false,
      entries: [messageEvent(1, 'a'), messageEvent(2, 'b'), messageEvent(3, 'c')],
    });
    expect(client.lastSeq(ROOM)).toBe(3);
    expect(client.room(ROOM).events.map((e) => e.roomSeq)).toEqual([1, 2, 3]);
  });

  it('keeps asking while a catch-up says there is more', () => {
    client.join(ROOM);
    latest().deliver({ type: 'subscribed', roomId: ROOM, head: 5, seenSeq: 0 });
    latest().deliver({
      type: 'catchup',
      roomId: ROOM,
      from: 0,
      to: 2,
      head: 5,
      more: true,
      entries: [messageEvent(1, 'a'), messageEvent(2, 'b')],
    });
    expect(latest().framesOfType('since').at(-1)).toMatchObject({ roomSeq: 2 });
  });

  /**
   * The r1 blocking finding, from the client's side.
   *
   * The server used to compute `more` from page fullness, so a partial page
   * delivered during concurrent writes said `more: false` while `to < head`.
   * Round 1's client did `if (frame.more) requestSince(...)` and therefore
   * stopped — permanently, if the burst had ended and no live event was coming
   * to reveal the hole. This frame is exactly that: the r1 server's output.
   *
   * Against the r1 client this test fails on the first assertion, because no
   * second `since` is ever sent.
   */
  it('asks again when the server says “no more” but its own cursor is behind the head', () => {
    client.join(ROOM);
    latest().deliver({ type: 'subscribed', roomId: ROOM, head: 5, seenSeq: 0 });
    const before = latest().framesOfType('since').length;

    latest().deliver({
      type: 'catchup',
      roomId: ROOM,
      from: 0,
      to: 2,
      head: 5,
      // The lie r1's arithmetic produced: a short page during concurrent
      // writes, reported as "you are caught up".
      more: false,
      entries: [messageEvent(1, 'a'), messageEvent(2, 'b')],
    });

    expect(latest().framesOfType('since').length).toBe(before + 1);
    expect(latest().framesOfType('since').at(-1)).toMatchObject({ roomSeq: 2 });

    // And the loop terminates when the cursor actually reaches the head.
    latest().deliver({
      type: 'catchup',
      roomId: ROOM,
      from: 2,
      to: 5,
      head: 5,
      more: false,
      entries: [messageEvent(3, 'c'), messageEvent(4, 'd'), messageEvent(5, 'e')],
    });
    expect(latest().framesOfType('since').length).toBe(before + 1);
    expect(client.lastSeq(ROOM)).toBe(5);
  });

  it('gives up loudly rather than spinning when catch-up makes no progress', () => {
    client.join(ROOM);
    latest().deliver({ type: 'subscribed', roomId: ROOM, head: 9, seenSeq: 0 });
    // A server that keeps naming a head it will not send: every round is a
    // request that comes back empty. The loop must not be infinite.
    for (let round = 0; round < 20; round += 1) {
      latest().deliver({
        type: 'catchup',
        roomId: ROOM,
        from: 0,
        to: 0,
        head: 9,
        more: true,
        entries: [],
      });
    }
    expect(latest().framesOfType('since').length).toBeLessThanOrEqual(10);
    expect(errors.some((message) => message.includes('stalled'))).toBe(true);
  });

  it('resumes from a durable journal rather than replaying the room', async () => {
    const journal = memoryJournal();
    for (const roomSeq of [1, 2, 3, 4, 5, 6, 7]) {
      journal.commit(ROOM, messageEvent(roomSeq, `m${roomSeq}`), roomSeq);
    }
    const resumed = await clientWith({ journal });
    resumed.join(ROOM);
    latest().deliver({ type: 'subscribed', roomId: ROOM, head: 9, seenSeq: 0 });
    expect(latest().framesOfType('since').at(-1)).toMatchObject({ roomSeq: 7 });
    // And it resumes holding the history, not only the number. A cursor without
    // its events is the failure `RoomJournal` exists to make unrepresentable —
    // catches: seeding `lastSeq` from the store while leaving `events` empty,
    // which is what r2's `WatermarkStore` did by construction.
    expect(resumed.room(ROOM).events.map((e) => e.roomSeq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('asks for a bounded page when one is configured', async () => {
    const bounded = await clientWith({ catchUpPageSize: 5 });
    bounded.join(ROOM);
    latest().deliver({ type: 'subscribed', roomId: ROOM, head: 12, seenSeq: 0 });
    // Catches: dropping `limit` from `requestSince`. Without it the client asks
    // for the server's 1000-entry default, and no fixture in this repo is large
    // enough to produce a second page — which is exactly how multi-page catch-up
    // went unexercised against a real database (r2 delta, major 2).
    expect(latest().framesOfType('since').at(-1)).toMatchObject({ roomSeq: 0, limit: 5 });
  });
});

/**
 * Crash-safety of the cursor (#22 gauntlet r2 delta, major 1).
 *
 * The finding: the watermark advanced *after* the in-memory list was mutated, so
 * a crash in between resumed past an event nothing held. Each test below states
 * the source mutation it catches.
 */
describe('the cursor never names an event the client does not hold', () => {
  /** A journal that dies partway through a page, the way a killed tab does. */
  function journalDyingAfter(commits: number): { journal: RoomJournal; survivor: RoomJournal } {
    const survivor = memoryJournal();
    let committed = 0;
    return {
      survivor,
      journal: {
        load: survivor.load,
        reset: survivor.reset,
        commit: (roomId, entry, lastSeq) => {
          if (committed >= commits) throw new Error('journal died mid-page');
          committed += 1;
          survivor.commit(roomId, entry, lastSeq);
        },
      },
    };
  }

  it('resumes at the last entry it durably committed when it dies mid-page', async () => {
    // Three of five, then the process is gone.
    const { journal, survivor } = journalDyingAfter(3);
    const dying = await clientWith({ journal });
    dying.join(ROOM);
    latest().deliver({ type: 'subscribed', roomId: ROOM, head: 5, seenSeq: 0 });
    expect(() =>
      latest().deliver({
        type: 'catchup',
        roomId: ROOM,
        from: 0,
        to: 5,
        head: 5,
        more: false,
        entries: [1, 2, 3, 4, 5].map((n) => messageEvent(n, `m${n}`)),
      }),
    ).toThrow('journal died mid-page');

    // The ordering property, asserted on the client that died rather than on
    // the one that resumes.
    //
    // This is the assertion that makes the test about `applyEntry`'s ordering
    // instead of about the store. With one journal holding both halves, "commit
    // then apply" and "apply then commit" leave the *same* durable state after a
    // crash — so a resumed-client assertion alone cannot tell them apart, and an
    // earlier draft of this test claimed a mutation it did not catch. What
    // differs is the live client's own cursor at the moment of the throw: under
    // r2's ordering it has already advanced to 4, a position nothing made
    // durable and which the next `since` would therefore ask from *past*.
    //
    // Catches: moving `journal.commit` after the in-memory push in `applyEntry`.
    expect(dying.lastSeq(ROOM)).toBe(3);

    // The crash: every in-memory thing above is gone and only what the journal
    // made durable survives. A fresh client over that journal is what a reload
    // is.
    const resumed = await clientWith({ journal: survivor });
    resumed.join(ROOM);
    latest().deliver({ type: 'subscribed', roomId: ROOM, head: 5, seenSeq: 0 });

    // Catches: splitting the journal back into a cursor and an event list
    // written separately — r2's `WatermarkStore` by construction. Under that
    // shape the resumed cursor names a position whose event the client does not
    // hold, and the `since` below asks from past the hole, so the entry is lost
    // permanently and silently.
    expect(resumed.lastSeq(ROOM)).toBe(3);
    expect(resumed.room(ROOM).events.map((e) => e.roomSeq)).toEqual([1, 2, 3]);
    expect(latest().framesOfType('since').at(-1)).toMatchObject({ roomSeq: 3 });
  });

  it('leaves its own cursor where it was when the journal refuses an entry', async () => {
    const { journal } = journalDyingAfter(2);
    const fragile = await clientWith({ journal });
    fragile.join(ROOM);
    latest().deliver({ type: 'subscribed', roomId: ROOM, head: 2, seenSeq: 0 });
    latest().deliver({
      type: 'catchup',
      roomId: ROOM,
      from: 0,
      to: 2,
      head: 2,
      more: false,
      entries: [messageEvent(1, 'a'), messageEvent(2, 'b')],
    });
    expect(fragile.lastSeq(ROOM)).toBe(2);

    // Catches: advancing `room.lastSeq` before the commit succeeds. The third
    // entry cannot be made durable, so the live cursor must stay at 2 — one that
    // ran ahead of the journal would make the entry unrecoverable, because the
    // next `since` asks from past it.
    expect(() => latest().deliver({ type: 'event', entry: messageEvent(3, 'c') })).toThrow();
    expect(fragile.lastSeq(ROOM)).toBe(2);
    expect(fragile.room(ROOM).events.map((e) => e.roomSeq)).toEqual([1, 2]);
  });
});

/**
 * `localStorageJournal` — the durable implementation, and the one where the
 * atomicity claim has to be earned rather than inherited.
 *
 * `localStorage` offers no transaction across two keys, so the whole reason this
 * is a journal and not a watermark is that both halves live under one key and
 * one `setItem`.
 */
describe('the durable journal writes both halves or neither', () => {
  function fakeStorage(): Storage & { raw: Map<string, string> } {
    const raw = new Map<string, string>();
    const store = {
      raw,
      getItem: (key: string) => raw.get(key) ?? null,
      setItem: (key: string, value: string) => {
        raw.set(key, value);
      },
      removeItem: (key: string) => {
        raw.delete(key);
      },
      clear: () => raw.clear(),
      key: (index: number) => [...raw.keys()][index] ?? null,
      get length() {
        return raw.size;
      },
    };
    return store as unknown as Storage & { raw: Map<string, string> };
  }

  let storage: ReturnType<typeof fakeStorage>;
  beforeEach(() => {
    storage = fakeStorage();
    (globalThis as { localStorage?: Storage }).localStorage = storage;
  });

  it('persists the events and the cursor under one key, in one write', () => {
    const journal = localStorageJournal('test');
    journal.commit(ROOM, messageEvent(1, 'a'), 1);
    journal.commit(ROOM, messageEvent(2, 'b'), 2);
    // Catches: writing the cursor and the events to two keys. Two keys is two
    // writes with no transaction between them, which is precisely the window
    // `RoomJournal` exists to close — and `localStorage` gives no way to close
    // it other than by not opening it.
    expect(storage.raw.size).toBe(1);
    expect(journal.load(ROOM)).toMatchObject({ lastSeq: 2 });
    expect(journal.load(ROOM).events.map((e) => e.roomSeq)).toEqual([1, 2]);
  });

  it('reads a torn record as no history at all', () => {
    const journal = localStorageJournal('test');
    journal.commit(ROOM, messageEvent(1, 'a'), 1);
    const [key] = [...storage.raw.keys()];
    // A cursor naming a position past the last event held — the exact state the
    // commit path cannot produce, arriving from a partial write, a hand edit, or
    // an older format. Catches: dropping the `lastSeq !== held` check in
    // `readRoom`, which lets the client resume into a hole and ask `since` from
    // past it. Replaying a room is cheap; resuming into a gap is not.
    storage.setItem(key as string, JSON.stringify({ events: [], lastSeq: 9 }));
    expect(journal.load(ROOM)).toEqual({ events: [], lastSeq: 0 });

    storage.setItem(key as string, 'not json');
    expect(journal.load(ROOM)).toEqual({ events: [], lastSeq: 0 });
  });

  it('reads a poisoned record as no history at all', () => {
    /**
     * The journal is durable state this client reads back and *believes*
     * (#22 gauntlet r6, major 1). Until r7 the read did
     * `parsed.events as RoomEventEnvelope[]` behind two `typeof` checks, so a
     * record whose entries were not entries resumed anyway — and the `lastSeq`
     * that came with it is a cursor every real event at or below it is then
     * silently skipped against.
     *
     * `localStorage` is shared with everything else on the origin and survives
     * reloads, which makes it the most *durable* attacker-reachable input in this
     * file, not the least. It was the last thing here still going through a cast.
     *
     * Strict is safe on this path and only on this path: the answer to an
     * unreadable record is already "no history, refetch the room", which costs a
     * round trip. Catches: restoring the cast.
     */
    const journal = localStorageJournal('test');
    journal.commit(ROOM, messageEvent(1, 'a'), 1);
    const [key] = [...storage.raw.keys()];
    const good = messageEvent(1, 'a');

    for (const events of [
      [{ ...good, roomSeq: '1' }],
      [{ ...good, actor: null }],
      [{ ...good, event: { id: 'e1', at: '2026-07-31T00:00:01.000Z' } }],
      ['not an entry at all'],
      [null],
    ]) {
      storage.setItem(key as string, JSON.stringify({ events, lastSeq: 1 }));
      expect(journal.load(ROOM)).toEqual({ events: [], lastSeq: 0 });
    }

    // …and the honest record still loads, so this is a check and not a ban.
    storage.setItem(key as string, JSON.stringify({ events: [good], lastSeq: 1 }));
    expect(journal.load(ROOM)).toMatchObject({ lastSeq: 1 });
  });

  /**
   * Bounded, and never a throw (#22 gauntlet r3 delta, major 2).
   *
   * > `localStorageJournal` is unbounded with no `QuotaExceededError` handling —
   * > a long room throws on every `applyEntry` after quota and stalls durable
   * > apply.
   *
   * The second clause is the one with teeth. `applyEntry` commits before moving
   * the in-memory view, so a throw from the journal leaves the client's cursor
   * where it was — deliberately, because that is what makes a crash mid-page
   * safe. A *permanent* throw turns that same property into a permanent stall:
   * every event takes the same path, fails the same way, and the room stops
   * advancing while the socket carries on delivering.
   */
  function quotaError(): Error {
    const error = new Error('quota');
    error.name = 'QuotaExceededError';
    return error;
  }

  it('keeps a bounded window rather than growing until the store refuses it', () => {
    // Catches: dropping the trim. Unbounded is not a slow leak here — it is a
    // guarantee of reaching the quota on any room that runs long enough, and the
    // failure at that point is the stall below.
    const journal = localStorageJournal('test', { maxEvents: 3 });
    for (let seq = 1; seq <= 6; seq += 1) journal.commit(ROOM, messageEvent(seq, `m${seq}`), seq);
    const held = journal.load(ROOM);
    expect(held.events.map((e) => e.roomSeq)).toEqual([4, 5, 6]);
    // Evicted from the front, so the cursor still names the last event held —
    // the invariant the whole interface exists for, unchanged by the bound.
    expect(held.lastSeq).toBe(6);
  });

  it('evicts harder rather than throwing when the store says it is full', () => {
    // A store that fits four entries but not five. Catches: letting the
    // `setItem` rejection escape `commit`, which stalls `applyEntry` for the
    // rest of the room's life.
    let capacity = 4;
    const inner = storage.setItem.bind(storage);
    storage.setItem = (key: string, value: string) => {
      if ((JSON.parse(value) as { events: unknown[] }).events.length > capacity) throw quotaError();
      inner(key, value);
    };
    const journal = localStorageJournal('test', { maxEvents: 100 });
    for (let seq = 1; seq <= 8; seq += 1) {
      expect(() => journal.commit(ROOM, messageEvent(seq, `m${seq}`), seq)).not.toThrow();
    }
    const held = journal.load(ROOM);
    expect(held.lastSeq).toBe(8);
    expect(held.events.at(-1)?.roomSeq).toBe(8);
    expect(held.events.length).toBeLessThanOrEqual(4);
    capacity = 100;
  });

  it('falls back to memory, loudly, when even one entry will not fit', () => {
    // The floor: a store that refuses everything. Catches: throwing here, and
    // catches degrading in silence — a client that has quietly stopped being
    // durable re-reads its whole history on the next load, which an operator
    // should be able to find out rather than infer.
    const degraded: Array<{ roomId: string; reason: string }> = [];
    storage.setItem = () => {
      throw quotaError();
    };
    const journal = localStorageJournal('test', {
      maxEvents: 10,
      onDegraded: (roomId, reason) => degraded.push({ roomId, reason }),
    });
    expect(() => journal.commit(ROOM, messageEvent(1, 'a'), 1)).not.toThrow();
    expect(() => journal.commit(ROOM, messageEvent(2, 'b'), 2)).not.toThrow();

    expect(degraded).toHaveLength(1);
    expect(degraded[0]?.roomId).toBe(ROOM);
    expect(degraded[0]?.reason).toContain('localStorage is full');
    // Still a working journal: the cursor names an event it holds, which is the
    // only promise `RoomJournal` makes. Catches: marking the room degraded
    // without seeding the memory fallback, which would leave `load` reporting a
    // cursor of 0 for a client that has applied two events.
    expect(journal.load(ROOM)).toMatchObject({ lastSeq: 2 });
    expect(journal.load(ROOM).events.map((e) => e.roomSeq)).toEqual([1, 2]);
  });

  it('keeps applying events after the journal has degraded', async () => {
    // The finding's actual symptom, at the client rather than at the journal:
    // durable apply must not stall. Catches: any version of `commit` that
    // throws on a full store — `applyEntry` would leave `lastSeq` where it was
    // and every subsequent event would arrive across a gap it never closes.
    storage.setItem = () => {
      throw quotaError();
    };
    const journal = localStorageJournal('test', { maxEvents: 10 });
    const stalling = await clientWith({ journal });
    stalling.join(ROOM);
    latest().deliver({ type: 'subscribed', roomId: ROOM, head: 0, seenSeq: 0 });
    for (let seq = 1; seq <= 5; seq += 1) {
      latest().deliver({ type: 'event', entry: messageEvent(seq, `m${seq}`) });
    }
    expect(stalling.lastSeq(ROOM)).toBe(5);
    expect(stalling.room(ROOM).events.map((e) => e.roomSeq)).toEqual([1, 2, 3, 4, 5]);
  });

  /**
   * "Never throws" and "never silent", made true (#22 gauntlet r4 delta, major).
   *
   * > the journal's `commit` can throw — `getItem` is outside the storage `try`,
   * > and an `onDegraded` callback may throw — and degrades silently when no
   * > callback is supplied.
   *
   * All three clauses granted, and each gets its own test, because they fail in
   * different places and a single "it does not throw" would pass on two of them
   * while the third stayed open. The r3 tests above only ever made `setItem`
   * throw, which is why the read path and the callback survived a whole round.
   */
  it('survives a store that refuses to be read', () => {
    /**
     * Some browsers refuse storage on *access* (already handled) and some on
     * *use*, and Safari's private mode has done both across versions. Round 4's
     * `getItem` sat outside the try, so a read that threw escaped `commit`
     * directly — the same permanent stall the whole finding is about, reached
     * through the other half of the API.
     *
     * Catches: moving `store.getItem` back outside its `try` in `readDurable`,
     * which is the mutant `journal_getitem_outside_the_try`.
     */
    const degraded: string[] = [];
    storage.getItem = () => {
      throw new Error('SecurityError: the operation is insecure');
    };
    const journal = localStorageJournal('test', {
      maxEvents: 10,
      onDegraded: (_roomId, reason) => degraded.push(reason),
    });

    expect(() => journal.commit(ROOM, messageEvent(1, 'a'), 1)).not.toThrow();
    expect(() => journal.load(ROOM)).not.toThrow();
    expect(() => journal.commit(ROOM, messageEvent(2, 'b'), 2)).not.toThrow();

    // Degraded, reported, and — the part that is easy to lose — still holding the
    // events it was given. A read that throws must not be reported as "no
    // history": that is a legitimate answer meaning "fresh room", and returning it
    // here would silently re-fetch for ever.
    expect(degraded).toHaveLength(1);
    // "unusable", not "refused the write": this failure is a refused *read*, and
    // r5's wording named the wrong operation for two of the three throws it
    // described.
    expect(degraded[0]).toContain('localStorage is unusable');
    expect(journal.load(ROOM)).toMatchObject({ lastSeq: 2 });
    expect(journal.load(ROOM).events.map((e) => e.roomSeq)).toEqual([1, 2]);
  });

  it('survives an onDegraded callback that throws', () => {
    // The journal's contract is that `commit` does not throw. A contract a
    // caller's logging can break is not a contract — and this one breaks at the
    // worst moment, since the callback only runs when something has already gone
    // wrong. Catches: dropping the `try` around the report in `degrade`, which is
    // the mutant `journal_lets_the_callback_throw`.
    storage.setItem = () => {
      throw quotaError();
    };
    const journal = localStorageJournal('test', {
      maxEvents: 10,
      onDegraded: () => {
        throw new Error('the operator’s logger is having a day');
      },
    });
    expect(() => journal.commit(ROOM, messageEvent(1, 'a'), 1)).not.toThrow();
    expect(() => journal.commit(ROOM, messageEvent(2, 'b'), 2)).not.toThrow();
    // …and the degradation still happened, so the swallow is a swallow of the
    // callback and not of the fallback.
    expect(journal.load(ROOM)).toMatchObject({ lastSeq: 2 });
  });

  it('warns when nobody asked to be told, so degradation is never silent', () => {
    /**
     * Round 4 made `onDegraded` opt-in, so the default behaviour of a journal that
     * had stopped being durable was to say nothing at all. The finding is right
     * that this is the failure the option exists to surface: the client keeps
     * working, re-reads its whole history on every load, and nothing anywhere
     * records why.
     *
     * The default is now a warning. Silence takes an explicit `() => {}`, which is
     * a decision somebody wrote down. Catches: restoring `options.onDegraded?.(…)`
     * at the call site — the mutant `journal_degrades_silently`.
     */
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      storage.setItem = () => {
        throw quotaError();
      };
      const journal = localStorageJournal('test', { maxEvents: 10 });
      journal.commit(ROOM, messageEvent(1, 'a'), 1);
      journal.commit(ROOM, messageEvent(2, 'b'), 2);

      // Once per room, not once per commit: a warning on every event is a warning
      // nobody reads.
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0]?.[0])).toContain(ROOM);
      expect(String(warnings[0]?.[0])).toContain('localStorage is full');

      // And an explicit no-op really is silent, so the default is a default rather
      // than a rule.
      const quiet = localStorageJournal('quiet', { maxEvents: 10, onDegraded: () => {} });
      quiet.commit(ROOM, messageEvent(1, 'a'), 1);
      expect(warnings).toHaveLength(1);
    } finally {
      console.warn = original;
    }
  });

  /**
   * The fourth way out (#22 gauntlet r5 delta, major 3).
   *
   * > `storage()` returns `null` when access itself throws (private mode), and
   * > `commit` falls back to memory without `report`/`warnDegraded`. The three
   * > closed throws are real; "never degrades in silence" is not yet true.
   *
   * Granted, and it is the same shape as the three round 5 did close: a `catch`
   * that answers with a *value* instead of reporting a *fact*. `storage()`
   * collapsed both "this browser refuses storage on access" and "there is no
   * `localStorage` here at all" into `null`, and `null` gave every caller
   * downstream something to fall back to and nothing to say.
   *
   * ## Two tests, and the split is `commit` against `load` rather than the two
   * ways of getting `null`
   *
   * That was the first draft's split and **the mutant ledger refused it**: the
   * mutation that removes the report from `commit` left the second test green,
   * because that test committed first and then loaded, and `load` reported for
   * it. Recorded rather than only fixed — a test that passes because a *different*
   * site did the work is the "caught by the wrong test" vacuity this ledger exists
   * to rule out, and here it was the ledger that said so rather than a reviewer.
   *
   * `commit` and `load` are two entry points and either can be the first call a
   * room ever makes, so both have to report. Once a room is degraded the other one
   * short-circuits, which means the only way to measure a site is to reach it
   * first: the first test commits before loading, the second loads before
   * committing, and each has its own mutant.
   */
  it('says so when there is no localStorage to be durable in', () => {
    /**
     * Server-side rendering, a hardened embedder, an old WebView: the global is
     * simply absent. The journal still works — it is a memory journal now — and
     * the caller is told once per room rather than discovering it as a room that
     * re-reads its whole history on every load for ever.
     *
     * Commits before it loads, so the site under measurement is `commit`'s.
     * Catches: `journal_null_store_degrades_silently` — the fallback without the
     * `degrade`, which is r5's `commit` exactly.
     */
    (globalThis as { localStorage?: Storage }).localStorage = undefined;
    const degraded: Array<[string, string]> = [];
    const journal = localStorageJournal('test', {
      maxEvents: 10,
      onDegraded: (roomId, reason) => degraded.push([roomId, reason]),
    });

    expect(() => journal.commit(ROOM, messageEvent(1, 'a'), 1)).not.toThrow();
    journal.commit(ROOM, messageEvent(2, 'b'), 2);

    // Once per room, and it says which room and why.
    expect(degraded).toHaveLength(1);
    expect(degraded[0]?.[0]).toBe(ROOM);
    expect(degraded[0]?.[1]).toContain('not available');
    // …and the events are still there, in memory. A journal that reported its
    // degradation and then dropped the event would be trading one defect for a
    // worse one.
    expect(journal.load(ROOM)).toMatchObject({ lastSeq: 2 });
    expect(journal.load(ROOM).events.map((e) => e.roomSeq)).toEqual([1, 2]);
  });

  it('says so when the store throws on access, not on use', () => {
    /**
     * The private-mode case the finding names. Reading the `localStorage` *getter*
     * throws before any method is called, so every guard that wrapped `getItem` or
     * `setItem` was downstream of the failure — which is why this was the one
     * degradation left silent after the round that closed the other three.
     *
     * **Loads before it commits**, which is the whole point of the ordering: a
     * client that opens a room it has been in before reads first, and `readDurable`
     * is then the site that has to report. Returning `{events: [], lastSeq: 0}`
     * there — r5's behaviour — is the worse of the two silences, because "no
     * history" is a legitimate answer meaning "fresh room".
     *
     * Catches: `journal_null_store_reads_as_no_history`.
     */
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: access to storage is denied');
      },
    });
    try {
      const degraded: string[] = [];
      const journal = localStorageJournal('test', {
        maxEvents: 10,
        onDegraded: (_roomId, reason) => degraded.push(reason),
      });

      expect(() => journal.load(ROOM)).not.toThrow();
      // Reported by the read, before anything was ever committed.
      expect(degraded).toHaveLength(1);
      expect(degraded[0]).toContain('SecurityError');

      expect(() => journal.commit(ROOM, messageEvent(1, 'a'), 1)).not.toThrow();
      // Still once: the room is degraded now and every later call short-circuits.
      expect(degraded).toHaveLength(1);
      expect(journal.load(ROOM)).toMatchObject({ lastSeq: 1 });
    } finally {
      // Back to a plain data property, or every later test in this file inherits
      // a throwing global.
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        writable: true,
        value: storage,
      });
    }
  });
});

/**
 * The unsolicited head frame (#22 gauntlet r2 delta, blocking 1, client half).
 *
 * The server's reconciler sends it on a timer for every subscribed room. It is
 * the gap signal that survives a lost frame: a client that missed an `event`
 * broadcast has nothing to notice, and this is what it notices instead.
 */
describe('an unsolicited head frame closes a gap the client could not see', () => {
  it('asks for the gap when told the room is ahead of its cursor', () => {
    client.join(ROOM);
    latest().deliver({ type: 'subscribed', roomId: ROOM, head: 1, seenSeq: 0 });
    latest().deliver({
      type: 'catchup',
      roomId: ROOM,
      from: 0,
      to: 1,
      head: 1,
      more: false,
      entries: [messageEvent(1, 'a')],
    });
    const before = latest().framesOfType('since').length;

    // No event frame ever arrived for 2 or 3 — that is the failure being
    // covered. Catches: dropping the `head` case from `handleFrame`, which
    // leaves this client at 1 forever with nothing able to tell it otherwise.
    latest().deliver({ type: 'head', roomId: ROOM, head: 3 });
    expect(latest().framesOfType('since').length).toBe(before + 1);
    expect(latest().framesOfType('since').at(-1)).toMatchObject({ roomSeq: 1 });
  });

  it('does nothing when the head it is told is one it already reached', () => {
    client.join(ROOM);
    latest().deliver({ type: 'subscribed', roomId: ROOM, head: 1, seenSeq: 0 });
    latest().deliver({
      type: 'catchup',
      roomId: ROOM,
      from: 0,
      to: 1,
      head: 1,
      more: false,
      entries: [messageEvent(1, 'a')],
    });
    const before = latest().framesOfType('since').length;
    // Catches: asking on every head frame rather than only when behind, which
    // would turn a reconciliation tick into a per-room request loop.
    latest().deliver({ type: 'head', roomId: ROOM, head: 1 });
    expect(latest().framesOfType('since').length).toBe(before);
  });

  /**
   * The client half of #22 gauntlet r3 delta, blocking 1.
   *
   * The server repeats a `head` frame to a socket until that socket says what it
   * holds, because the alternative — retiring it when the server has *sent*
   * something — is the send that may have failed being read as proof it did not.
   * That only works if the client answers.
   */
  it('tells the server what it holds every time it is told a head', () => {
    client.join(ROOM);
    latest().deliver({ type: 'subscribed', roomId: ROOM, head: 1, seenSeq: 0 });
    latest().deliver({
      type: 'catchup',
      roomId: ROOM,
      from: 0,
      to: 1,
      head: 1,
      more: false,
      entries: [messageEvent(1, 'a')],
    });
    const before = latest().framesOfType('ack_head').length;

    // Behind: it asks for the gap *and* answers, because "I am at 1, you said
    // 3" is what stops the server guessing. Catches: acknowledging only when
    // caught up, which leaves a client that is mid-catch-up indistinguishable
    // from one whose socket is dead.
    latest().deliver({ type: 'head', roomId: ROOM, head: 3 });
    expect(latest().framesOfType('ack_head').length).toBe(before + 1);
    expect(latest().framesOfType('ack_head').at(-1)).toEqual({
      type: 'ack_head',
      roomId: ROOM,
      roomSeq: 1,
    });

    // Caught up: answers again, with the position that retires the frame.
    // Catches: dropping the acknowledgement entirely, which leaves the server
    // sending one head frame per room per pass forever.
    latest().deliver({
      type: 'catchup',
      roomId: ROOM,
      from: 1,
      to: 3,
      head: 3,
      more: false,
      entries: [messageEvent(2, 'b'), messageEvent(3, 'c')],
    });
    expect(latest().framesOfType('ack_head').at(-1)).toEqual({
      type: 'ack_head',
      roomId: ROOM,
      roomSeq: 3,
    });
  });

  it('does not acknowledge a catch-up it is still in the middle of', () => {
    // A page that says `more` is not a position worth retiring a head frame on.
    // Catches: acknowledging on every catch-up frame rather than on the one that
    // ends the loop — the server would then stop telling a client that is still
    // several pages behind, which is exactly the premature silence this whole
    // finding is about.
    client.join(ROOM);
    latest().deliver({ type: 'subscribed', roomId: ROOM, head: 4, seenSeq: 0 });
    const before = latest().framesOfType('ack_head').length;
    latest().deliver({
      type: 'catchup',
      roomId: ROOM,
      from: 0,
      to: 2,
      head: 4,
      more: true,
      entries: [messageEvent(1, 'a'), messageEvent(2, 'b')],
    });
    expect(latest().framesOfType('ack_head').length).toBe(before);
  });
});

describe('the cursor is the only thing that decides', () => {
  beforeEach(() => {
    client.join(ROOM);
    latest().deliver({ type: 'subscribed', roomId: ROOM, head: 0, seenSeq: 0 });
    latest().deliver({
      type: 'catchup',
      roomId: ROOM,
      from: 0,
      to: 0,
      head: 0,
      more: false,
      entries: [],
    });
  });

  it('applies a live event that is exactly the next one', () => {
    latest().deliver({ type: 'event', entry: messageEvent(1, 'hello') });
    expect(client.lastSeq(ROOM)).toBe(1);
    expect(client.room(ROOM).events).toHaveLength(1);
  });

  it('ignores a redelivered event rather than doubling it', () => {
    latest().deliver({ type: 'event', entry: messageEvent(1, 'hello') });
    latest().deliver({ type: 'event', entry: messageEvent(1, 'hello') });
    expect(client.room(ROOM).events).toHaveLength(1);
    expect(client.lastSeq(ROOM)).toBe(1);
  });

  it('refuses to apply an event across a gap, and asks for the gap instead', () => {
    latest().deliver({ type: 'event', entry: messageEvent(1, 'one') });
    const before = latest().framesOfType('since').length;

    // 2 never arrived.
    latest().deliver({ type: 'event', entry: messageEvent(3, 'three') });

    expect(client.lastSeq(ROOM)).toBe(1);
    expect(client.room(ROOM).events.map((e) => e.roomSeq)).toEqual([1]);
    expect(latest().framesOfType('since').length).toBe(before + 1);
    expect(latest().framesOfType('since').at(-1)).toMatchObject({ roomSeq: 1 });

    // ...and the catch-up puts both in, in order.
    latest().deliver({
      type: 'catchup',
      roomId: ROOM,
      from: 1,
      to: 3,
      head: 3,
      more: false,
      entries: [messageEvent(2, 'two'), messageEvent(3, 'three')],
    });
    expect(client.room(ROOM).events.map((e) => e.roomSeq)).toEqual([1, 2, 3]);
  });
});

/**
 * The client parses what arrives; it does not cast it (#22 gauntlet r6, major 1).
 *
 * `applyEntry` is the only thing in this file that writes durable state — it
 * commits to the journal and moves `lastSeq` — and until r7 the only thing
 * standing between a socket frame and that write was
 * `JSON.parse(String(event.data)) as ServerFrame`. The r6 gauntlet reached the
 * socket from outside the application entirely (an unprivileged `NOTIFY` on the
 * ephemeral bus, relayed by the server without validation), and what made the
 * consequence *durable* rather than cosmetic was this end: an entry accepted
 * here is an entry the journal still holds after a reload, and a `roomSeq`
 * accepted here is a position the real event can never take
 * (`if (entry.roomSeq <= room.lastSeq) return`).
 *
 * The server-side hole is closed in `apps/server/src/event-bus.ts`. These are
 * the assertions that this end refuses to write something it cannot read,
 * which is worth having whoever sent it.
 *
 * Deliberately checked here: the *envelope*. The event body is passed through,
 * because this client counts positions and renders messages rather than folding
 * events, and a per-kind schema here would be #46's outage — one unreadable row
 * taking a whole room's catch-up down — arriving in a new place.
 */
describe('a frame the client cannot read is refused, not written', () => {
  function raw(frame: unknown): void {
    latest().onmessage?.({ data: JSON.stringify(frame) });
  }

  beforeEach(() => {
    client.join(ROOM);
    latest().deliver({ type: 'subscribed', roomId: ROOM, head: 0, seenSeq: 0 });
    latest().deliver({
      type: 'catchup',
      roomId: ROOM,
      from: 0,
      to: 0,
      head: 0,
      more: false,
      entries: [],
    });
  });

  it('does not move the cursor for an event whose envelope does not parse', () => {
    const good = messageEvent(1, 'the real one');
    // Every one of these would have been committed and would have advanced
    // `lastSeq` to 1 under a cast — taking position 1 away from `good` for good.
    const forgeries: unknown[] = [
      { type: 'event', entry: { ...good, roomSeq: '1' } },
      { type: 'event', entry: { ...good, roomSeq: 0 } },
      { type: 'event', entry: { ...good, seq: null } },
      { type: 'event', entry: { ...good, actor: 'alice' } },
      { type: 'event', entry: { ...good, event: { id: 'e1', at: '2026-07-31T00:00:01.000Z' } } },
      { type: 'event', entry: { ...good, roomId: 42 } },
      { type: 'event' },
      { type: 'nonsense', entry: good },
    ];
    for (const forgery of forgeries) raw(forgery);

    expect(client.lastSeq(ROOM)).toBe(0);
    expect(client.room(ROOM).events).toEqual([]);
    expect(errors.length).toBe(forgeries.length);
    for (const message of errors) expect(message).toContain('cannot read');

    // …and the position is still there for the event that really holds it.
    latest().deliver({ type: 'event', entry: good });
    expect(client.lastSeq(ROOM)).toBe(1);
    expect(client.room(ROOM).events).toHaveLength(1);
  });

  it('refuses a catch-up page whose entries name a different room', () => {
    /**
     * The loop does its arithmetic against `view(frame.roomId)` while
     * `applyEntry` files each entry under `entry.roomId`, so a page whose entries
     * name another room would move one room's journal on another room's cursor.
     *
     * On the server both come from one query and cannot disagree. Here they are
     * two fields of a parsed message — which is the cross-check r7 added on the
     * bus (`EphemeralNote` refuses an envelope and a frame naming different
     * rooms) and had *not* added on the socket. Found by a foreign-lineage review
     * of r7's own diff; an asymmetry in the round's own fix.
     */
    raw({
      type: 'catchup',
      roomId: ROOM,
      from: 0,
      to: 1,
      head: 1,
      more: false,
      entries: [{ ...messageEvent(1, 'elsewhere'), roomId: 'room-2' }],
    });
    expect(client.lastSeq(ROOM)).toBe(0);
    expect(client.room('room-2').events).toEqual([]);
    expect(errors.at(-1)).toContain('cannot read');
  });

  it('refuses an event whose body carries an actor', () => {
    /**
     * `z.looseObject` keeps unknown keys, so `event.actor` survived the parse
     * while the comment beside it said "there is no such field" — found by a
     * foreign-lineage review, which ran a probe and got the forged actor back out
     * of the journal.
     *
     * The server refuses an actor in a payload three times over (`RoomEvent`'s
     * guard, `CoreEvent.parse`, and `core_events_payload_has_no_actor`), so a
     * body carrying one did not come from the ledger whatever else is true of it.
     */
    const forged = messageEvent(1, 'signed by somebody else');
    (forged.event as Record<string, unknown>).actor = { kind: 'human', userId: 'not-me' };
    raw({ type: 'event', entry: forged });
    expect(client.lastSeq(ROOM)).toBe(0);
    expect(client.room(ROOM).events).toEqual([]);
    expect(errors.at(-1)).toContain('cannot read');
  });

  it('refuses a catch-up page carrying one unreadable entry, and keeps the socket', () => {
    raw({
      type: 'catchup',
      roomId: ROOM,
      from: 0,
      to: 2,
      head: 2,
      more: false,
      entries: [messageEvent(1, 'one'), { ...messageEvent(2, 'two'), roomSeq: -2 }],
    });
    // The whole page, not the readable prefix: a page is one statement about a
    // range, and applying half of it would move the cursor to a position the
    // server never described.
    expect(client.lastSeq(ROOM)).toBe(0);
    expect(client.room(ROOM).events).toEqual([]);

    // The socket is still live — one bad frame is not a reason to stop reading.
    latest().deliver({
      type: 'catchup',
      roomId: ROOM,
      from: 0,
      to: 2,
      head: 2,
      more: false,
      entries: [messageEvent(1, 'one'), messageEvent(2, 'two')],
    });
    expect(client.lastSeq(ROOM)).toBe(2);
  });
});

/**
 * A journal the server contradicts is discarded (#22 gauntlet r7 self-review).
 *
 * Both foreign-lineage reviewers landed on the same hole in r7's first draft, and
 * they were right: **parsing the journal makes it well-formed, not authentic.**
 * `localStorage` is same-origin and carries no provenance, so a forgery that
 * satisfies every field type is trivial —
 * `{events: [{roomSeq: 50, …}], lastSeq: 50}` — and the client resumes room A at
 * 50 and skips every real position at or below it. That is the r6 exploit's
 * durable consequence reached from the other end, and schema validation is not an
 * answer to it.
 *
 * Arithmetic is, for the unbounded case. `frame.head` in the `subscribed` reply is
 * a number the client did not *write* — and r8 sharpens exactly that, because r7's
 * phrasing read stronger than it is. It is not a number an attacker cannot
 * influence or predict: same-origin JS can open its own socket, read the room's
 * true head, and plant at it. The last test here does that. What "did not write"
 * buys is only that the stored cursor is compared against a fetched fact instead
 * of against itself, so a cursor above the head is a claim about events the room
 * has never had. The room is dropped and re-read.
 *
 * What this does **not** do is stated in the source and asserted below: a forgery
 * at or under the true head still displaces real events, and nothing on this side
 * of the socket can tell. The bound is "a single forged record cannot take a room
 * out permanently", not "the journal is trustworthy".
 */
describe('a resumed cursor the server contradicts is not believed', () => {
  function fakeStorage(): Storage & { raw: Map<string, string> } {
    const raw = new Map<string, string>();
    const store = {
      raw,
      getItem: (key: string) => raw.get(key) ?? null,
      setItem: (key: string, value: string) => {
        raw.set(key, value);
      },
      removeItem: (key: string) => {
        raw.delete(key);
      },
      clear: () => raw.clear(),
      key: (index: number) => [...raw.keys()][index] ?? null,
      get length() {
        return raw.size;
      },
    };
    return store as unknown as Storage & { raw: Map<string, string> };
  }

  it('discards a well-formed journal that resumes past the room’s head', async () => {
    const storage = fakeStorage();
    (globalThis as { localStorage?: Storage }).localStorage = storage;
    const journal = localStorageJournal('poison');
    // Perfectly shaped, and a lie: the room has three events, this says fifty.
    journal.commit(ROOM, messageEvent(50, 'not in the ledger'), 50);
    expect(journal.load(ROOM).lastSeq).toBe(50);

    const poisoned = await clientWith({ journal });
    poisoned.join(ROOM);
    latest().deliver({ type: 'subscribed', roomId: ROOM, head: 3, seenSeq: 0 });

    // Dropped, loudly, and re-read from nothing rather than from 50.
    expect(poisoned.lastSeq(ROOM)).toBe(0);
    expect(poisoned.room(ROOM).events).toEqual([]);
    expect(errors.at(-1)).toContain('has been discarded');
    expect(latest().framesOfType('since').at(-1)).toMatchObject({ roomId: ROOM, roomSeq: 0 });
    // …and the store no longer holds it, so a reload does not resume the forgery.
    expect(journal.load(ROOM)).toEqual({ events: [], lastSeq: 0 });

    // The room then loads normally, which is what makes this a check and not a ban.
    latest().deliver({
      type: 'catchup',
      roomId: ROOM,
      from: 0,
      to: 3,
      head: 3,
      more: false,
      entries: [messageEvent(1, 'a'), messageEvent(2, 'b'), messageEvent(3, 'c')],
    });
    expect(poisoned.lastSeq(ROOM)).toBe(3);
  });

  it('keeps an honest journal that resumes at or below the head', async () => {
    // Non-vacuity, and the thing that would break every ordinary resume if the
    // comparison were `>=`: a client that holds exactly the head is the common
    // case, not a suspect one.
    const storage = fakeStorage();
    (globalThis as { localStorage?: Storage }).localStorage = storage;
    const journal = localStorageJournal('honest');
    journal.commit(ROOM, messageEvent(1, 'a'), 1);
    journal.commit(ROOM, messageEvent(2, 'b'), 2);

    const resumed = await clientWith({ journal });
    resumed.join(ROOM);
    latest().deliver({ type: 'subscribed', roomId: ROOM, head: 2, seenSeq: 0 });
    expect(resumed.lastSeq(ROOM)).toBe(2);
    expect(resumed.room(ROOM).events.map((e) => e.roomSeq)).toEqual([1, 2]);
    expect(errors).toEqual([]);
    expect(latest().framesOfType('since').at(-1)).toMatchObject({ roomSeq: 2 });
  });

  it('does not detect a forgery planted at the room’s true head', async () => {
    /**
     * The limit, asserted rather than only conceded (#22 gauntlet r7, sharpening).
     *
     * `frame.head` is not unpredictable — it is public to anything on the origin,
     * which can open its own socket and read it. So the bounded case is not a
     * corner an attacker might stumble into; it is one line of reconnaissance
     * away. Planted at exactly the head, the record is well-formed, well-ordered,
     * in the right room, consistent with its cursor, and *not* above the head, so
     * every check in this file passes it and the catch-up asks for nothing.
     *
     * This test exists to fail if that stops being true — which would mean the
     * client had acquired provenance it does not have — and to keep the comment
     * describing this mitigation honest about which case it closes.
     */
    const storage = fakeStorage();
    (globalThis as { localStorage?: Storage }).localStorage = storage;
    const journal = localStorageJournal('planted');
    journal.commit(ROOM, messageEvent(1, 'the room’s real first event'), 1);
    journal.commit(ROOM, messageEvent(2, 'a lie, planted exactly at the head'), 2);

    const planted = await clientWith({ journal });
    planted.join(ROOM);
    latest().deliver({ type: 'subscribed', roomId: ROOM, head: 2, seenSeq: 0 });

    expect(errors).toEqual([]);
    expect(planted.lastSeq(ROOM)).toBe(2);
    expect(planted.room(ROOM).events.at(-1)?.event).toMatchObject({
      body: 'a lie, planted exactly at the head',
    });
    // And the catch-up it asks for cannot correct it: the cursor is at the head,
    // so the server has nothing above it to send.
    expect(latest().framesOfType('since').at(-1)).toMatchObject({ roomSeq: 2 });
  });
});

/**
 * The eleventh claim: **order** (#22 gauntlet r7, defect 2).
 *
 * `realtime.ts` opens by saying "Nothing is ever applied out of order, and
 * nothing is applied twice", and `RoomView.events` is documented as "in
 * `room_seq` order. Never out of order, never repeated." Both are absolute, and
 * until r8 the schema that was supposed to make them true checked only that the
 * cursor equalled the *last* event's `roomSeq` — not that the events climbed.
 *
 * So `{events: [{roomSeq: 9}, {roomSeq: 2}], lastSeq: 2}` loaded clean: the last
 * event is 2, the cursor is 2, the record agrees with itself. The 9 is already in
 * the timeline, the cursor is 2, `applyEntry` dedups on `roomSeq <= lastSeq` —
 * and the real event at 9 arrives in catch-up and is applied a **second** time.
 * The rendered room is `[9,2,3,4,5,6,7,8,9]`, in the client whose first sentence
 * says that cannot happen.
 *
 * This is inside the bounded case the head check declares — a forgery at or below
 * the true head still displaces real events, and nothing here can tell. What it
 * is *not* inside is the sentence: displacing a prefix is what the bound admits,
 * rendering the same event twice is what two absolute claims deny. The schema is
 * where those claims are cashed, so the check goes there.
 */
describe('a stored journal that is not in order is not history', () => {
  function fakeStorage(): Storage & { raw: Map<string, string> } {
    const raw = new Map<string, string>();
    const store = {
      raw,
      getItem: (key: string) => raw.get(key) ?? null,
      setItem: (key: string, value: string) => {
        raw.set(key, value);
      },
      removeItem: (key: string) => {
        raw.delete(key);
      },
      clear: () => raw.clear(),
      key: (index: number) => [...raw.keys()][index] ?? null,
      get length() {
        return raw.size;
      },
    };
    return store as unknown as Storage & { raw: Map<string, string> };
  }

  const KEY = 'atrium:journal:order:room-1';

  it('reads an out-of-order record as no history at all', () => {
    const storage = fakeStorage();
    (globalThis as { localStorage?: Storage }).localStorage = storage;
    const journal = localStorageJournal('order');
    // Self-consistent by r7's rule — last event is 2, cursor is 2 — and not a
    // history: `room_seq` is minted by the table and climbs by one.
    storage.setItem(
      KEY,
      JSON.stringify({ events: [messageEvent(9, 'planted'), messageEvent(2, 'b')], lastSeq: 2 }),
    );
    expect(journal.load(ROOM)).toEqual({ events: [], lastSeq: 0 });
  });

  it('reads a record with a repeated position as no history at all', () => {
    const storage = fakeStorage();
    (globalThis as { localStorage?: Storage }).localStorage = storage;
    const journal = localStorageJournal('order');
    // Strictly increasing, not merely non-decreasing: `room_seq` is unique per
    // room, so two entries at the same position is the same forgery with the
    // duplicate already in the record rather than arriving later.
    storage.setItem(
      KEY,
      JSON.stringify({ events: [messageEvent(2, 'a'), messageEvent(2, 'b')], lastSeq: 2 }),
    );
    expect(journal.load(ROOM)).toEqual({ events: [], lastSeq: 0 });
  });

  it('reads a record holding another room’s events as no history at all', () => {
    const storage = fakeStorage();
    (globalThis as { localStorage?: Storage }).localStorage = storage;
    const journal = localStorageJournal('order');
    // The same question asked of the other field the record carries and the read
    // never checked: `roomId`. The key says room-1; the entry says room-2, and
    // `view()` renders `held.events` as this room's timeline without re-reading
    // the envelope's own room. Content injection across rooms, from a store the
    // origin shares with everything else on it.
    const foreign = { ...messageEvent(1, 'from another room'), roomId: 'room-2' };
    storage.setItem(KEY, JSON.stringify({ events: [foreign], lastSeq: 1 }));
    expect(journal.load(ROOM)).toEqual({ events: [], lastSeq: 0 });
  });

  it('keeps an ordinary in-order record', () => {
    // Non-vacuity: the check must not reject the shape the commit path writes.
    const storage = fakeStorage();
    (globalThis as { localStorage?: Storage }).localStorage = storage;
    const journal = localStorageJournal('order');
    journal.commit(ROOM, messageEvent(1, 'a'), 1);
    journal.commit(ROOM, messageEvent(2, 'b'), 2);
    expect(journal.load(ROOM).events.map((e) => e.roomSeq)).toEqual([1, 2]);
    expect(journal.load(ROOM).lastSeq).toBe(2);
  });

  it('keeps a trimmed record, whose first position is not 1', () => {
    // Eviction drops from the front, so a real record routinely starts above 1
    // and above the previous read's floor. Increasing, not contiguous-from-one.
    const storage = fakeStorage();
    (globalThis as { localStorage?: Storage }).localStorage = storage;
    const journal = localStorageJournal('order', { maxEvents: 2 });
    journal.commit(ROOM, messageEvent(1, 'a'), 1);
    journal.commit(ROOM, messageEvent(2, 'b'), 2);
    journal.commit(ROOM, messageEvent(3, 'c'), 3);
    expect(journal.load(ROOM).events.map((e) => e.roomSeq)).toEqual([2, 3]);
  });

  it('never renders the same event twice, given the exact forged record', async () => {
    /**
     * The critic's exploit end to end, and the assertion that names the harm:
     * the timeline, not the journal. On r7 this renders `[9,2,3,4,5,6,7,8,9]`.
     */
    const storage = fakeStorage();
    (globalThis as { localStorage?: Storage }).localStorage = storage;
    const journal = localStorageJournal('order');
    storage.setItem(
      KEY,
      JSON.stringify({ events: [messageEvent(9, 'planted'), messageEvent(2, 'b')], lastSeq: 2 }),
    );

    const forged = await clientWith({ journal });
    forged.join(ROOM);
    // head 9, so the r7 head check does not fire: `lastSeq` is 2, under the head.
    // This forgery is inside the bounded case, which is the point.
    latest().deliver({ type: 'subscribed', roomId: ROOM, head: 9, seenSeq: 0 });
    latest().deliver({
      type: 'catchup',
      roomId: ROOM,
      from: 0,
      to: 9,
      head: 9,
      more: false,
      entries: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => messageEvent(n, `real-${n}`)),
    });

    const rendered = forged.room(ROOM).events.map((e) => e.roomSeq);
    expect(rendered).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(new Set(rendered).size).toBe(rendered.length);
  });
});

/**
 * `reset` is a promise about the store, not only about this instance
 * (#22 gauntlet r7, defect 3).
 *
 * The comment at the call said "after it returns, this room resumes from
 * nothing". r7 made that true for the live object — a `removeItem` that throws
 * degrades the room to memory — and false for the disk: the poisoned key stayed,
 * so the *next* page load read the forgery again, fired the head check again, and
 * degraded again, for ever. "Resumes from nothing" is a claim about resuming,
 * which is the thing that happens after a reload.
 */
describe('reset clears the room from the store, not just from this instance', () => {
  const KEY = 'atrium:journal:reset:room-1';

  function storageWith(overrides: Partial<Storage>): Storage & { raw: Map<string, string> } {
    const raw = new Map<string, string>();
    const store = {
      raw,
      getItem: (key: string) => raw.get(key) ?? null,
      setItem: (key: string, value: string) => {
        raw.set(key, value);
      },
      removeItem: (key: string) => {
        raw.delete(key);
      },
      clear: () => raw.clear(),
      key: (index: number) => [...raw.keys()][index] ?? null,
      get length() {
        return raw.size;
      },
      ...overrides,
    };
    return store as unknown as Storage & { raw: Map<string, string> };
  }

  it('overwrites the record when removeItem throws, so a reload resumes from nothing', () => {
    const storage = storageWith({
      removeItem: () => {
        throw new Error('removeItem is not available');
      },
    });
    (globalThis as { localStorage?: Storage }).localStorage = storage;
    const poison = JSON.stringify({ events: [messageEvent(50, 'forged')], lastSeq: 50 });
    storage.raw.set(KEY, poison);

    localStorageJournal('reset').reset(ROOM);

    // The live instance degrading is not enough and never was: a reload builds a
    // new journal with an empty `degraded` set and reads whatever is on disk.
    // What has to be true is that the *store* no longer resumes the forgery.
    expect(localStorageJournal('reset').load(ROOM)).toEqual({ events: [], lastSeq: 0 });
    expect(storage.raw.get(KEY)).not.toBe(poison);
  });

  it('reports and stays quiet about the store when neither removeItem nor setItem works', () => {
    // Both doors shut is the case `reset` genuinely cannot honour, so it says so
    // once and the source says what is left true: the live room resumes from
    // nothing, and a reload re-reads the record and re-runs the same check —
    // which costs a catch-up per load rather than corrupting anything.
    const degraded: string[] = [];
    const storage = storageWith({
      removeItem: () => {
        throw new Error('removeItem is not available');
      },
      setItem: () => {
        throw new Error('setItem is not available');
      },
    });
    (globalThis as { localStorage?: Storage }).localStorage = storage;
    storage.raw.set(KEY, JSON.stringify({ events: [messageEvent(50, 'forged')], lastSeq: 50 }));

    const journal = localStorageJournal('reset', {
      onDegraded: (_r, reason) => degraded.push(reason),
    });
    journal.reset(ROOM);
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toContain('localStorage is unusable');
    expect(journal.load(ROOM)).toEqual({ events: [], lastSeq: 0 });
  });

  it('still removes the record outright when removeItem works', () => {
    // Non-vacuity: the ordinary path must not have become a write.
    const storage = storageWith({});
    (globalThis as { localStorage?: Storage }).localStorage = storage;
    const journal = localStorageJournal('reset');
    journal.commit(ROOM, messageEvent(1, 'a'), 1);
    expect(storage.raw.size).toBe(1);
    journal.reset(ROOM);
    expect(storage.raw.size).toBe(0);
  });
});

describe('reconnect', () => {
  it('re-subscribes and resumes from its own cursor on a new socket', async () => {
    client.join(ROOM);
    latest().deliver({ type: 'subscribed', roomId: ROOM, head: 2, seenSeq: 0 });
    latest().deliver({
      type: 'catchup',
      roomId: ROOM,
      from: 0,
      to: 2,
      head: 2,
      more: false,
      entries: [messageEvent(1, 'a'), messageEvent(2, 'b')],
    });

    const first = latest();
    first.drop();
    expect(client.status()).toBe('reconnecting');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sockets).toHaveLength(2);
    const second = latest();
    second.open();

    // It re-subscribes, and the subscription's catch-up starts from where it
    // got to — not from zero, and not from the server's idea of where it is.
    expect(second.framesOfType('subscribe').at(-1)).toMatchObject({ roomId: ROOM });
    second.deliver({ type: 'subscribed', roomId: ROOM, head: 5, seenSeq: 0 });
    expect(second.framesOfType('since').at(-1)).toMatchObject({ roomId: ROOM, roomSeq: 2 });

    second.deliver({
      type: 'catchup',
      roomId: ROOM,
      from: 2,
      to: 5,
      head: 5,
      more: false,
      entries: [messageEvent(3, 'c'), messageEvent(4, 'd'), messageEvent(5, 'e')],
    });
    expect(client.room(ROOM).events.map((e) => e.roomSeq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('does not reconnect after a deliberate close', async () => {
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sockets).toHaveLength(1);
    expect(client.status()).toBe('closed');
  });

  /**
   * r1 polish: presence, typing and the in-flight command map were all left
   * intact across a drop. Each is a statement about a socket that no longer
   * exists — a room stays full of people who never left, a typing indicator
   * never stops, and the map grows one unanswerable entry per dropped send.
   */
  it('forgets presence, typing and in-flight commands when the socket drops', async () => {
    client.join(ROOM);
    latest().deliver({ type: 'subscribed', roomId: ROOM, head: 0, seenSeq: 0 });
    latest().deliver({
      type: 'presence',
      roomId: ROOM,
      userId: 'user-other',
      state: 'online',
      at: '2026-07-31T00:00:00.000Z',
    });
    latest().deliver({
      type: 'typing',
      roomId: ROOM,
      userId: 'user-other',
      typing: true,
      at: '2026-07-31T00:00:00.000Z',
    });
    client.sendMessage(ROOM, 'in flight when the wire died');
    expect(client.room(ROOM).presence).toEqual({ 'user-other': 'online' });
    expect(client.room(ROOM).typing).toEqual(['user-other']);

    latest().drop();

    expect(client.room(ROOM).presence).toEqual({});
    expect(client.room(ROOM).typing).toEqual([]);
    expect(client.room(ROOM).subscribed).toBe(false);
    // The optimistic row is kept — nobody should have to retype a message
    // because of a network blip — but it is honest about not having landed,
    // and about being safe to send again.
    const pending = client.room(ROOM).pending[0];
    expect(pending?.status).toBe('failed');
    expect(pending?.retryable).toBe(true);
    expect(pending?.body).toBe('in flight when the wire died');

    // And a late ack for the dead socket's command cannot resurrect anything.
    await new Promise((resolve) => setTimeout(resolve, 20));
    latest().open();
    latest().deliver({
      type: 'ack',
      commandId: 'c1',
      roomId: ROOM,
      seq: 1,
      roomSeq: 1,
      eventId: 'e1',
      issues: [],
    });
    expect(client.room(ROOM).pending[0]?.status).toBe('failed');
  });
});

describe('optimism is limited to your own message row', () => {
  beforeEach(() => {
    client.join(ROOM);
    latest().deliver({ type: 'subscribed', roomId: ROOM, head: 0, seenSeq: 0 });
  });

  it('shows your own message immediately, marked pending', () => {
    const clientMessageId = client.sendMessage(ROOM, 'typed just now');
    const pending = client.room(ROOM).pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      clientMessageId,
      body: 'typed just now',
      status: 'pending',
    });
    // Nothing has been applied to the timeline itself.
    expect(client.room(ROOM).events).toHaveLength(0);
    expect(client.lastSeq(ROOM)).toBe(0);
  });

  it('retires the optimistic row when the server’s event confirms it', () => {
    const clientMessageId = client.sendMessage(ROOM, 'typed just now');
    latest().deliver({
      type: 'event',
      entry: messageEvent(1, 'typed just now', ME, clientMessageId),
    });
    expect(client.room(ROOM).pending).toHaveLength(0);
    expect(client.room(ROOM).events).toHaveLength(1);
  });

  it('does not retire it on someone else’s event with the same key', () => {
    const clientMessageId = client.sendMessage(ROOM, 'mine');
    latest().deliver({
      type: 'event',
      entry: messageEvent(1, 'theirs', 'user-other', clientMessageId),
    });
    // The collision is possible because the key is client-chosen; dropping the
    // row here would delete a message the person can still see they sent.
    expect(client.room(ROOM).pending).toHaveLength(1);
  });

  it('marks a rejected send failed and keeps the text', () => {
    client.sendMessage(ROOM, 'this will be refused');
    const commandId = latest().sent.find((f) => f.type === 'command')?.commandId as string;
    latest().deliver({
      type: 'nack',
      commandId,
      code: 'not_a_member',
      message: 'no membership for room "room-1"',
    });
    const [pending] = client.room(ROOM).pending;
    expect(pending).toMatchObject({ status: 'failed', body: 'this will be refused' });
    // A refusal is not a retry. Offering one here would invite a client to
    // hammer a command that will be refused every time.
    expect(pending?.retryable).toBe(false);
    expect(errors.at(-1)).toContain('not_a_member');
  });

  it('marks a busy-ledger send retryable rather than refused', () => {
    client.sendMessage(ROOM, 'the ledger was busy');
    const commandId = latest().sent.find((f) => f.type === 'command')?.commandId as string;
    latest().deliver({
      type: 'nack',
      commandId,
      // The server's mapping of SQLSTATE 55P03/57014 — nothing was written, and
      // the identical frame is the right thing to send again (r1 polish).
      code: 'retry',
      message: 'the ledger was busy (SQLSTATE 55P03); nothing was written',
    });
    const [pending] = client.room(ROOM).pending;
    expect(pending).toMatchObject({ status: 'failed', retryable: true });
  });

  it('never renders anything semantic optimistically', () => {
    // There is no local-first path for acceptance, correction or binding: the
    // client can only ask, and the room's understanding changes when the
    // server says it did.
    client.setPresence(ROOM, 'online');
    client.advanceSeen(ROOM, 0);
    expect(client.room(ROOM).events).toHaveLength(0);
    expect(client.room(ROOM).presence).toEqual({});
    expect(
      latest()
        .commands()
        .map((c) => c.name),
    ).toEqual(['set_presence', 'advance_seen']);
  });
});

describe('ephemeral channels', () => {
  beforeEach(() => {
    client.join(ROOM);
    latest().deliver({ type: 'subscribed', roomId: ROOM, head: 0, seenSeq: 0 });
  });

  it('tracks presence and typing without touching the event timeline', () => {
    latest().deliver({
      type: 'presence',
      roomId: ROOM,
      userId: 'user-other',
      state: 'online',
      at: '2026-07-31T00:00:00.000Z',
    });
    latest().deliver({
      type: 'typing',
      roomId: ROOM,
      userId: 'user-other',
      typing: true,
      at: '2026-07-31T00:00:01.000Z',
    });
    expect(client.room(ROOM).presence).toEqual({ 'user-other': 'online' });
    expect(client.room(ROOM).typing).toEqual(['user-other']);
    expect(client.room(ROOM).events).toHaveLength(0);
    expect(client.lastSeq(ROOM)).toBe(0);

    latest().deliver({
      type: 'typing',
      roomId: ROOM,
      userId: 'user-other',
      typing: false,
      at: '2026-07-31T00:00:02.000Z',
    });
    expect(client.room(ROOM).typing).toEqual([]);
  });

  it('advances the read cursor only for this user', () => {
    latest().deliver({ type: 'seen', roomId: ROOM, userId: 'user-other', seenSeq: 9 });
    expect(client.room(ROOM).seenSeq).toBe(0);
    latest().deliver({ type: 'seen', roomId: ROOM, userId: ME, seenSeq: 4 });
    expect(client.room(ROOM).seenSeq).toBe(4);
  });

  it('sends the current cursor when advanceSeen is called with no argument', () => {
    latest().deliver({ type: 'event', entry: messageEvent(1, 'a') });
    latest().deliver({ type: 'event', entry: messageEvent(2, 'b') });
    client.advanceSeen(ROOM);
    expect(latest().commands().at(-1)).toMatchObject({ name: 'advance_seen', roomSeq: 2 });
  });
});
