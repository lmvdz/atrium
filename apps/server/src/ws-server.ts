import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { checkOrigin, describeUnknown, guardedErrorLog, rawPathname } from '@atrium/auth';
import { type WebSocket, WebSocketServer } from 'ws';
import { type AttachmentSigner, DownloadRequest, UploadRequest } from './attachments.js';
import type { CommandService, PresenceState } from './commands.js';
import type { EventBus } from './event-bus.js';
import { createHeadAcks } from './head-acks.js';
import { createHub, type Hub } from './hub.js';
import {
  CommandError,
  type FoldedLedgerEntry,
  isMalformedEntry,
  type Ledger,
  type LedgerEntry,
} from './ledger.js';
import type { Logger } from './logger.js';
import {
  ClientFrame,
  type EphemeralFrame,
  type ServerFrame,
  type WireEntry,
  type WireEvent,
} from './protocol.js';
import { createReconciler, DEFAULT_RECONCILE_INTERVAL_MS, type Reconciler } from './reconciler.js';
import {
  type MembershipPair,
  membershipKey,
  type Session,
  type SessionAuthenticator,
} from './session.js';
import { toHeaders } from './ws-auth.js';

/**
 * How long a revoked member may still be receiving a room, in milliseconds.
 *
 * This is **the number** #22 r9 exists to make nameable: before it, the answer
 * was "until the socket drops", which the shipped client does not do voluntarily
 * and undoes by reconnecting. One second, because the cost of a pass is one
 * primary-key probe per subscription in one statement, and because the thing on
 * the other side of the window is the room's message bodies going to somebody
 * who was removed from it.
 *
 * A second, not a tenth: the pass is a database round trip and the leak is
 * bounded either way, so there is no reason to spend a query per 100 ms of a
 * window that is already short enough that a revocation and the next message
 * rarely fit inside it.
 */
export const MEMBERSHIP_REVALIDATE_INTERVAL_MS = 1_000;

/**
 * Realtime transport. Ordinary WebSockets, server-authoritative state — no
 * CRDT, no custom sync protocol (init.md, "Realtime transport").
 *
 * This file owns the socket lifecycle and nothing else: it parses a frame,
 * hands it to the command service, and fans the result out. Ordering,
 * durability and the append invariant all live in `ledger.ts`, so a bug in the
 * socket layer can drop a delivery but cannot corrupt history — the client
 * recovers by asking `since(room, room_seq)`.
 *
 * ## Identity at upgrade, membership at command
 *
 * The session is resolved once, during the HTTP upgrade, and a socket that
 * cannot be identified is refused before it becomes a WebSocket (401, not a
 * connected-but-useless socket). Membership is *not* cached alongside it: it is
 * re-read per command — and, for anything that appends, re-read again inside
 * the append transaction — because a socket outlives a membership and "you were
 * a member when you connected" is not an answer to "may you write this now".
 *
 * ## Membership at fan-out, with a window that is a number
 *
 * The sentence above is about **writing**. The *fan-out* set is a second thing
 * and used to be a subscribe-time snapshot that nothing ever re-read: `hub`
 * holds a subscription until the socket closes or unsubscribes, and `broadcast`
 * consults that map, not `memberships`. r8 measured what that cost — a member
 * whose membership was deleted kept receiving the room's `event` frames, **with
 * full message bodies**, and its `head` frames, for as long as the socket
 * stayed open. Measured on the production build at production defaults: six
 * event frames and thirty head frames over sixty seconds, socket still open.
 * r8 recorded it here and shipped it, on the grounds that closing it meant
 * "either a membership read per subscriber per event or a revocation signal the
 * system does not have".
 *
 * **Both halves of that were wrong, and r9 closes it.** The bound was never a
 * duration — it was *until the socket drops*, and the shipped client does not
 * drop it voluntarily and reconnects if the wire does. And the cost is neither
 * of the two things named: it is **one statement per pass over every
 * subscription on this instance** (`Authorizer.present`), which is a primary-key
 * probe per pair, not a read per event and not a new signal.
 *
 * So `revalidateSubscriptions` runs on its own timer and drops any subscription
 * whose membership row is gone: out of the hub, out of `headAcks`, and an
 * `unsubscribed` frame to the socket so the client stops rendering the room
 * rather than silently going quiet. The socket itself stays open — a person
 * removed from one room is usually still in others, and closing the connection
 * would make revocation a denial of service against every room they are still
 * in. Rooms, not sockets, are the unit that was revoked.
 *
 * **The window is `MEMBERSHIP_REVALIDATE_INTERVAL_MS`, one second by default**
 * (`WS_MEMBERSHIP_REVALIDATE_INTERVAL_MS`). That is the number: a revoked member
 * may receive at most the frames this instance fans out in the second following
 * the delete, and no frame after it. Not "until they disconnect", and not the
 * fifteen seconds a revocation *sweep* over sockets would give — see below for
 * why this is a poll and not an event.
 *
 * What was already true and stays true: the revoked member cannot write
 * (checked twice, the second time under the append lock), their `since` is
 * refused, and a reconnect never resubscribes.
 *
 * ### Why a timer and not a notification
 *
 * The tempting shape is a `pg_notify` on `memberships`, riding the LISTEN/NOTIFY
 * plumbing this file already owns, for a millisecond-scale teardown. It is not
 * the guarantee, for two reasons and the second is the one that decides it:
 *
 *  1. `bus` is **optional** — a single-instance deployment carries no listener —
 *     and `NOTIFY` is at-most-once, lost on listener disconnect and on rollback.
 *     A notification could only ever lower the latency under a bound that a
 *     periodic re-read has to establish anyway. Once that bound is a second,
 *     what is left to buy is most of a second.
 *  2. `NOTIFY` requires **no privilege in Postgres** — r6's blocking finding, and
 *     the reason `EphemeralNote` has a closed alphabet. A revocation channel's
 *     alphabet is `(roomId, userId)`, in which *every* value is legitimately
 *     shaped, so no schema can close it: anything that can connect to the
 *     database could evict arbitrary people from arbitrary rooms. The poll has
 *     no such surface, because the only thing it believes is a row.
 *
 * If a teardown signal does arrive from elsewhere — #26's revocation sweep closes
 * the *socket* on a interval of its own — the two compose without either knowing
 * about the other: this drops the subscription, that drops the connection, and
 * whichever is faster is the one that decides.
 *
 * There is no anonymous fallback and no unauthenticated configuration. Round 1
 * defaulted an unresolved session to `{ userId: 'anonymous' }` when no
 * authenticator was wired, which is a fail-open seam: the day someone forgets
 * to pass `session`, every socket becomes a user called "anonymous" and the
 * membership check that stands between it and a room becomes a check on
 * whether "anonymous" happens to be a member. A server with no authenticator
 * now refuses every upgrade instead (r1 polish).
 *
 * ## Fan-out is local; delivery is not
 *
 * `hub` only knows about sockets attached to *this* process. What makes a
 * second instance's commits reach this one's subscribers is `event-bus.ts`: a
 * commit is announced on a Postgres channel, every instance folds the rows it
 * has not seen, and each fans them out to its own subscribers. Presence,
 * typing, and the payload-free signal to reread a persisted projection are not
 * history; they are relayed as frames on a second channel.
 */

