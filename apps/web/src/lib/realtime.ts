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

export function createRealtimeClient(options: RealtimeClientOptions): RealtimeClient {
  const now = options.now ?? (() => Date.now());
  const schedule = options.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
  const unschedule = options.clearTimeoutImpl ?? ((handle) => clearTimeout(handle as never));
  const factory: SocketFactory =
    options.socketFactory ?? ((url) => new WebSocket(url) as unknown as SocketLike);
  const backoff =
    options.reconnect === false ? null : { ...DEFAULT_RECONNECT, ...options.reconnect };

  const rooms = new Map<string, RoomView>();
  const changeListeners = new Set<(roomId: string, view: RoomView) => void>();
  const statusListeners = new Set<(status: ConnectionStatus) => void>();
  /** commandId → the pending own-message it optimistically rendered. */
  const inFlight = new Map<string, { roomId: string; clientMessageId: string }>();

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
        lastSeq: 0,
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
        room.head = frame.head;
        for (const entry of frame.entries) applyEntry(entry);
        // A truncated page is not "caught up". Ask again from where we got to.
        if (frame.more) requestSince(frame.roomId);
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
      for (const room of rooms.values()) room.subscribed = false;
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
