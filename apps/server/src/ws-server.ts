import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { type WebSocket, WebSocketServer } from 'ws';
import type { CommandService } from './commands.js';
import type { EventBus } from './event-bus.js';
import { createHeadAcks } from './head-acks.js';
import { createHub, type Hub } from './hub.js';
import { CommandError, type Ledger, type LedgerEntry } from './ledger.js';
import type { Logger } from './logger.js';
import { ClientFrame, type ServerFrame, type WireEvent } from './protocol.js';
import { createReconciler, DEFAULT_RECONCILE_INTERVAL_MS, type Reconciler } from './reconciler.js';
import type { Session, SessionAuthenticator } from './session.js';

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
 * has not seen, and each fans them out to its own subscribers. Presence and
 * typing — which are not history and have no ledger to be read back from — are
 * relayed as frames on a second channel.
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
}

export interface RealtimeServer {
  httpServer: Server;
  wss: WebSocketServer;
  hub: Hub<ServerFrame>;
  connectionCount: () => number;
  /** Run one reconciliation pass now — the timer's work, on demand, for tests. */
  reconcile: () => Promise<void>;
  listen: () => Promise<void>;
  close: () => Promise<void>;
}

interface Connection {
  id: string;
  alive: boolean;
  session: Session;
}

export function createRealtimeServer(options: RealtimeOptions): RealtimeServer {
  const { logger, heartbeatIntervalMs, commands, ledger, session, bus } = options;
  const connections = new WeakMap<WebSocket, Connection>();
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
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  // `noServer` rather than `{ server }`: the upgrade has to be refused *before*
  // the handshake completes when there is no session, and that is only possible
  // if we own the upgrade event.
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const path = new URL(request.url ?? '/', 'http://placeholder').pathname;
    if (path !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    void (async () => {
      // Closed by default. An unresolved session is a refusal, never an
      // identity: the membership check downstream is only worth something if
      // the thing it checks was actually established.
      let resolved: Session | null = null;
      try {
        resolved = await session.authenticateUpgrade(request as IncomingMessage);
      } catch (error) {
        logger.error('ws upgrade auth failed', { error: (error as Error).message });
        resolved = null;
      }
      if (!resolved) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const identified = resolved;
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request, identified);
      });
    })();
  });

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
    };
    connections.set(socket, connection);
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
      hub.drop(connection.id);
      // Or the map grows one entry per connection for the life of the process.
      headAcks.forget(connection.id);
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
        hub.unsubscribe(frame.data.roomId, connection.id);
        headAcks.forgetRoom(connection.id, frame.data.roomId);
        send(socket, { type: 'unsubscribed', roomId: frame.data.roomId });
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
        entries: page.entries.map(toWire),
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
          };
          send(socket, {
            type: 'ack',
            commandId,
            roomId: result.roomId,
            seq: result.seq,
            roomSeq: result.roomSeq,
            eventId: result.event.id,
            issues: result.issues,
          });
          // Including the sender: the ack carries the position, the event
          // carries the canonical body, and a client that rendered its own
          // optimistic echo replaces it from the event like everyone else.
          hub.broadcast(result.roomId, { type: 'event', entry });
          return;
        }
        case 'presence': {
          const frame: ServerFrame = {
            type: 'presence',
            roomId: result.roomId,
            userId: result.userId,
            state: result.state,
            at: result.at,
          };
          hub.broadcast(result.roomId, frame);
          // Relayed, not evented. Presence is still never written to the
          // ledger (#14, asserted by a flood test) — the bus carries the frame
          // itself, because there is nothing durable to read it back from.
          bus?.relay(result.roomId, frame);
          ackEphemeral(socket, commandId, result.roomId);
          return;
        }
        case 'typing': {
          const frame: ServerFrame = {
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
      hub.broadcast(entry.roomId, {
        type: 'event',
        entry: {
          roomId: entry.roomId,
          roomSeq: entry.roomSeq,
          seq: entry.seq,
          actor: entry.actor,
          event: entry.event,
        },
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
    listen: async () => {
      // Before the port opens, so no client can connect into a window where
      // this instance is serving but deaf to its peers.
      await bus?.start({
        onLedger: () => {
          void reconciler?.reconcile();
        },
        onEphemeral: (note) => {
          hub.broadcast(note.roomId, note.frame as ServerFrame);
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
      reconciler?.stop();
      await bus?.close();
      for (const socket of wss.clients) socket.close(1001, 'server shutting down');
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      logger.info('realtime server closed');
    },
  };
}

function toWire(entry: LedgerEntry): WireEvent {
  return {
    roomId: entry.roomId,
    roomSeq: entry.roomSeq,
    seq: entry.seq,
    actor: entry.actor,
    event: entry.event,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
