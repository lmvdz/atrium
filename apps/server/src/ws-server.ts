import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { type WebSocket, WebSocketServer } from 'ws';
import type { CommandService } from './commands.js';
import { createHub, type Hub } from './hub.js';
import { CommandError, type Ledger } from './ledger.js';
import type { Logger } from './logger.js';
import { ClientFrame, type ServerFrame, type WireEvent } from './protocol.js';
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
 * re-read per command, because a socket outlives a membership and "you were a
 * member when you connected" is not an answer to "may you write this now".
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
  session?: SessionAuthenticator;
}

export interface RealtimeServer {
  httpServer: Server;
  wss: WebSocketServer;
  hub: Hub<ServerFrame>;
  connectionCount: () => number;
  listen: () => Promise<void>;
  close: () => Promise<void>;
}

interface Connection {
  id: string;
  alive: boolean;
  session: Session;
}

export function createRealtimeServer(options: RealtimeOptions): RealtimeServer {
  const { logger, heartbeatIntervalMs, commands, ledger, session } = options;
  const connections = new WeakMap<WebSocket, Connection>();
  const hub = createHub<ServerFrame>();

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
      let resolved: Session | null = { userId: 'anonymous', method: 'none' };
      if (session) {
        try {
          resolved = await session.authenticateUpgrade(request as IncomingMessage);
        } catch (error) {
          logger.error('ws upgrade auth failed', { error: (error as Error).message });
          resolved = null;
        }
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
    const connection: Connection = {
      id: randomUUID(),
      alive: true,
      session: resolved ?? { userId: 'anonymous', method: 'none' },
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
        send(socket, { type: 'unsubscribed', roomId: frame.data.roomId });
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
      const entries = await ledger.since(request.roomId, request.roomSeq, limit);
      const head = await ledger.head(request.roomId);
      const last = entries.at(-1);
      send(socket, {
        type: 'catchup',
        roomId: request.roomId,
        from: request.roomSeq,
        to: last ? last.roomSeq : request.roomSeq,
        head,
        // Truncation must be visible. A client that reads `entries.length <
        // limit` to decide it is caught up gets it wrong exactly when the gap
        // is large, which is exactly when it matters.
        more: entries.length === limit && (last?.roomSeq ?? 0) < head,
        entries: entries.map(toWire),
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
        case 'presence':
          hub.broadcast(result.roomId, {
            type: 'presence',
            roomId: result.roomId,
            userId: result.userId,
            state: result.state,
            at: result.at,
          });
          ackEphemeral(socket, commandId, result.roomId);
          return;
        case 'typing':
          hub.broadcastExcept(result.roomId, connection.id, {
            type: 'typing',
            roomId: result.roomId,
            userId: result.userId,
            typing: result.typing,
            at: result.at,
          });
          ackEphemeral(socket, commandId, result.roomId);
          return;
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
    listen: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(options.port, options.host, () => {
          httpServer.removeListener('error', reject);
          const address = httpServer.address();
          logger.info('realtime server listening', {
            url: `ws://${options.host}:${typeof address === 'object' && address ? address.port : options.port}/ws`,
          });
          resolve();
        });
      }),
    close: async () => {
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.close(1001, 'server shutting down');
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      logger.info('realtime server closed');
    },
  };
}

function toWire(entry: {
  roomId: string;
  roomSeq: number;
  seq: number;
  event: unknown;
}): WireEvent {
  return {
    roomId: entry.roomId,
    roomSeq: entry.roomSeq,
    seq: entry.seq,
    event: entry.event as WireEvent['event'],
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
