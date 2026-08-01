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

/**
 * One ledger row, as the wire carries it.
 *
 * `actor` is **beside** the event, not inside it. #21 took the actor out of the
 * event payload entirely — the schema has no place to put one and refuses an
 * input that carries one — because a payload is whatever the writer says it is
 * and every trust gate in the reducer reads the actor. The ledger stores it as
 * columns on the row and the wire carries it as a sibling of `event`. Nothing in
 * this client may read `entry.event.actor`; there is no such field.
 */
export interface RoomEventEnvelope {
  roomId: string;
  roomSeq: number;
  seq: number;
  actor: { kind: string; userId?: string; model?: string };
  event: {
    id: string;
    at: string;
    type: string;
    [key: string]: unknown;
  };
}

export type ServerFrame =
  | { type: 'welcome'; connectionId: string; userId: string; heartbeatIntervalMs: number }
  | { type: 'pong'; at: string }
  | { type: 'subscribed'; roomId: string; head: number; seenSeq: number }
  | { type: 'unsubscribed'; roomId: string }
  | { type: 'event'; entry: RoomEventEnvelope }
  /**
   * "This room is at `head`" — unsolicited, from the server's reconciler.
   *
   * A gap signal that does not depend on any frame having arrived. The client
   * treats it as it treats every other statement about the head: compare it with
   * its own cursor, and ask for the gap if it is behind.
   */
  | { type: 'head'; roomId: string; head: number }
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
 * The room's applied history and its cursor, stored as **one thing**.
 *
 * ## Why this is not a watermark store (#22 gauntlet r2 delta, major 1)
 *
 * Round 2 had a `WatermarkStore` with `read`/`write`, and `applyEntry` did this:
 * push the event onto an in-memory array, then write the cursor. Two steps, and
 * the gauntlet found the window between them —
 *
 * > the client watermark is not crash-safe: it advances after mutating an
 * > in-memory list, so a crash between the write and the persistence resumes
 * > past an unheld event.
 *
 * — which is exactly right, and it is worse than it sounds, because the two
 * halves had *different lifetimes*. The events lived in memory and the cursor
 * could live in `localStorage`, so a reload resumed from a durable cursor into
 * an empty timeline: a room that believes it is up to date and holds nothing.
 * r2 knew about that and answered it in a doc comment telling callers to "pair a
 * durable store with a durable event cache, or not at all" — an instruction,
 * where the type could have made the pairing impossible to get wrong.
 *
 * So the interface takes both together. `commit` is handed the event **and** the
 * cursor that event implies, and an implementation that persists is required to
 * make them durable in one operation — one `setItem` of one JSON value, one
 * IndexedDB transaction, one row. There is then no interval during which the
 * cursor names an event the store does not hold, because there is no moment at
 * which only one of them has been written.
 *
 * The client's in-memory view is seeded from `load`, so the cursor a room
 * resumes at is always a cursor whose event is in the array beside it.
 * `apps/web/test/realtime.test.ts` crashes a client mid-page — the journal
 * throws partway through a five-entry catch-up — and asserts the resumed
 * client's `lastSeq` names an event it actually holds.
 */
export interface RoomJournal {
  /** Everything durably applied for this room, and the cursor that goes with it. */
  load: (roomId: string) => { events: RoomEventEnvelope[]; lastSeq: number };
  /**
   * Record one applied entry and the cursor it implies, **atomically**.
   *
   * `lastSeq` is always `entry.roomSeq`; it is a separate parameter rather than
   * derived so the contract is legible at the call site and an implementation
   * writing a compact record does not have to re-derive the client's own
   * arithmetic. An implementation may not persist one without the other.
   */
  commit: (roomId: string, entry: RoomEventEnvelope, lastSeq: number) => void;
}

/**
 * The default: lives exactly as long as the client does.
 *
 * Crash-safe by construction rather than by care — a process that dies takes the
 * events and the cursor with it, so there is no state left to be inconsistent.
 * It is still written through the same two-in-one interface, because a default
 * whose shape differs from the durable one is a default that hides the durable
 * one's bugs.
 */