export interface RealtimeOptions {
  host: string;
  port: number;
  heartbeatIntervalMs: number;
  logger: Logger;
  /** Reported by `GET /health`; the server is only ready once the queue is up. */
  isReady: () => boolean;
  /** Absent in the transport-only smoke configuration; present in the real server. */
  commands?: CommandService;
  ledger?: Ledger;
  /**
   * Required. Not optional-with-a-default: a missing authenticator now refuses
   * every upgrade rather than inventing an identity for it (see the file note).
   */
  session: SessionAuthenticator;
  /**
   * Cross-instance fan-out. Optional, and its absence is a real deployment
   * choice — a single instance needs nobody to tell — but the compose file and
   * the README both say plainly which mode is which.
   */
  bus?: EventBus;
  /** Short-lived direct S3/MinIO capabilities; absent disables attachment routes. */
  attachments?: AttachmentSigner;
  /**
   * How often to reconcile against the ledger regardless of notifications.
   *
   * There is no way to switch it off, and that is deliberate: the r2 delta
   * gauntlet's blocking finding was a delivery path that existed only while a
   * doorbell kept being heard, and an option to disable the durable path would
   * be that finding with a config flag in front of it. Tests shorten it; nothing
   * removes it.
   */
  reconcileIntervalMs?: number;
  /**
   * How often the fan-out set is re-checked against `memberships` — and
   * therefore the longest a revoked member can still be receiving the room.
   *
   * Like `reconcileIntervalMs` there is no way to switch it off, for the same
   * reason: an option to disable it would be the r8 defect with a config flag in
   * front of it. Tests shorten it; nothing removes it.
   */
  membershipRevalidateIntervalMs?: number;

  /* ---------------------------------------------------------------------------
   * THE TRUST BOUNDARY, GRAFTED FROM #26 ONTO THE SEAM #22 LEFT FOR IT.
   *
   * `session` above is the seam the realtime lane wrote and labelled "#26
   * replaces this and nothing else". These three are what the auth lane put
   * around it in `ws-presence-server.ts`, and they are not part of the wire
   * protocol — they are properties of the HANDSHAKE and of how long an
   * established identity stays good, so they port across a protocol difference
   * unchanged. They are here rather than left behind because the alternative is
   * a shipped server whose upgrade is reachable cross-origin and whose sockets
   * outlive the sessions that opened them.
   * ------------------------------------------------------------------------- */

  /**
   * Origins allowed to open a socket. Checked BEFORE the session, deliberately.
   *
   * A WebSocket handshake ignores the same-origin policy and still carries
   * cookies, so a page on any other site can open one and be authenticated as
   * whoever is signed in. Checking the session first would mean the *valid*
   * session is exactly what makes the hijack work. This is the check Better
   * Auth makes on its own endpoints via `trustedOrigins`; the socket makes it
   * against the same list.
   */
  allowedOrigins: readonly string[];
  /**
   * Whether a client that sends no `Origin` header may open a socket. Browsers
   * always send one, so `false` is right for a browser-facing deployment and is
   * what makes the origin check meaningful — an attacker who could simply omit
   * the header would face no check at all.
   */
  allowOriginless?: boolean;
  /**
   * Re-resolve an open socket's session, so a socket does not outlive the
   * session that opened it. Runs on the membership revalidation pass, which
   * already exists and already walks every connection — one timer, two
   * questions, rather than a second sweep asking half of the same one.
   *
   * Absent means no session revalidation, which is the transport-only smoke
   * configuration; the real server passes it.
   */
  revalidateSession?: (headers: Headers) => Promise<{ userId: string } | null>;
  /** How long a resolved session is trusted between re-validations. */
  revalidateTtlMs?: number;
}

