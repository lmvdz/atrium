import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { type WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type { Logger } from './logger.js';

/**
 * Realtime transport. Ordinary WebSockets, server-authoritative state — no
 * CRDT, no custom sync protocol (init.md, "Realtime transport").
 *
 * What is here now is the transport skeleton: connection lifecycle, a
 * heartbeat that reaps dead sockets, and an echo frame so the wire can be
 * exercised end-to-end. The real command/event contract ("Model events,
 * persistence, and realtime protocol") slots into `handleFrame` without any of
 * this changing.
 */

/** Client → server. */
export const ClientFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), clientId: z.string().min(1).optional() }),
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('echo'), payload: z.unknown() }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

/** Server → client. */
export type ServerFrame =
  | { type: 'welcome'; connectionId: string; heartbeatIntervalMs: number }
  | { type: 'pong'; at: string }
  | { type: 'echo'; payload: unknown }
  | { type: 'error'; message: string };

export interface RealtimeOptions {
  host: string;
  port: number;
  heartbeatIntervalMs: number;
  logger: Logger;
  /** Reported by `GET /health`; the server is only ready once the queue is up. */
  isReady: () => boolean;
}

export interface RealtimeServer {
  httpServer: Server;
  wss: WebSocketServer;
  connectionCount: () => number;
  listen: () => Promise<void>;
  close: () => Promise<void>;
}

interface Connection {
  id: string;
  alive: boolean;
}

export function createRealtimeServer(options: RealtimeOptions): RealtimeServer {
  const { logger, heartbeatIntervalMs } = options;
  const connections = new WeakMap<WebSocket, Connection>();

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

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  const send = (socket: WebSocket, frame: ServerFrame) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  };

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const connection: Connection = { id: randomUUID(), alive: true };
    connections.set(socket, connection);
    logger.info('ws connected', {
      connectionId: connection.id,
      remote: request.socket.remoteAddress,
      total: wss.clients.size,
    });

    send(socket, { type: 'welcome', connectionId: connection.id, heartbeatIntervalMs });

    socket.on('pong', () => {
      const state = connections.get(socket);
      if (state) state.alive = true;
    });

    socket.on('message', (raw) => {
      handleFrame(socket, raw.toString());
    });

    socket.on('close', (code) => {
      logger.info('ws disconnected', { connectionId: connection.id, code });
    });

    socket.on('error', (error: Error) => {
      logger.error('ws socket error', { connectionId: connection.id, error: error.message });
    });
  });

  function handleFrame(socket: WebSocket, raw: string): void {
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

    switch (frame.data.type) {
      case 'hello':
        send(socket, {
          type: 'welcome',
          connectionId: connections.get(socket)?.id ?? 'unknown',
          heartbeatIntervalMs,
        });
        return;
      case 'ping':
        send(socket, { type: 'pong', at: new Date().toISOString() });
        return;
      case 'echo':
        send(socket, { type: 'echo', payload: frame.data.payload });
        return;
      default: {
        const exhaustive: never = frame.data;
        logger.warn('unhandled frame', { frame: exhaustive });
      }
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
    connectionCount: () => wss.clients.size,
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