export function memoryJournal(): RoomJournal {
  const rooms = new Map<string, { events: RoomEventEnvelope[]; lastSeq: number }>();
  const room = (roomId: string) => {
    let existing = rooms.get(roomId);
    if (!existing) {
      existing = { events: [], lastSeq: 0 };
      rooms.set(roomId, existing);
    }
    return existing;
  };
  return {
    load: (roomId) => {
      const current = room(roomId);
      return { events: [...current.events], lastSeq: current.lastSeq };
    },
    commit: (roomId, entry, lastSeq) => {
      const current = room(roomId);
      current.events.push(entry);
      current.lastSeq = Math.max(current.lastSeq, lastSeq);
    },
  };
}

/**
 * How many events one room keeps in `localStorage`.
 *
 * Chosen against the store rather than against a room: browsers give an origin
 * on the order of 5 MB *in total*, and a message event serializes to a few
 * hundred bytes, so a few hundred events per room leaves room for several rooms
 * and everything else the origin keeps. It is an option because the right number
 * is a property of the deployment, not of this file.
 */
export const DEFAULT_JOURNAL_MAX_EVENTS = 500;

export interface LocalStorageJournalOptions {
  /** Events retained per room. Older ones are evicted; see the note on the type. */
  maxEvents?: number;
  /**
   * Called when this journal stops being durable for a room, with the reason.
   *
   * Not a silent degradation: a client whose journal has fallen back to memory
   * still works and still recovers, but it re-fetches the whole room on the next
   * reload, and an operator looking at why should be able to find out.
   */
  onDegraded?: (roomId: string, reason: string) => void;
}

/**
 * A `localStorage`-backed journal.
 *
 * One key per room holding `{events, lastSeq}` as one JSON value, so the durable
 * write is a single `setItem` — which is the whole reason this is a journal and
 * not a watermark. `localStorage` offers no transaction across two keys, so two
 * keys would reintroduce the window this interface exists to close; one key is
 * how you get atomicity out of a store that does not offer any.
 *
 * A record that does not parse, or whose cursor disagrees with its events, is
 * read as no history at all. That is deliberate: a torn write is the one case
 * where resuming is *worse* than replaying, and a room is cheap to reload.
 *
 * ## Bounded, and it never throws (#22 gauntlet r3 delta, major 2)
 *
 * > `localStorageJournal` is unbounded with no `QuotaExceededError` handling — a
 * > long room throws on every `applyEntry` after quota and stalls durable apply.
 *
 * Exactly right, and the second clause is the damaging one. `applyEntry` commits
 * *before* moving the in-memory view, so a throw from here leaves the client's
 * cursor where it was — which is the crash-safety property, and which turns into
 * a permanent stall when the throw is not transient. A full quota is not
 * transient: every subsequent event takes the same path and fails the same way,
 * and the room stops advancing at all. An unbounded store guarantees reaching
 * that state on any room that runs long enough.
 *
 * Two changes, and the second one is the contract:
 *
 * 1. **A bound.** The newest `maxEvents` are kept and older ones are evicted from
 *    the front. This is a *resume cache*, not an archive: the cursor still names
 *    the last event held, so the invariant this whole interface exists for is
 *    untouched, and a room whose scrollback was evicted re-reads it from the
 *    server like any other room the client does not have. What it must never do
 *    is grow until the store refuses it.
 * 2. **`commit` does not throw.** A write that cannot be made durable evicts
 *    harder and retries; if even a single entry will not fit, the room degrades
 *    to the in-memory journal, seeded with what it holds, and `onDegraded` says
 *    so. The client then behaves exactly like one configured with `memoryJournal`
 *    — it recovers everything from the server on the next load — instead of
 *    freezing. Throwing would preserve durability at the cost of the room, which
 *    is the wrong trade for a cache.
 *
 * The `RoomJournal` contract still permits a throw, and `applyEntry` still
 * handles one correctly; this implementation simply has no failure for which
 * stopping is better than degrading.
 */
