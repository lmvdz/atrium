import { loadRuntimeConfig } from './runtime-config.js';
import { resolveWsUrl } from './ws-url.js';

/**
 * The realtime client (#12/#14/#22).
 *
 * Three rules, and the whole file is them:
 *
 * 1. **`room_seq` is the only cursor.** Every room tracks `lastSeq`, the
 *    per-room sequence number of the last event applied. It is what a reconnect
 *    sends back as `since(room, lastSeq)`, and what tells a live event whether
 *    it is the next one or the far side of a gap.
 *
 * 2. **Catch up on reconnect, and on any gap.** A socket that dies mid-burst is
 *    ordinary; so is a delivery that never arrives. Both look identical from
 *    here — an event whose `roomSeq` is more than one past the cursor — and
 *    both are answered the same way: ask for the gap and apply it in order.
 *    Nothing is ever applied out of order, and nothing is applied twice.
 *
 *    Catch-up is a **loop**, not a call. The condition to keep going is
 *    `lastSeq < head` — never "was that page full?", and never the server's
 *    word for it alone. #22's r1 gauntlet found the server computing `more`
 *    from page fullness, which reports "caught up" during concurrent writes;
 *    a client that trusted one frame stopped there and lost the tail silently.
 *    The server's arithmetic is fixed too, but this client no longer depends on
 *    it: it asks again while its own cursor is behind the head it was told,
 *    whatever `more` says.
 *
 * 3. **Optimistic about your own message row, and nothing else.** A message you
 *    just typed appears immediately, marked `pending`, matched back to the
 *    server's event by `clientMessageId`. Every*thing* semantic — a proposal
 *    accepted, a decision corrected, a question answered — waits for the
 *    server. That asymmetry is the trust model, not a performance trade: the
 *    one thing you may render before the room agrees is the fact that you said
 *    something, because you are the authority on that and on nothing else
 *    (init.md §5, #12).
 *
 * The socket is injectable so all of this is testable without a browser or a
 * network; `apps/web/test/realtime.test.ts` drives it with a fake.
 */

/* ── the wire, as this client needs to see it ───────────────────────────── */

export interface RoomEventEnvelope {
  roomId: string;
  roomSeq: number;
  seq: number;
  event: {
    id: string;
    at: string;
    type: string;
    actor: { kind: string; userId?: string; model?: string };
    [key: string]: unknown;
  };
}

export type ServerFrame =
  | { type: 'welcome'; connectionId: string; userId: string; heartbeatIntervalMs: number }
  | { type: 'pong'; at: string }
  | { type: 'subscribed'; roomId: string; head: number; seenSeq: number }
  | { type: 'unsubscribed'; roomId: string }
  | { type: 'event'; entry: RoomEventEnvelope }
  | {
      type: 'catchup';
      roomId: string;
      from: number;
      to: number;
      head: number;
      more: boolean;
      entries: RoomEventEnvelope[];
    }
  | {
      type: 'ack';
      commandId: string;
      roomId: string;
      /** `null` when nothing was appended — presence, typing, the read cursor. */
      seq: number | null;
      roomSeq: number | null;
      eventId: string | null;
      issues: string[];
    }
  | { type: 'nack'; commandId: string; code: string; message: string }
  | { type: 'presence'; roomId: string; userId: string; state: string; at: string }
  | { type: 'typing'; roomId: string; userId: string; typing: boolean; at: string }
  | { type: 'seen'; roomId: string; userId: string; seenSeq: number }
  | { type: 'error'; message: string };

/** The minimum of `WebSocket` this client uses. A browser socket satisfies it. */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

/* ── client state ───────────────────────────────────────────────────────── */

export interface PendingMessage {
  clientMessageId: string;
  body: string;
  at: string;
  status: 'pending' | 'failed';
  error?: string;
  /**
   * Whether sending the identical frame again is a sensible thing to offer.
   *
   * True for a busy ledger (the server's `retry` nack) and for a socket that
   * dropped before answering; false for a refusal that will refuse again.
   * `clientMessageId` is an idempotency key, so a retry that turns out to have
   * been unnecessary collapses into the message that already landed.
   */
  retryable?: boolean;
}

/**
 * Where the per-room catch-up cursor is written down.
 *
 * The recovery loop needs a cursor that outlives any one frame and any one
 * socket, because "I am caught up" must never rest on a single reply. In memory
 * is enough for a dropped socket — this client object survives that — and the
 * seam exists for the case it does not: an app that caches a room's events
 * across a page load can hand in a store backed by the same lifetime, and
 * catch-up resumes from the cursor instead of replaying the room.
 *
 * The default is deliberately in-memory. This client keeps history in a plain
 * array, so a watermark that outlived the events would resume past history the
 * timeline no longer has — an empty room that believes it is up to date. Pair a
 * durable store with a durable event cache, or not at all.
 */
