import { beforeEach, describe, expect, it } from 'vitest';
import {
  createRealtimeClient,
  memoryJournal,
  type RealtimeClient,
  type RealtimeClientOptions,
  type RoomJournal,
  type RoomEventEnvelope,
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
async function clientWith(
  overrides: Partial<RealtimeClientOptions> = {},
): Promise<RealtimeClient> {
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

    // The crash: every in-memory thing above is gone and only what the journal
    // made durable survives. A fresh client over that journal is what a reload
    // is.
    const resumed = await clientWith({ journal: survivor });
    resumed.join(ROOM);
    latest().deliver({ type: 'subscribed', roomId: ROOM, head: 5, seenSeq: 0 });

    // Catches: moving `journal.commit` back after the in-memory push in
    // `applyEntry`, and splitting the journal back into a cursor and an event
    // list written separately. Under either, the resumed cursor names position 4
    // — an event this client never held — and the `since` below asks from past
    // the hole, so entry 4 is lost permanently and silently.
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