export function localStorageJournal(
  namespace: string,
  options: LocalStorageJournalOptions = {},
): RoomJournal {
  const key = (roomId: string) => `atrium:journal:${namespace}:${roomId}`;
  const maxEvents = Math.max(1, options.maxEvents ?? DEFAULT_JOURNAL_MAX_EVENTS);
  const fallback = memoryJournal();
  /** Rooms this journal has stopped being durable for. */
  const degraded = new Set<string>();
  const storage = (): Storage | null => {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      // Private-mode and blocked-cookie browsers throw on *access*, not on use.
      return null;
    }
  };
  /** Keep the newest `maxEvents`. The cursor names the last of them either way. */
  const trim = (events: RoomEventEnvelope[]): RoomEventEnvelope[] =>
    events.length <= maxEvents ? events : events.slice(events.length - maxEvents);

  const readDurable = (roomId: string): { events: RoomEventEnvelope[]; lastSeq: number } => {
    const store = storage();
    if (!store) return { events: [], lastSeq: 0 };
    const raw = store.getItem(key(roomId));
    if (raw === null) return { events: [], lastSeq: 0 };
    try {
      const parsed = JSON.parse(raw) as { events?: unknown; lastSeq?: unknown };
      const events = Array.isArray(parsed.events) ? (parsed.events as RoomEventEnvelope[]) : null;
      const lastSeq = typeof parsed.lastSeq === 'number' ? parsed.lastSeq : null;
      if (events === null || lastSeq === null) return { events: [], lastSeq: 0 };
      // The invariant the whole interface exists for, checked on the way back
      // in: the cursor may not name a position past the last event held. Still
      // exact under eviction — trimming drops from the front, never the end.
      const held = events.at(-1)?.roomSeq ?? 0;
      if (lastSeq !== held) return { events: [], lastSeq: 0 };
      return { events, lastSeq };
    } catch {
      return { events: [], lastSeq: 0 };
    }
  };

  /**
   * Hand this room over to memory, keeping everything already held.
   *
   * Seeded rather than emptied: `load` must keep returning a cursor whose event
   * it holds, and dropping the history while keeping the cursor is the exact
   * inconsistency `RoomJournal` was built to make unrepresentable.
   */
  const degrade = (
    roomId: string,
    held: { events: RoomEventEnvelope[]; lastSeq: number },
    reason: string,
  ): void => {
    if (!degraded.has(roomId)) {
      degraded.add(roomId);
      for (const event of held.events) fallback.commit(roomId, event, event.roomSeq);
      options.onDegraded?.(roomId, reason);
    }
  };

  const readRoom = (roomId: string): { events: RoomEventEnvelope[]; lastSeq: number } => {
    if (!storage() || degraded.has(roomId)) return fallback.load(roomId);
    return readDurable(roomId);
  };

  return {
    load: readRoom,
    commit: (roomId, entry, lastSeq) => {
      const store = storage();
      if (!store || degraded.has(roomId)) {
        fallback.commit(roomId, entry, lastSeq);
        return;
      }
      const current = readDurable(roomId);
      current.events.push(entry);
      let kept = trim(current.events);
      for (;;) {
        try {
          store.setItem(key(roomId), JSON.stringify({ events: kept, lastSeq }));
          return;
        } catch (error) {
          // Halve and retry: the quota is about bytes and this is the cheapest
          // way to find a size that fits without measuring the store. One entry
          // that will not fit is a store that cannot hold this room at all.
          if (kept.length > 1) {
            kept = kept.slice(Math.ceil(kept.length / 2));
            continue;
          }
          // `current.events` already carries `entry`, so the seed is the whole
          // history including this commit — no second write, and no duplicate.
          degrade(roomId, { events: current.events, lastSeq }, describeStorageError(error));
          return;
        }
      }
    },
  };
}