export interface RealtimeServer {
  httpServer: Server;
  wss: WebSocketServer;
  hub: Hub<ServerFrame>;
  connectionCount: () => number;
  /** Run one reconciliation pass now — the timer's work, on demand, for tests. */
  reconcile: () => Promise<void>;
  /**
   * Run one membership revalidation pass now.
   *
   * The same function the timer calls, exposed for the same reason `reconcile`
   * is: a test that waits on wall clock to observe a bound is a test that is
   * measuring the timer rather than the rule.
   */
  revalidateSubscriptions: () => Promise<void>;
  /** Tell authorized subscribers to re-read non-ledger projections. */
  projectionChanged: (roomId: string, at?: string) => void;
  listen: () => Promise<void>;
  close: () => Promise<void>;
}

interface Connection {
  id: string;
  alive: boolean;
  session: Session;
  /**
   * The upgrade request's headers, kept so the session can be re-resolved from
   * the same cookies later. A socket has no request of its own after the
   * handshake, and re-reading the cookie is the only way to learn that the
   * session behind it was revoked.
   */
  headers: Headers;
  /** When the resolved session stops being trusted without a re-check. */
  validUntil: number;
  /** Ephemeral declarations made by this socket, keyed by room. */
  presence: Map<string, { state: PresenceState; at: string }>;
}