export interface WatermarkStore {
  read: (roomId: string) => number;
  write: (roomId: string, roomSeq: number) => void;
}

/** The default: lives exactly as long as the client does. */
export function memoryWatermarks(): WatermarkStore {
  const marks = new Map<string, number>();
  return {
    read: (roomId) => marks.get(roomId) ?? 0,
    write: (roomId, roomSeq) => {
      marks.set(roomId, Math.max(marks.get(roomId) ?? 0, roomSeq));
    },
  };
}

/**
 * A `localStorage`-backed store, for an app that also persists the events.
 *
 * Not the default, and not used anywhere yet — see the note on `WatermarkStore`
 * for why pairing matters. Exported because the alternative is every caller
 * writing this same twelve lines slightly differently.
 */
export function localStorageWatermarks(namespace: string): WatermarkStore {
  const key = (roomId: string) => `atrium:watermark:${namespace}:${roomId}`;
  const fallback = memoryWatermarks();
  const storage = (): Storage | null => {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      // Private-mode and blocked-cookie browsers throw on *access*, not on use.
      return null;
    }
  };
  return {
    read: (roomId) => {
      const store = storage();
      if (!store) return fallback.read(roomId);
      const raw = Number(store.getItem(key(roomId)));
      return Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
    },
    write: (roomId, roomSeq) => {
      const store = storage();
      if (!store) {
        fallback.write(roomId, roomSeq);
        return;
      }
      try {
        store.setItem(key(roomId), String(roomSeq));
      } catch {
        // Quota, or a storage that lies about being writable. The in-memory
        // cursor is still correct for this session; losing the durable one
        // costs a replay, not correctness.
      }
    },
  };
}

export interface RoomView {
  roomId: string;
  /** The per-room cursor. Everything about recovery hangs off this number. */
  lastSeq: number;
  /** The room's newest sequence as of the last server word on it. */
  head: number;
  /** This user's read cursor — the "since you left" divider. */
  seenSeq: number;
  /** Applied events, in `room_seq` order. Never out of order, never repeated. */
  events: RoomEventEnvelope[];
  /** Own messages not yet confirmed. The only optimistic thing here. */
  pending: PendingMessage[];
  /** Who is present, as last broadcast. Never persisted; never replayed. */
  presence: Record<string, string>;
  typing: string[];
  subscribed: boolean;
}

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface RealtimeClientOptions {
  /** Stub identity until #26 — sent as a query parameter on the socket URL. */
  userId: string;
  /** Override the resolved URL. Normally omitted; see `ws-url.ts`. */
  url?: string;
  socketFactory?: SocketFactory;
  /** `false` disables reconnection entirely (tests, and one-shot tools). */
  reconnect?: false | { initialDelayMs?: number; maxDelayMs?: number; factor?: number };
  now?: () => number;
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
  onError?: (message: string) => void;
  /** Where the catch-up cursor is kept. In memory unless you say otherwise. */
  watermarks?: WatermarkStore;
  /**
   * How many catch-up rounds may make no progress before the client stops
   * asking. A loop with no floor is a loop that can spin against a server whose
   * `head` names a position it will not send — so it gives up, loudly, instead
   * of hammering. Reaching this is a bug somewhere; silence about it would be a
   * second one.
   */
  maxStalledCatchups?: number;
}

export interface RealtimeClient {
  connect: () => Promise<void>;
  close: () => void;
  status: () => ConnectionStatus;
  /** Join a room: subscribe, then close any gap since `lastSeq`. */
  join: (roomId: string) => void;
  leave: (roomId: string) => void;
  room: (roomId: string) => RoomView;
  rooms: () => string[];
  lastSeq: (roomId: string) => number;
  /** Post a message. Returns the `clientMessageId` its optimistic row is keyed on. */
  sendMessage: (roomId: string, body: string) => string;
  advanceSeen: (roomId: string, roomSeq?: number) => void;
  setPresence: (roomId: string, state: 'online' | 'away' | 'offline') => void;
  setTyping: (roomId: string, typing: boolean) => void;
  /** Subscribe to any change. Returns an unsubscribe function. */
  onChange: (listener: (roomId: string, view: RoomView) => void) => () => void;
  onStatus: (listener: (status: ConnectionStatus) => void) => () => void;
}

const DEFAULT_RECONNECT = { initialDelayMs: 300, maxDelayMs: 10_000, factor: 2 };
const DEFAULT_MAX_STALLED_CATCHUPS = 8;