/** A storage failure in words, without assuming `DOMException` exists. */
function describeStorageError(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return 'localStorage is full — this room is now kept in memory and will be re-read from the server on the next load';
  }
  const message = error instanceof Error ? error.message : String(error);
  return `localStorage refused the write (${message}) — this room is now kept in memory`;
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
  /**
   * Where this room's applied events and its cursor are kept — together. In
   * memory unless you say otherwise; see `RoomJournal` for why the two are one
   * interface and not two.
   */
  journal?: RoomJournal;
  /**
   * How many entries to ask for per catch-up page.
   *
   * Defaulted rather than fixed because the *tests* need it: with the server's
   * 1000-entry default, a 12- or 40-event fixture never crosses a page boundary,
   * so multi-page catch-up went unexercised by anything but a fake socket
   * (#22 gauntlet r2 delta, major 2). The integration suite sets it to a handful
   * and the loop is then a real loop over real pages.
   */
  catchUpPageSize?: number;
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

  const journal = options.journal ?? memoryJournal();
  const catchUpPageSize = options.catchUpPageSize;
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
      // Events and cursor together, from one read. They cannot disagree: a
      // journal that persists is required to write them in one operation, and
      // one that finds them inconsistent reports no history at all.
      const held = journal.load(roomId);
      existing = {
        roomId,
        lastSeq: held.lastSeq,
        head: held.lastSeq,
        seenSeq: 0,
        events: held.events,
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
    // Durable first, in one operation, and only then in memory.
    //
    // The order is the fix for r2-delta major 1. r2 mutated the in-memory array
    // and then wrote the cursor, so a crash in between left a cursor naming an
    // event nothing held. Committing the event and the cursor together, before
    // the in-memory view moves, means the two states a crash can leave are
    // "neither" and "both" — and a throw from the journal leaves the client's
    // own cursor where it was, so the entry is simply re-delivered by the next
    // catch-up rather than skipped.
    journal.commit(entry.roomId, entry, entry.roomSeq);
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
    if (entry.actor.userId !== options.userId) return;
    room.pending = room.pending.filter((item) => item.clientMessageId !== clientMessageId);
  }

  function requestSince(roomId: string): void {
    const frame: Record<string, unknown> = { type: 'since', roomId, roomSeq: view(roomId).lastSeq };
    if (catchUpPageSize !== undefined) frame.limit = catchUpPageSize;
    send(frame);
  }

  /**
   * Tell the server what this client actually holds.
   *
   * The server repeats its `head` frame to this socket until it hears this, and
   * that is deliberate (#22 gauntlet r3 delta, blocking 1): round 3 stopped
   * sending the head once it had *attempted* delivery, so a socket that dropped
   * an event frame in a room that then went quiet had its cursor and its stale
   * head agree, and never asked. The one thing that can distinguish "sent" from
   * "held" is the holder saying so.
   *
   * Sent from two places, and both are needed. On every `head` frame, so the
   * server learns the truth even when the catch-up that follows fails or stalls;
   * and again when a catch-up loop finishes caught up, so the steady state is
   * silent rather than one frame per interval forever.
   */
  function acknowledgeHead(roomId: string): void {
    send({ type: 'ack_head', roomId, roomSeq: view(roomId).lastSeq });
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
      case 'head': {
        // The server's reconciler saying where the room actually is, with no
        // frame required to have arrived. Same arithmetic as everywhere else:
        // behind the head means ask for the gap.
        const room = view(frame.roomId);
        room.head = Math.max(room.head, frame.head);
        if (room.lastSeq < room.head) requestSince(frame.roomId);
        // Answered whether or not there was a gap. "I am at 37, you said 40" is
        // as useful to the server as "I have 40": both retire nothing until the
        // cursor reaches the head, and an unanswered frame is the server's cue
        // to say it again.
        acknowledgeHead(frame.roomId);
        changed(frame.roomId);
        return;
      }
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
          // Caught up, and the server is told so. Without this the server would
          // keep repeating `head` every reconciliation pass for a client that
          // has everything — correct, and noisy forever.
          acknowledgeHead(frame.roomId);
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