export function createRealtimeServer(options: RealtimeOptions): RealtimeServer {
  const { logger, heartbeatIntervalMs, commands, ledger, session, bus } = options;
  const logSafely = guardedErrorLog(logger);
  /**
   * REQUIRED, NOT DEFAULTED, AND `allowOriginless` DEFAULTS TO REFUSING.
   *
   * A default would have to be either "allow everything" (the check does not
   * exist) or "allow nothing" (every deployment that forgets it is broken in a
   * way that looks like a bug rather than a policy). Making the caller say it is
   * the third option, and it is why the two transport-only test harnesses now
   * declare `allowOriginless: true` in one visible line instead of inheriting it.
   */
  const originPolicy = {
    allowed: options.allowedOrigins,
    allowOriginless: options.allowOriginless ?? false,
  };
  const revalidateSession = options.revalidateSession;
  const revalidateTtlMs = options.revalidateTtlMs ?? 5_000;
  const connections = new WeakMap<WebSocket, Connection>();
  /**
   * The same connections, reachable by the id the hub knows them by.
   *
   * `connections` is keyed by socket, and the revalidation pass starts from the
   * hub's subscriber ids — it has to get from "this subscription" back to "whose
   * membership is that". Deleted on close beside `hub.drop`, so it holds exactly
   * the live connections and not one entry per connection for the life of the
   * process.
   */
  const byConnectionId = new Map<string, Connection>();

  function aggregatePresence(roomId: string, userId: string): PresenceState {
    let answer: PresenceState = 'offline';
    for (const candidate of byConnectionId.values()) {
      if (candidate.session.userId !== userId) continue;
      const state = candidate.presence.get(roomId)?.state;
      if (state === 'online') return 'online';
      if (state === 'away') answer = 'away';
    }
    return answer;
  }

  function publishPresence(
    roomId: string,
    userId: string,
    state: PresenceState,
    at = new Date().toISOString(),
  ): void {
    const frame: EphemeralFrame = { type: 'presence', roomId, userId, state, at };
    hub.broadcast(roomId, frame);
    bus?.relay(roomId, frame);
  }
  const hub = createHub<ServerFrame>();
  /**
   * What each socket has acknowledged holding, per room. The head frame's only
   * stopping condition — see `head-acks.ts` for why an attempt is not one.
   *
   * Bounded by the hub's own subscription map rather than by a cap: a socket can
   * only acknowledge rooms it is in, and `handleSubscribe` is the only thing that
   * puts it in one, after `requireMembership`. So this map holds exactly the
   * rooms a socket could be sent a head frame about (r4 delta, major).
   */
  const headAcks = createHeadAcks({
    subscribed: (subscriberId, roomId) => hub.isSubscribed(roomId, subscriberId),
  });

  const httpServer = createServer((req, res) => {
    if (req.url === '/health') {
      const ready = options.isReady();
      res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: ready ? 'ok' : 'starting', connections: wss.clients.size }));
      return;
    }
    void handleHttp(req, res).catch((error: unknown) => {
      logSafely('http request failed unexpectedly', () => ({ error: describeUnknown(error) }));
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'request failed' }));
    });
  });

  async function handleHttp(req: IncomingMessage, res: import('node:http').ServerResponse) {
    const path = rawPathname(req.url ?? '/');
    if (path !== '/attachments/presign-upload' && path !== '/attachments/presign-download') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
    if (checkOrigin(origin, originPolicy) !== 'allowed') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    const cors = {
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-origin': origin as string,
      'cache-control': 'no-store',
      vary: 'Origin',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { ...cors, 'content-type': 'application/json', allow: 'POST, OPTIONS' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }
    if (!options.attachments || !commands) {
      res.writeHead(503, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'attachments are not configured' }));
      return;
    }

    let identified: Session | null = null;
    try {
      identified = await session.authenticateUpgrade(req);
    } catch (error) {
      logSafely('attachment auth failed', () => ({ error: describeUnknown(error) }));
    }
    if (!identified) {
      res.writeHead(401, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(await readRequestBody(req));
    } catch {
      res.writeHead(400, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'malformed request' }));
      return;
    }
    const parsed = path.endsWith('presign-upload')
      ? UploadRequest.safeParse(json)
      : DownloadRequest.safeParse(json);
    if (!parsed.success) {
      res.writeHead(400, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid attachment request' }));
      return;
    }
    try {
      await commands.requireMembership(identified, parsed.data.roomId);
      const answer = path.endsWith('presign-upload')
        ? await options.attachments.upload(parsed.data as import('./attachments.js').UploadRequest)
        : await options.attachments.download(
            parsed.data as import('./attachments.js').DownloadRequest,
          );
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    } catch {
      /* Same answer for a missing room, another room, and a key outside it: the
         endpoint must not become a room/key existence oracle. */
      res.writeHead(403, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'attachment request refused' }));
    }
  }

  function readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let length = 0;
      req.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > 16 * 1024) {
          reject(new Error('request body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  // `noServer` rather than `{ server }`: the upgrade has to be refused *before*
  // the handshake completes when there is no session, and that is only possible
  // if we own the upgrade event.
  const wss = new WebSocketServer({ noServer: true });

  function reject(socket: Duplex, status: number, reason: string): void {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  /**
   * THE UPGRADE ARM ALSO ANSWERS — #26's fix, kept.
   *
   * An unhandled rejection out of `authenticateUpgrade` used to leave the TCP
   * socket neither upgraded nor rejected: open, attached to nothing, until the
   * peer gave up. Refusing with a 500 is both louder and fail-closed.
   */
  httpServer.on('upgrade', (request, socket, head) => {
    handleUpgrade(request, socket, head).catch((error: unknown) => {
      logSafely('ws upgrade failed unexpectedly', () => ({ error: describeUnknown(error) }));
      try {
        reject(socket, 500, 'Internal Server Error');
      } catch {
        // The socket is already gone. Nothing left to say to it.
      }
    });
  });

  async function handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    // `rawPathname`, not `new URL(...).pathname` — #26's fix, kept. URL parsing
    // resolves dot segments, and a guard handed a rewritten path is answering
    // about a request nobody made. `/ws/../ws` is not `/ws` here.
    const path = rawPathname(request.url ?? '/');
    if (path !== '/ws') {
      reject(socket, 404, 'Not Found');
      return;
    }

    // ORIGIN BEFORE SESSION. See `allowedOrigins` on the options: a valid
    // session is what makes a cross-origin socket dangerous, so checking it
    // first would put the check behind the thing it is protecting against.
    const origin = request.headers.origin;
    const verdict = checkOrigin(Array.isArray(origin) ? origin[0] : origin, originPolicy);
    if (verdict !== 'allowed') {
      logger.warn('ws upgrade rejected: origin', {
        verdict,
        origin: Array.isArray(origin) ? origin[0] : origin,
        remote: request.socket.remoteAddress,
      });
      reject(socket, 403, 'Forbidden');
      return;
    }

    // Closed by default. An unresolved session is a refusal, never an
    // identity: the membership check downstream is only worth something if
    // the thing it checks was actually established.
    let resolved: Session | null = null;
    try {
      resolved = await session.authenticateUpgrade(request);
    } catch (error) {
      logSafely('ws upgrade auth failed', () => ({ error: describeUnknown(error) }));
      resolved = null;
    }
    if (!resolved) {
      reject(socket, 401, 'Unauthorized');
      return;
    }
    const identified = resolved;
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, identified);
    });
  }

  const send = (socket: WebSocket, frame: ServerFrame) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  };

  wss.on('connection', (socket: WebSocket, request: IncomingMessage, resolved?: Session) => {
    if (!resolved) {
      // Only reachable if something emitted `connection` without going through
      // the upgrade handler above. There is no identity to fall back on and
      // inventing one is the fail-open seam this round removed, so the socket
      // is closed instead.
      logger.error('ws connection without a resolved session — closing');
      socket.close(1011, 'no session');
      return;
    }
    const connection: Connection = {
      id: randomUUID(),
      alive: true,
      session: resolved,
      headers: toHeaders(request),
      validUntil: Date.now() + revalidateTtlMs,
      presence: new Map(),
    };
    connections.set(socket, connection);
    byConnectionId.set(connection.id, connection);
    logger.info('ws connected', {
      connectionId: connection.id,
      userId: connection.session.userId,
      remote: request.socket.remoteAddress,
      total: wss.clients.size,
    });

    send(socket, {
      type: 'welcome',
      connectionId: connection.id,
      userId: connection.session.userId,
      heartbeatIntervalMs,
    });

    socket.on('pong', () => {
      const state = connections.get(socket);
      if (state) state.alive = true;
    });

    socket.on('message', (raw) => {
      void handleFrame(socket, connection, raw.toString());
    });

    socket.on('close', (code) => {
      const declaredRooms = [...connection.presence.keys()];
      hub.drop(connection.id);
      // Or the maps grow one entry per connection for the life of the process.
      headAcks.forget(connection.id);
      byConnectionId.delete(connection.id);
      for (const roomId of declaredRooms) {
        publishPresence(
          roomId,
          connection.session.userId,
          aggregatePresence(roomId, connection.session.userId),
        );
      }
      logger.info('ws disconnected', { connectionId: connection.id, code });
    });

    socket.on('error', (error: Error) => {
      logger.error('ws socket error', { connectionId: connection.id, error: error.message });
    });
  });

  /** "Done, and nothing was appended" — presence, typing, the read cursor. */
  function ackEphemeral(socket: WebSocket, commandId: string, roomId: string): void {
    send(socket, {
      type: 'ack',
      commandId,
      roomId,
      seq: null,
      roomSeq: null,
      eventId: null,
      issues: [],
    });
  }

  function subscriberFor(socket: WebSocket, connection: Connection) {
    return {
      id: connection.id,
      send: (frame: ServerFrame) => send(socket, frame),
    };
  }

  async function handleFrame(
    socket: WebSocket,
    connection: Connection,
    raw: string,
  ): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      send(socket, { type: 'error', message: 'frame is not valid JSON' });
      return;
    }

    const frame = ClientFrame.safeParse(parsed);
    if (!frame.success) {
      // A malformed *command* gets a nack against its id when we can find one,
      // so a client waiting on that id is not left waiting forever.
      const commandId =
        typeof parsed === 'object' && parsed !== null && 'commandId' in parsed
          ? String((parsed as { commandId: unknown }).commandId)
          : null;
      if (commandId) {
        send(socket, {
          type: 'nack',
          commandId,
          code: 'malformed',
          message: frame.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        });
        return;
      }
      send(socket, { type: 'error', message: 'unknown frame type' });
      return;
    }

    switch (frame.data.type) {
      case 'hello':
        send(socket, {
          type: 'welcome',
          connectionId: connection.id,
          userId: connection.session.userId,
          heartbeatIntervalMs,
        });
        return;
      case 'ping':
        send(socket, { type: 'pong', at: new Date().toISOString() });
        return;
      case 'subscribe':
        await handleSubscribe(socket, connection, frame.data.roomId);
        return;
      case 'unsubscribe':
        connection.presence.delete(frame.data.roomId);
        hub.unsubscribe(frame.data.roomId, connection.id);
        headAcks.forgetRoom(connection.id, frame.data.roomId);
        send(socket, { type: 'unsubscribed', roomId: frame.data.roomId });
        publishPresence(
          frame.data.roomId,
          connection.session.userId,
          aggregatePresence(frame.data.roomId, connection.session.userId),
        );
        return;
      case 'ack_head':
        // No reply: this is a statement a socket makes about itself, it is only
        // ever read to decide whether to send that same socket a `head` frame,
        // and answering it would be one more frame in the loop this exists to
        // terminate.
        //
        // It is not unbounded, though — r4's version was, and that was the r4
        // delta's major. `record` refuses a room the socket is not subscribed to,
        // so a client cannot grow the server's map by naming rooms it invented.
        // Refusal is logged rather than nacked: an `ack_head` and an
        // `unsubscribe` can legitimately cross on the wire, and a client that has
        // just left a room should not get an error for the frame it had already
        // sent.
        if (!headAcks.record(connection.id, frame.data.roomId, frame.data.roomSeq)) {
          logger.debug('ignored ack_head for an unsubscribed room', {
            connectionId: connection.id,
            roomId: frame.data.roomId,
          });
        }
        return;
      case 'since':
        await handleSince(socket, connection, frame.data);
        return;
      case 'command':
        await handleCommand(socket, connection, frame.data.commandId, frame.data.command);
        return;
      default: {
        const exhaustive: never = frame.data;
        logger.warn('unhandled frame', { frame: exhaustive });
      }
    }
  }

  async function handleSubscribe(
    socket: WebSocket,
    connection: Connection,
    roomId: string,
  ): Promise<void> {
    if (!commands || !ledger) {
      send(socket, { type: 'error', message: 'realtime rooms are not configured' });
      return;
    }
    try {
      const membership = await commands.requireMembership(connection.session, roomId);
      hub.subscribe(roomId, subscriberFor(socket, connection));
      // A fresh subscription has acknowledged nothing, whatever a previous one
      // on this connection said. The client's own `since` and the `ack_head`
      // that follows it are what move this.
      headAcks.reset(connection.id, roomId);
      send(socket, {
        type: 'subscribed',
        roomId,
        head: await ledger.head(roomId),
        seenSeq: membership.seenSeq,
      });
      /* A subscriber must learn who was already here, not only who changes
         after it arrives. Presence stays ephemeral: this is a snapshot of the
         in-process socket register and writes no room event. One app server is
         the Phase-2 deployment topology; the bus still relays later changes. */
      const users = new Set(
        [...byConnectionId.values()]
          .filter((candidate) => candidate.presence.has(roomId))
          .map((candidate) => candidate.session.userId),
      );
      for (const userId of users) {
        send(socket, {
          type: 'presence',
          roomId,
          userId,
          state: aggregatePresence(roomId, userId),
          at: new Date().toISOString(),
        });
      }
    } catch (error) {
      send(socket, { type: 'error', message: describe(error) });
    }
  }

  async function handleSince(
    socket: WebSocket,
    connection: Connection,
    request: { roomId: string; roomSeq: number; limit?: number },
  ): Promise<void> {
    if (!commands || !ledger) {
      send(socket, { type: 'error', message: 'realtime rooms are not configured' });
      return;
    }
    try {
      await commands.requireMembership(connection.session, request.roomId);
      const limit = request.limit ?? 1000;
      // One snapshot for both the page and the head, so `more` is a fact about
      // a state that existed rather than a comparison across two moments.
      const page = await ledger.catchUpPage(request.roomId, request.roomSeq, limit);
      send(socket, {
        type: 'catchup',
        roomId: request.roomId,
        from: request.roomSeq,
        to: page.to,
        head: page.head,
        /**
         * `to < head`. Nothing else, and in particular not page fullness.
         *
         * Round 1 said `entries.length === limit && to < head`, and that was
         * the blocking finding: during concurrent writes a page can come back
         * *short* of the limit while the head has already moved past it —
         * rows land between the two reads — and the client is then told it is
         * caught up when it is not. It has no reason to ask again, and if the
         * burst has ended there is no live event coming to reveal the hole
         * either. The tail is simply gone, from a client that believes it has
         * everything.
         */
        more: page.more,
        // #46 (BLOCKER 1): a malformed row rides the wire as a tombstone, not
        // filtered off it. Filtering left a hole at that `room_seq`, and the
        // client's `applyEntry` accepts only `lastSeq + 1`, so it re-requested the
        // gap and stalled forever — the server outage moved to the client. The
        // tombstone carries the position with no event, so the client advances its
        // cursor past the bad row and the valid rows after it land.
        entries: page.entries.map(toWireEntry),
      });
    } catch (error) {
      send(socket, { type: 'error', message: describe(error) });
    }
  }

  async function handleCommand(
    socket: WebSocket,
    connection: Connection,
    commandId: string,
    command: Parameters<CommandService['execute']>[1],
  ): Promise<void> {
    if (!commands) {
      send(socket, {
        type: 'nack',
        commandId,
        code: 'invalid',
        message: 'commands are not configured on this server',
      });
      return;
    }
    try {
      const result = await commands.execute(connection.session, command);
      switch (result.kind) {
        case 'appended': {
          const entry: WireEvent = {
            roomId: result.roomId,
            roomSeq: result.roomSeq,
            seq: result.seq,
            actor: result.actor,
            event: result.event,
            // The same list the `ack` carries, on the frame everybody else gets
            // (#22 r10, D4). One value, two recipients — not two derivations.
            issues: result.issues,
          };
          send(socket, {
            type: 'ack',
            commandId,
            roomId: result.roomId,
            seq: result.seq,
            roomSeq: result.roomSeq,
            eventId: result.event.id,
            issues: result.issues,
            // `open_session` carries the draw outcome; every other command leaves
            // it undefined (#118 fix r2, HIGH-3).
            ...(result.draw ? { draw: result.draw } : {}),
          });
          // Including the sender: the ack carries the position, the event
          // carries the canonical body, and a client that rendered its own
          // optimistic echo replaces it from the event like everyone else.
          hub.broadcast(result.roomId, { type: 'event', entry });
          return;
        }
        case 'appended_many': {
          const last = result.entries.at(-1);
          if (!last) throw new Error('an appended batch returned no entries');
          send(socket, {
            type: 'ack',
            commandId,
            roomId: result.roomId,
            seq: last.seq,
            roomSeq: last.roomSeq,
            eventId: last.event.id,
            issues: result.entries.flatMap((entry) => entry.issues),
          });
          // The transaction has committed before execute() returns. Only now
          // can peers observe the three-event meaning, in room order. A retry
          // receives the original ack position but does not replay old live
          // frames into every participant's socket.
          if (!result.replayed) {
            for (const committed of result.entries) {
              hub.broadcast(result.roomId, { type: 'event', entry: toWire(committed) });
            }
          }
          return;
        }
        case 'presence': {
          if (result.state === 'offline') connection.presence.delete(result.roomId);
          else connection.presence.set(result.roomId, { state: result.state, at: result.at });
          publishPresence(
            result.roomId,
            result.userId,
            aggregatePresence(result.roomId, result.userId),
            result.at,
          );
          // Relayed, not evented. Presence is still never written to the
          // ledger (#14, asserted by a flood test) — the bus carries the frame
          // itself, because there is nothing durable to read it back from.
          ackEphemeral(socket, commandId, result.roomId);
          return;
        }
        case 'typing': {
          const frame: EphemeralFrame = {
            type: 'typing',
            roomId: result.roomId,
            userId: result.userId,
            typing: result.typing,
            at: result.at,
          };
          hub.broadcastExcept(result.roomId, connection.id, frame);
          // No `except` across the bus: the sender is on this instance, and a
          // peer has no subscriber that is this connection.
          bus?.relay(result.roomId, frame);
          ackEphemeral(socket, commandId, result.roomId);
          return;
        }
        case 'seen':
          send(socket, {
            type: 'seen',
            roomId: result.roomId,
            userId: result.userId,
            seenSeq: result.seenSeq,
          });
          ackEphemeral(socket, commandId, result.roomId);
          return;
        default: {
          const exhaustive: never = result;
          throw new Error(`unhandled command result ${JSON.stringify(exhaustive)}`);
        }
      }
    } catch (error) {
      const code = error instanceof CommandError ? error.code : 'invalid';
      if (!(error instanceof CommandError)) {
        logger.error('command failed', {
          connectionId: connection.id,
          command: command.name,
          error: describe(error),
        });
      }
      send(socket, { type: 'nack', commandId, code, message: describe(error) });
    }
  }

  /**
   * Fan out rows this instance folded but had not delivered — the reconciler's
   * output, and the doorbell's, through one function.
   *
   * That sameness is deliberate. A "reconciliation delivery" written separately
   * from live delivery is a second implementation of the thing this ticket is
   * about, free to disagree with the first; there is one, and both triggers call
   * it. A row folded twice is impossible because `sync` reads strictly past
   * `lastSeq`, so notifications are allowed to arrive out of order, twice, in a
   * batch, or not at all — the doorbell says "look", never "here it is", and
   * after r3 it does not even decide whether anyone looks.
   */
  function fanOut(entries: LedgerEntry[]): void {
    for (const entry of entries) {
      // #46 round 3: a malformed row rides the LIVE path too, as its own `tombstone`
      // frame, not filtered off it. Filtering was round 2's design and it left a
      // live-at-head client in a quiet room stranded — the row advanced no live
      // frame, so the client only recovered on the reconciler's next `head`→`since`,
      // one whole reconcile interval later, and not at all if that frame was lost.
      // `toWireEntry` emits a `WireEvent` for a folded row and a `WireTombstone` for
      // a marker; the tombstone travels under its own discriminant so a live `event`
      // frame stays a readable event, and `applyEntry` on the client renders the
      // tombstone as nothing and only advances the cursor. The ledger already logged
      // and counted the row.
      const wire = toWireEntry(entry);
      hub.broadcast(
        entry.roomId,
        'malformed' in wire ? { type: 'tombstone', entry: wire } : { type: 'event', entry: wire },
      );
    }
  }

  /**
   * Re-ask, of every subscription on this instance, the question `subscribe`
   * answered once: is this person still a member of this room?
   *
   * See the file note ("Membership at fan-out") for why this exists and why it
   * is a timer rather than a notification. Three properties are the whole design:
   *
   *  - **One statement, not one per subscriber.** Every `(user, room)` pair goes
   *    into a single `IN` over the memberships primary key. Two sockets in one
   *    room for one user collapse to one probe, because the pairs are deduped by
   *    the same key the answer comes back in.
   *  - **A missing answer is a revocation.** `present` returns who *is* still a
   *    member, so anything it does not name — deleted row, deleted room, a
   *    malformed id, a user who was never there — falls out. The direction
   *    matters: a "who was revoked" result would have to enumerate reasons, and
   *    every reason it did not think of would read as "still a member".
   *  - **The room is dropped, not the socket.** `unsubscribe` + `forgetRoom` is
   *    exactly what a client-requested `unsubscribe` does, and the client is told
   *    with the same frame, so nothing downstream has to learn a new state. A
   *    close would make losing one room a disconnection from all of them.
   *
   * A failed query logs and leaves the subscriptions alone, to be retried on the
   * next pass. The alternative — evicting everyone when the database is
   * unreachable — turns a blip into a room-wide disconnect, and buys nothing:
   * every path that produces a frame to leak (the ledger read behind `fanOut`,
   * the head query behind the reconciler) is reading the same database and is
   * failing at the same moment.
   */
  /**
   * A SOCKET DOES NOT OUTLIVE THE SESSION THAT OPENED IT — #26's rule, on #22's
   * timer.
   *
   * The auth lane ran this on a sweep of its own; here it rides the membership
   * pass, which already walks every live connection on a one-second cadence. One
   * timer asking both questions beats two timers asking overlapping halves of
   * one, and it means the session window and the membership window are the same
   * number rather than two numbers that can drift apart.
   *
   * Fail-CLOSED on a lookup that answers "no session", fail-OPEN on one that
   * throws: a revoked session is a closed socket, but a database that is down
   * is not evidence anybody was revoked, and closing every socket on a blip is
   * an outage amplifier. The membership half below makes the same split, and
   * `ws-presence-server.ts` carries the auth lane's stricter version — a socket
   * the sweep cannot verify for `WS_SWEEP_UNVERIFIED_MS` is closed anyway —
   * which is the next thing to port here once this seam has a home for it.
   */
  async function revalidateSessions(): Promise<void> {
    if (!revalidateSession) return;
    const now = Date.now();
    for (const socket of [...wss.clients]) {
      const connection = connections.get(socket);
      if (!connection || connection.validUntil > now) continue;
      let live: { userId: string } | null;
      try {
        live = await revalidateSession(connection.headers);
      } catch (error) {
        // Unverifiable, not revoked. Leave it and try again next pass.
        logSafely('session revalidation failed — socket left open', () => ({
          connectionId: connection.id,
          error: describeUnknown(error),
        }));
        continue;
      }
      if (live && live.userId === connection.session.userId) {
        connection.validUntil = now + revalidateTtlMs;
        continue;
      }
      logger.info('session revoked — closing socket', {
        connectionId: connection.id,
        userId: connection.session.userId,
        reason: live ? 'session now belongs to a different user' : 'session no longer resolves',
      });
      socket.close(4401, 'session revoked');
    }
  }

  async function revalidateSubscriptions(): Promise<void> {
    await revalidateSessions();
    if (!commands) return;
    const subscriptions: Array<{ roomId: string; connection: Connection }> = [];
    const probes = new Map<string, MembershipPair>();
    for (const roomId of hub.activeRooms()) {
      for (const subscriber of hub.subscribers(roomId)) {
        const connection = byConnectionId.get(subscriber.id);
        // A subscriber the connection map has already forgotten is a socket that
        // closed between the two reads. `hub.drop` has run or is about to; there
        // is nothing to revoke and nobody to tell.
        if (!connection) continue;
        subscriptions.push({ roomId, connection });
        probes.set(membershipKey(connection.session.userId, roomId), {
          userId: connection.session.userId,
          roomId,
        });
      }
    }
    if (subscriptions.length === 0) return;

    let held: Set<string>;
    try {
      held = await commands.stillMembers([...probes.values()]);
    } catch (error) {
      logger.error('membership revalidation failed — subscriptions left in place', {
        error: describe(error),
        subscriptions: subscriptions.length,
      });
      return;
    }

    for (const { roomId, connection } of subscriptions) {
      if (held.has(membershipKey(connection.session.userId, roomId))) continue;
      hub.unsubscribe(roomId, connection.id);
      headAcks.forgetRoom(connection.id, roomId);
      // Through the hub's own snapshot rather than the socket, so a subscription
      // that vanished mid-pass is a no-op instead of a frame sent to a room the
      // socket is no longer in.
      for (const socket of wss.clients) {
        if (connections.get(socket)?.id !== connection.id) continue;
        send(socket, { type: 'unsubscribed', roomId });
      }
      logger.info('subscription revoked — membership is gone', {
        connectionId: connection.id,
        userId: connection.session.userId,
        roomId,
      });
    }
  }

  /**
   * The durable delivery path. See `reconciler.ts` for what it covers and why it
   * cannot be turned off.
   */
  const reconciler: Reconciler | null = ledger
    ? createReconciler({
        ledger,
        logger,
        intervalMs: options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS,
        subscribedRooms: () => hub.activeRooms(),
        onEntries: fanOut,
        /**
         * Per socket, not per room, and gated on acknowledgement rather than on
         * attempt — #22 r3 delta, blocking 1.
         *
         * The reconciler now reports every subscribed room's head on every pass,
         * because it has no evidence about who received what and r3's bug was
         * acting as though it did. This is where the evidence is: a socket is
         * told the head until it has said it holds a position at or past it. A
         * `hub.broadcast` here would be the old shape again — one room-wide
         * decision standing in for one decision per socket.
         */
        onHead: (roomId, head) => {
          for (const subscriber of hub.subscribers(roomId)) {
            if (!headAcks.behind(subscriber.id, roomId, head)) continue;
            subscriber.send({ type: 'head', roomId, head });
          }
        },
      })
    : null;

  /**
   * The fan-out set's re-check. Started here rather than in `listen`, because it
   * costs nothing while nobody is subscribed (`activeRooms()` is empty and the
   * pass returns before it queries) and because a server that is accepting
   * sockets must already be revoking them.
   *
   * `void`, with the errors handled inside: a rejected promise from a timer is
   * the `unhandledRejection` this process exits on, and a database blip must not
   * be a restart.
   */
  const membershipRevalidateIntervalMs =
    options.membershipRevalidateIntervalMs ?? MEMBERSHIP_REVALIDATE_INTERVAL_MS;
  const revalidation = setInterval(() => {
    void revalidateSubscriptions();
  }, membershipRevalidateIntervalMs);
  revalidation.unref();

  // Heartbeat: a socket that misses one full interval without a pong is dead.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const state = connections.get(socket);
      if (!state) continue;
      if (!state.alive) {
        logger.warn('ws heartbeat timeout, terminating', { connectionId: state.id });
        socket.terminate();
        continue;
      }
      state.alive = false;
      socket.ping();
    }
  }, heartbeatIntervalMs);
  heartbeat.unref();

  return {
    httpServer,
    wss,
    hub,
    connectionCount: () => wss.clients.size,
    reconcile: async () => {
      await reconciler?.reconcile();
    },
    revalidateSubscriptions,
    projectionChanged: (roomId, at = new Date().toISOString()) => {
      const frame: EphemeralFrame = { type: 'projection_changed', roomId, at };
      hub.broadcast(roomId, frame);
      bus?.relay(roomId, frame);
    },
    listen: async () => {
      // Before the port opens, so no client can connect into a window where
      // this instance is serving but deaf to its peers.
      await bus?.start({
        onLedger: () => {
          void reconciler?.reconcile();
        },
        // `note.frame` is an `EphemeralFrame` — presence, typing, or a
        // projection-refresh signal, parsed
        // against a schema in `event-bus.ts` and structurally unable to be a
        // durable frame (#22 gauntlet r6, major 1). It used to be
        // `note.frame as ServerFrame`, which is how a forged `event` frame
        // published on an unprivileged `NOTIFY` reached a client's journal.
        // Nothing here has to decide anything: what arrives is already one of
        // exactly three shapes, and its room already matches the envelope's.
        onEphemeral: (note) => {
          hub.broadcast(note.roomId, note.frame);
        },
        // Fired on the first LISTEN and on every one postgres-js re-establishes
        // after a dropped connection. Everything that landed while this process
        // was deaf produced a notification nobody received, so the resubscribe
        // is immediately followed by a look at the ledger — which is the whole
        // of blocking finding 1's second half.
        onListen: () => {
          void reconciler?.reconcile();
        },
      });
      // Started before the port opens, so there is no window in which this
      // instance is serving and not reconciling.
      reconciler?.start();
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(options.port, options.host, () => {
          httpServer.removeListener('error', reject);
          const address = httpServer.address();
          logger.info('realtime server listening', {
            url: `ws://${options.host}:${typeof address === 'object' && address ? address.port : options.port}/ws`,
            instance: bus?.instanceId ?? 'single',
          });
          resolve();
        });
      });
    },
    close: async () => {
      clearInterval(heartbeat);
      clearInterval(revalidation);
      reconciler?.stop();
      await bus?.close();
      for (const socket of wss.clients) socket.close(1001, 'server shutting down');
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      logger.info('realtime server closed');
    },
  };
}