export function createRealtimeClient(options: RealtimeClientOptions): RealtimeClient {
  const now = options.now ?? (() => Date.now());
  const schedule = options.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
  const unschedule = options.clearTimeoutImpl ?? ((handle) => clearTimeout(handle as never));
  const factory: SocketFactory =
    options.socketFactory ?? ((url) => new WebSocket(url) as unknown as SocketLike);
  const backoff =
    options.reconnect === false ? null : { ...DEFAULT_RECONNECT, ...options.reconnect };

  const watermarks = options.watermarks ?? memoryWatermarks();
  const maxStalledCatchups = options.maxStalledCatchups ?? DEFAULT_MAX_STALLED_CATCHUPS;

  const rooms = new Map<string, RoomView>();
  const changeListeners = new Set<(roomId: string, view: RoomView) => void>();
  const statusListeners = new Set<(status: ConnectionStatus) => void>();
  /** commandId → the pending own-message it optimistically rendered. */
  const inFlight = new Map<string, { roomId: string; clientMessageId: string }>();
  /** Consecutive catch-up rounds that asked for a gap and got no closer to it. */
  const stalled = new Map<string, number>();

  let socket: SocketLike | null = null;
  let status: ConnectionStatus = 'idle';
  let attempts = 0;
  let retryHandle: unknown = null;
  let closedByUs = false;
  let nextCommandId = 0;

  function view(roomId: string): RoomView {
    let existing = rooms.get(roomId);
    if (!existing) {
      existing = {
        roomId,
        // Seeded from the durable cursor. Zero with the default in-memory
        // store, which is the honest answer for a client whose event list also
        // starts empty.
        lastSeq: watermarks.read(roomId),
        head: 0,
        seenSeq: 0,
        events: [],
        pending: [],
        presence: {},
        typing: [],
        subscribed: false,
      };
      rooms.set(roomId, existing);
    }
    return existing;
  }

  function changed(roomId: string): void {
    const current = view(roomId);
    for (const listener of changeListeners) listener(roomId, current);
  }

  function setStatus(next: ConnectionStatus): void {
    if (status === next) return;
    status = next;
    for (const listener of statusListeners) listener(next);
  }

  function fail(message: string): void {
    options.onError?.(message);
  }

  const OPEN = 1;

  function send(frame: unknown): boolean {
    if (socket?.readyState !== OPEN) return false;
    socket.send(JSON.stringify(frame));
    return true;
  }

  function nextId(): string {
    nextCommandId += 1;
    return `c${nextCommandId}`;
  }

  function command(command: Record<string, unknown>): string {
    const commandId = nextId();
    send({ type: 'command', commandId, command });
    return commandId;
  }

  async function resolveUrl(): Promise<string> {
    if (options.url) return withUser(options.url);
    const config = await loadRuntimeConfig();
    return withUser(resolveWsUrl(config));
  }

  /**
   * The stub identity rides on the query string because a browser cannot set a
   * header on a WebSocket handshake. #26 replaces this with a cookie the
   * handshake carries on its own, and this function disappears with it.
   */
  function withUser(url: string): string {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}user=${encodeURIComponent(options.userId)}`;
  }

  function applyEntry(entry: RoomEventEnvelope): void {
    const room = view(entry.roomId);
    // Already applied. At-least-once delivery plus catch-up means a client sees
    // the same event twice routinely; applying it twice would double every
    // message in the burst that a reconnect straddles.
    if (entry.roomSeq <= room.lastSeq) return;
    if (entry.roomSeq > room.lastSeq + 1) {
      // A hole. Do not apply out of order — ask for the gap and let the
      // catch-up put everything in, in sequence.
      requestSince(entry.roomId);
      return;
    }
    room.events.push(entry);
    room.lastSeq = entry.roomSeq;
    room.head = Math.max(room.head, entry.roomSeq);
    // Written down as it is applied, never in advance: the cursor may only ever
    // name a position whose event this client actually holds.
    watermarks.write(entry.roomId, entry.roomSeq);
    reconcilePending(room, entry);
    changed(entry.roomId);
  }

  /**
   * Retire the optimistic row this event confirms.
   *
   * Matched on `clientMessageId` *and* on the event being this user's own,
   * because the key is client-chosen: two clients could pick the same one, and
   * dropping someone else's echo would delete a message from the timeline.
   */
  function reconcilePending(room: RoomView, entry: RoomEventEnvelope): void {
    if (entry.event.type !== 'message_posted') return;
    const clientMessageId = entry.event.clientMessageId;
    if (typeof clientMessageId !== 'string') return;
    if (entry.event.actor.userId !== options.userId) return;
    room.pending = room.pending.filter((item) => item.clientMessageId !== clientMessageId);
  }

  function requestSince(roomId: string): void {
    send({ type: 'since', roomId, roomSeq: view(roomId).lastSeq });
  }

  function handleFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case 'subscribed': {
        const room = view(frame.roomId);
        room.subscribed = true;
        room.head = frame.head;
        room.seenSeq = frame.seenSeq;
        changed(frame.roomId);
        // Always ask, even on a first join: `lastSeq` is 0 then, so this is
        // both "load the room" and "close the gap" with one code path.
        requestSince(frame.roomId);
        return;
      }
      case 'unsubscribed': {
        const room = view(frame.roomId);
        room.subscribed = false;
        changed(frame.roomId);
        return;
      }
      case 'event':
        applyEntry(frame.entry);
        return;
      case 'catchup': {
        const room = view(frame.roomId);
        const before = room.lastSeq;
        // `max`, not assignment: a live event may already have carried this
        // room past the head this page was read against, and a cursor that
        // moved backwards would make the loop below ask for a gap that has
        // already been filled.
        room.head = Math.max(room.head, frame.head);
        for (const entry of frame.entries) applyEntry(entry);

        // The loop condition is this client's own arithmetic: am I at the head
        // I was told about? `more` is taken as a hint on top, not as the
        // authority — r1's blocking finding was precisely a server saying
        // `more: false` while `to < head`, and a client that believed it.
        if (room.lastSeq < room.head || frame.more) {
          const progressed = room.lastSeq > before;
          const rounds = progressed ? 0 : (stalled.get(frame.roomId) ?? 0) + 1;
          stalled.set(frame.roomId, rounds);
          if (rounds >= maxStalledCatchups) {
            // The server keeps naming a head it will not send. Stop asking and
            // say so: an unbounded loop here would be a client hammering a room
            // it can never finish, in silence.
            fail(
              `catch-up for room "${frame.roomId}" stalled at ${room.lastSeq} of ${room.head} after ${rounds} rounds with no progress`,
            );
          } else {
            requestSince(frame.roomId);
          }
        } else {
          stalled.delete(frame.roomId);
        }
        changed(frame.roomId);
        return;
      }
      case 'ack': {
        inFlight.delete(frame.commandId);
        if (frame.issues.length > 0) {
          fail(`the server accepted the command with issues: ${frame.issues.join('; ')}`);
        }
        return;
      }
      case 'nack': {
        const pending = inFlight.get(frame.commandId);
        inFlight.delete(frame.commandId);
        if (pending) {
          const room = view(pending.roomId);
          const item = room.pending.find((p) => p.clientMessageId === pending.clientMessageId);
          if (item) {
            // Kept, not deleted. A message that vanished on failure is a
            // message the person has to retype from memory.
            item.status = 'failed';
            item.error = frame.message;
            // `retry` means the ledger was busy and nothing was written — the
            // one code for which sending the identical frame again is the right
            // answer rather than a way to make things worse.
            item.retryable = frame.code === 'retry';
          }
          changed(pending.roomId);
        }
        fail(`${frame.code}: ${frame.message}`);
        return;
      }
      case 'presence': {
        const room = view(frame.roomId);
        room.presence = { ...room.presence, [frame.userId]: frame.state };
        changed(frame.roomId);
        return;
      }
      case 'typing': {
        const room = view(frame.roomId);
        const others = room.typing.filter((id) => id !== frame.userId);
        room.typing = frame.typing ? [...others, frame.userId] : others;
        changed(frame.roomId);
        return;
      }
      case 'seen': {
        if (frame.userId !== options.userId) return;
        const room = view(frame.roomId);
        room.seenSeq = frame.seenSeq;
        changed(frame.roomId);
        return;
      }
      case 'error':
        fail(frame.message);
        return;
      default:
        return;
    }
  }

  /**
   * Everything the dead socket was the only evidence for (r1 polish).
   *
   * Presence and typing are statements about *now*, made by a server this
   * client can no longer hear: keeping them across a drop leaves a room full of
   * people who are online because nobody was around to say they left, and a
   * typing indicator that never stops. Both are re-established by the server
   * after the resubscribe, so clearing them costs a flicker and buys a UI that
   * is never confidently wrong.
   *
   * `inFlight` is the same argument about commands. The ack that would have
   * retired each entry was on that socket, so every one of them is now
   * unanswerable — and left in the map they would leak one entry per dropped
   * send, forever, and silently swallow a `nack` if a command id were ever
   * reused. The optimistic rows they point at are kept and marked retryable:
   * the send may or may not have landed, `clientMessageId` makes finding out
   * safe, and a message that vanished on a network blip is a message somebody
   * has to retype.
   *
   * `lastSeq` and the events are *not* touched. Those are the durable half, and
   * they are exactly what the catch-up loop resumes from.
   */
  function dropVolatileState(): void {
    for (const [commandId, pending] of inFlight) {
      const room = view(pending.roomId);
      const item = room.pending.find((p) => p.clientMessageId === pending.clientMessageId);
      if (item && item.status === 'pending') {
        item.status = 'failed';
        item.error = 'the connection dropped before the server answered';
        item.retryable = true;
      }
      inFlight.delete(commandId);
    }
    for (const room of rooms.values()) {
      room.subscribed = false;
      room.presence = {};
      room.typing = [];
      stalled.delete(room.roomId);
      changed(room.roomId);
    }
  }

  function attach(next: SocketLike): void {
    socket = next;
    next.onopen = () => {
      attempts = 0;
      setStatus('open');
      // Re-join everything. The server has no memory of this socket's
      // subscriptions, and `subscribed` triggers the catch-up.
      for (const roomId of rooms.keys()) {
        view(roomId).subscribed = false;
        send({ type: 'subscribe', roomId });
      }
    };
    next.onmessage = (event) => {
      let parsed: ServerFrame;
      try {
        parsed = JSON.parse(String(event.data)) as ServerFrame;
      } catch {
        fail('received a frame that is not valid JSON');
        return;
      }
      handleFrame(parsed);
    };
    next.onerror = () => {
      fail('websocket error');
    };
    next.onclose = () => {
      socket = null;
      dropVolatileState();
      if (closedByUs || !backoff) {
        setStatus('closed');
        return;
      }
      setStatus('reconnecting');
      const delay = Math.min(
        backoff.maxDelayMs,
        backoff.initialDelayMs * backoff.factor ** attempts,
      );
      attempts += 1;
      // Full jitter. Every client in a room reconnects at the same instant when
      // the server restarts; an unjittered backoff turns that into a thundering
      // herd on a process that has just started.
      const jittered = Math.round(delay * (0.5 + Math.random() * 0.5));
      retryHandle = schedule(() => {
        void connect();
      }, jittered);
    };
  }

  async function connect(): Promise<void> {
    if (socket) return;
    closedByUs = false;
    setStatus(attempts === 0 ? 'connecting' : 'reconnecting');
    let url: string;
    try {
      url = await resolveUrl();
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      setStatus('closed');
      return;
    }
    attach(factory(url));
  }

  return {
    connect,
    close: () => {
      closedByUs = true;
      if (retryHandle !== null) unschedule(retryHandle);
      retryHandle = null;
      socket?.close(1000, 'client closing');
      socket = null;
      // A deliberate close drops the same volatile state as an accidental one:
      // "who is here" is no more knowable when we hung up than when the wire
      // did. Some sockets deliver `onclose` for a local close and some do not,
      // and this must not depend on which.
      dropVolatileState();
      setStatus('closed');
    },
    status: () => status,
    join: (roomId) => {
      view(roomId);
      send({ type: 'subscribe', roomId });
    },
    leave: (roomId) => {
      send({ type: 'unsubscribe', roomId });
      rooms.delete(roomId);
    },
    room: (roomId) => view(roomId),
    rooms: () => [...rooms.keys()],
    lastSeq: (roomId) => view(roomId).lastSeq,
    sendMessage: (roomId, body) => {
      const room = view(roomId);
      const clientMessageId = `${options.userId}:${now()}:${(nextCommandId + 1).toString(36)}`;
      room.pending.push({
        clientMessageId,
        body,
        at: new Date(now()).toISOString(),
        status: 'pending',
      });
      const commandId = command({
        name: 'send_message',
        roomId,
        body,
        clientMessageId,
        replyToId: null,
        attachments: [],
      });
      inFlight.set(commandId, { roomId, clientMessageId });
      changed(roomId);
      return clientMessageId;
    },
    advanceSeen: (roomId, roomSeq) => {
      const target = roomSeq ?? view(roomId).lastSeq;
      // Explicit, per room, never a global mark-all-read (#12/#14).
      command({ name: 'advance_seen', roomId, roomSeq: target });
    },
    setPresence: (roomId, state) => {
      command({ name: 'set_presence', roomId, state });
    },
    setTyping: (roomId, typing) => {
      command({ name: 'set_typing', roomId, typing });
    },
    onChange: (listener) => {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    onStatus: (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
  };
}
