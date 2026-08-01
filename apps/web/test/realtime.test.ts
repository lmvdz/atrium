import { beforeEach, describe, expect, it } from 'vitest';
import {
  createRealtimeClient,
  type RealtimeClient,
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
    event: {
      id: `e${roomSeq}`,
      at: `2026-07-31T00:00:${String(roomSeq).padStart(2, '0')}.000Z`,
      type: 'message_posted',
      actor: { kind: 'human', userId },
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
    expect(errors.at(-1)).toContain('not_a_member');
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