/**
 * A ledger row, as the wire carries it. **The only converter** — the reconciler's
 * fan-out used to spell the same five fields out inline, which is one more place
 * for a field to be forgotten, and `issues` is exactly the field it would have
 * been forgotten in (#22 r10, D4).
 */
function toWire(entry: FoldedLedgerEntry): WireEvent {
  return {
    roomId: entry.roomId,
    roomSeq: entry.roomSeq,
    seq: entry.seq,
    actor: entry.actor,
    event: entry.event,
    issues: [...entry.issues],
  };
}

/**
 * A ledger row as the wire carries it, tombstone included (#46, BLOCKER 1).
 *
 * A folded entry becomes a `WireEvent`; a malformed row becomes a `WireTombstone`
 * — a position with no event, no actor, no issues — so the client can advance its
 * cursor past the bad row without an event being fabricated for it. This is the
 * only place a malformed row is turned into something the wire can carry, and since
 * round 3 it is used on both the live (`fanOut`) and catch-up (`handleSince`)
 * paths — the live path used to filter the marker off entirely, which the comment
 * here once wrongly claimed it did not.
 */
function toWireEntry(entry: LedgerEntry): WireEntry {
  if (isMalformedEntry(entry)) {
    return {
      roomId: entry.roomId,
      roomSeq: entry.roomSeq,
      seq: entry.seq,
      malformed: true,
      reason: entry.reason,
    };
  }
  return toWire(entry);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
