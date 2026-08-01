import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { type AtriumSession, authorize, type MembershipLike } from '@atrium/auth';
import { type WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type { Logger } from './logger.js';
import type { AuthenticateUpgrade } from './ws-auth.js';

/**
 * Realtime transport. Ordinary WebSockets, server-authoritative state — no
 * CRDT, no custom sync protocol (init.md, "Realtime transport").
 *
 * What is here now is the transport skeleton plus its trust boundary:
 * connection lifecycle, a heartbeat that reaps dead sockets, an authenticated
 * upgrade, a command path that runs every frame through `authorize`, and a
 * presence roster so two people in a room can see each other. The real
 * command/event contract (#22) slots into `handleCommand` without any of the
 * authentication or authorization below changing.
 */

/** Client → server. */
export const ClientFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), clientId: z.string().min(1).optional() }),
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('echo'), payload: z.unknown() }),
  z.object({
    type: z.literal('command'),
    /** Free text on purpose: `authorize` is what decides it is a real command. */
    command: z.string().min(1),
    roomId: z.uuid(),
    /** Echoed back on the reply so a client can match request to response. */
    requestId: z.string().min(1).optional(),
  }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

export interface PresenceMember {
  userId: string;
  displayName: string;
}

/** Server → client. */
export type ServerFrame =
  | {
      type: 'welcome';
      connectionId: string;
      heartbeatIntervalMs: number;
      user: { id: string; displayName: string };
    }
  | { type: 'pong'; at: string }
  | { type: 'echo'; payload: unknown }
  | { type: 'joined'; roomId: string; requestId?: string }
  | { type: 'left'; roomId: string; requestId?: string }
  | { type: 'presence'; roomId: string; members: PresenceMember[] }
  | {
      type: 'command_error';
      command: string;
      roomId: string;
      requestId?: string;
      reason: string;
      message: string;
    }
  | { type: 'error'; message: string };

/** Looks up the caller's membership of a room. Null means "not a member". */
export type LoadRoomMembership = (roomId: string, userId: string) => Promise<MembershipLike | null>;

export interface RealtimeOptions {
  host: string;
  port: number;
  heartbeatIntervalMs: number;
  logger: Logger;
  /** Reported by `GET /health`; the server is only ready once the queue is up. */
  isReady: () => boolean;
  /** The single seam that decides whether a socket may exist (ws-auth.ts). */
  authenticateUpgrade: AuthenticateUpgrade;
  loadRoomMembership: LoadRoomMembership;
}

export interface RealtimeServer {
  httpServer: Server;
  wss: WebSocketServer;
  connectionCount: () => number;
  /** Distinct people currently joined to a room. Exposed for tests and health. */
  presence: (roomId: string) => PresenceMember[];
  listen: () => Promise<void>;
  close: () => Promise<void>;
}

interface Connection {
  id: string;
  alive: boolean;
  session: AtriumSession;
  rooms: Set<string>;
}

export function createRealtimeServer(options: RealtimeOptions): RealtimeServer {
  const { logger, heartbeatIntervalMs, authenticateUpgrade, loadRoomMembership } = options;
  const connections = new Map<WebSocket, Connection>();
  /** roomId → the sockets currently joined to it. */
  const roster = new Map<string, Set<WebSocket>>();

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

  // `noServer` rather than `{ server }`: the handshake must not complete until
  // the session has been validated, and only manual upgrade handling can refuse
  // it with a real HTTP status instead of closing an already-open socket.
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    void handleUpgrade(request, socket, head);
  });

  async function handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path !== '/ws') {
      reject(socket, 404, 'Not Found');
      return;
    }

    const session = await authenticateUpgrade(request);
    if (!session) {
      logger.warn('ws upgrade rejected', { remote: request.socket.remoteAddress });
      reject(socket, 401, 'Unauthorized');
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, session);
    });
  }

  function reject(socket: Duplex, status: number, reason: string): void {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  const send = (socket: WebSocket, frame: ServerFrame) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  };

  wss.on('connection', (socket: WebSocket, request: IncomingMessage, session: AtriumSession) => {
    const connection: Connection = {
      id: randomUUID(),
      alive: true,
      session,
      rooms: new Set(),
    };
    connections.set(socket, connection);
    logger.info('ws connected', {
      connectionId: connection.id,
      userId: session.userId,
      remote: request.socket.remoteAddress,
      total: wss.clients.size,
    });

    send(socket, {
      type: 'welcome',
      connectionId: connection.id,
      heartbeatIntervalMs,
      user: { id: session.userId, displayName: session.displayName },
    });

    socket.on('pong', () => {
      const state = connections.get(socket);
      if (state) state.alive = true;
    });

    socket.on('message', (raw) => {
      void handleFrame(socket, raw.toString());
    });

    socket.on('close', (code) => {
      const left = leaveAllRooms(socket);
      connections.delete(socket);
      logger.info('ws disconnected', { connectionId: connection.id, code });
      for (const roomId of left) broadcastPresence(roomId);
    });

    socket.on('error', (error: Error) => {
      logger.error('ws socket error', { connectionId: connection.id, error: error.message });
    });
  });

  async function handleFrame(socket: WebSocket, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      send(socket, { type: 'error', message: 'frame is not valid JSON' });
      return;
    }

    const frame = ClientFrame.safeParse(parsed);
    if (!frame.success) {
      send(socket, { type: 'error', message: 'unknown frame type' });
      return;
    }

    const connection = connections.get(socket);
    if (!connection) {
      send(socket, { type: 'error', message: 'connection is not registered' });
      return;
    }

    switch (frame.data.type) {
      case 'hello':
        send(socket, {
          type: 'welcome',
          connectionId: connection.id,
          heartbeatIntervalMs,
          user: {
            id: connection.session.userId,
            displayName: connection.session.displayName,
          },
        });
        return;
      case 'ping':
        send(socket, { type: 'pong', at: new Date().toISOString() });
        return;
      case 'echo':
        send(socket, { type: 'echo', payload: frame.data.payload });
        return;
      case 'command':
        await handleCommand(socket, connection, frame.data);
        return;
      default: {
        const exhaustive: never = frame.data;
        logger.warn('unhandled frame', { frame: exhaustive });
      }
    }
  }

  async function handleCommand(
    socket: WebSocket,
    connection: Connection,
    frame: Extract<ClientFrame, { type: 'command' }>,
  ): Promise<void> {
    const { command, roomId, requestId } = frame;

    let membership: MembershipLike | null;
    try {
      membership = await loadRoomMembership(roomId, connection.session.userId);
    } catch (error) {
      logger.error('membership lookup failed', {
        connectionId: connection.id,
        command,
        roomId,
        error: (error as Error).message,
      });
      // Failing to *learn* whether someone is a member is not permission to act.
      // It is also not a denial: telling the caller "you are not a member" when
      // the truth is "the database did not answer" sends them to argue with an
      // admin about permissions they already have.
      send(socket, {
        type: 'command_error',
        command,
        roomId,
        ...(requestId ? { requestId } : {}),
        reason: 'unavailable',
        message: 'could not check your membership just now — try again',
      });
      return;
    }

    // `scope: 'room'` is what stops a workspace-level command being waved
    // through on the strength of a room membership.
    const decision = authorize(command, membership, { scope: 'room' });
    if (!decision.allowed) {
      logger.warn('command denied', {
        connectionId: connection.id,
        userId: connection.session.userId,
        command,
        roomId,
        reason: decision.reason,
      });
      send(socket, {
        type: 'command_error',
        command,
        roomId,
        ...(requestId ? { requestId } : {}),
        reason: decision.reason,
        message: decision.message,
      });
      return;
    }

    switch (decision.command) {
      case 'room.join': {
        joinRoom(socket, connection, roomId);
        send(socket, { type: 'joined', roomId, ...(requestId ? { requestId } : {}) });
        broadcastPresence(roomId);
        return;
      }
      case 'room.leave': {
        leaveRoom(socket, connection, roomId);
        send(socket, { type: 'left', roomId, ...(requestId ? { requestId } : {}) });
        broadcastPresence(roomId);
        return;
      }
      case 'room.presence': {
        send(socket, { type: 'presence', roomId, members: presence(roomId) });
        return;
      }
      default: {
        // Authorized, but its handler lands with #22. Say so rather than
        // pretending the command succeeded.
        send(socket, {
          type: 'command_error',
          command,
          roomId,
          ...(requestId ? { requestId } : {}),
          reason: 'not_implemented',
          message: `"${command}" is authorized but has no handler yet`,
        });
      }
    }
  }

  function joinRoom(socket: WebSocket, connection: Connection, roomId: string): void {
    const sockets = roster.get(roomId) ?? new Set<WebSocket>();
    sockets.add(socket);
    roster.set(roomId, sockets);
    connection.rooms.add(roomId);
  }

  function leaveRoom(socket: WebSocket, connection: Connection, roomId: string): void {
    const sockets = roster.get(roomId);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) roster.delete(roomId);
    }
    connection.rooms.delete(roomId);
  }

  function leaveAllRooms(socket: WebSocket): string[] {
    const connection = connections.get(socket);
    if (!connection) return [];
    const left = [...connection.rooms];
    for (const roomId of left) leaveRoom(socket, connection, roomId);
    return left;
  }

  /** One entry per person, not per socket: two tabs is still one human present. */
  function presence(roomId: string): PresenceMember[] {
    const sockets = roster.get(roomId);
    if (!sockets) return [];
    const byUser = new Map<string, PresenceMember>();
    for (const socket of sockets) {
      const connection = connections.get(socket);
      if (!connection) continue;
      byUser.set(connection.session.userId, {
        userId: connection.session.userId,
        displayName: connection.session.displayName,
      });
    }
    return [...byUser.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  function broadcastPresence(roomId: string): void {
    const members = presence(roomId);
    const sockets = roster.get(roomId);
    if (!sockets) return;
    for (const socket of sockets) send(socket, { type: 'presence', roomId, members });
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
    connectionCount: () => wss.clients.size,
    presence,
    listen: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(options.port, options.host, () => {
          httpServer.removeListener('error', reject);
          logger.info('realtime server listening', {
            url: `ws://${options.host}:${options.port}/ws`,
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
