import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createDatabase, type DatabaseHandle } from '@atrium/db';
import { memberships, rooms, users } from '@atrium/db/schema';
import { sql } from 'drizzle-orm';
import { WebSocket } from 'ws';
import { type Command, createCommandService } from '../../apps/server/src/commands.js';
import { createLedger, type Ledger } from '../../apps/server/src/ledger.js';
import { createLogger } from '../../apps/server/src/logger.js';
import type { ClientFrame, ServerFrame } from '../../apps/server/src/protocol.js';
import {
  createMembershipAuthorizer,
  createStubSessionAuthenticator,
} from '../../apps/server/src/session.js';
import { createRealtimeServer, type RealtimeServer } from '../../apps/server/src/ws-server.js';
import { databaseUrl } from './env.js';

/**
 * One real server, one real Postgres, real sockets.
 *
 * Nothing here is a double. The point of #22's acceptance test is that a
 * client which loses its socket mid-burst recovers a byte-identical history,
 * and that claim is only worth anything against the transport, the transaction
 * and the constraints that actually ship.
 */

/** Every table the app owns, in an order TRUNCATE ... CASCADE makes irrelevant. */
const APP_TABLES = [
  'core_events',
  'corrections',
  'object_sources',
  'proposal_sources',
  'relations',
  'attention_items',
  'accepted_objects',
  'proposals',
  'interpretations',
  'messages',
  'memberships',
  'rooms',
  'users',
] as const;

export function openDatabase(max = 20): DatabaseHandle {
  return createDatabase({ url: databaseUrl(), max });
}

/**
 * Empty every app table and restart the sequences.
 *
 * RESTART IDENTITY matters more than it looks: `core_events.seq` is the global
 * order, and a test that asserts "the first event is seq 1" should be asserting
 * something about the ledger, not about how many tests ran before it.
 */
export async function resetDatabase(handle: DatabaseHandle): Promise<void> {
  await handle.db.execute(
    sql.raw(`TRUNCATE ${APP_TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`),
  );
}

export interface SeededRoom {
  roomId: string;
  /** userId per label, e.g. `people.alice`. */
  people: Record<string, string>;
}

/** A room with members. Ids are uuids because the schema's columns are. */
export async function seedRoom(
  handle: DatabaseHandle,
  people: readonly string[],
  options: { slug?: string } = {},
): Promise<SeededRoom> {
  const roomId = randomUUID();
  const ids: Record<string, string> = {};

  for (const name of people) {
    const id = randomUUID();
    ids[name] = id;
    await handle.db
      .insert(users)
      .values({ id, email: `${name}-${id}@example.test`, displayName: name });
  }
  await handle.db.insert(rooms).values({
    id: roomId,
    slug: options.slug ?? `room-${roomId.slice(0, 8)}`,
    name: options.slug ?? 'test room',
  });
  for (const name of people) {
    await handle.db.insert(memberships).values({
      roomId,
      userId: ids[name] as string,
      role: 'member',
    });
  }
  return { roomId, people: ids };
}

export interface TestServer {
  realtime: RealtimeServer;
  ledger: Ledger;
  url: string;
  close: () => Promise<void>;
}

/** A realtime server on an ephemeral port, wired exactly as `index.ts` wires it. */
export async function startTestServer(handle: DatabaseHandle): Promise<TestServer> {
  const logger = createLogger('error');
  const ledger = createLedger({ db: handle.db, logger });
  await ledger.hydrate();
  const commands = createCommandService({
    db: handle.db,
    ledger,
    authorizer: createMembershipAuthorizer(handle.db),
  });
  const realtime = createRealtimeServer({
    host: '127.0.0.1',
    port: 0,
    heartbeatIntervalMs: 30_000,
    logger,
    isReady: () => true,
    commands,
    ledger,
    session: createStubSessionAuthenticator(),
  });
  await realtime.listen();
  const address = realtime.httpServer.address() as AddressInfo;
  return {
    realtime,
    ledger,
    url: `ws://127.0.0.1:${address.port}/ws`,
    close: () => realtime.close(),
  };
}

/**
 * A client socket that remembers everything it was told.
 *
 * Frames are kept in arrival order and never filtered on the way in, because
 * the acceptance test's whole question is "did this client end up with the same
 * history as that one" — a helper that quietly dropped frames it thought were
 * uninteresting would be answering a different question.
 */
export class TestClient {
  readonly frames: ServerFrame[] = [];
  private socket: WebSocket;
  private nextCommandId = 0;
  private waiters: Array<{
    match: (f: ServerFrame) => boolean;
    resolve: (f: ServerFrame) => void;
  }> = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as ServerFrame;
      this.frames.push(frame);
      for (const waiter of [...this.waiters]) {
        if (waiter.match(frame)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(frame);
        }
      }
    });
  }

  static async connect(url: string, userId: string): Promise<TestClient> {
    const socket = new WebSocket(url, { headers: { 'x-atrium-user': userId } });
    const client = new TestClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    await client.waitFor((f) => f.type === 'welcome');
    return client;
  }

  send(frame: ClientFrame): void {
    this.socket.send(JSON.stringify(frame));
  }

  waitFor(match: (frame: ServerFrame) => boolean, timeoutMs = 15_000): Promise<ServerFrame> {
    const seen = this.frames.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `timed out waiting for a frame; saw: ${this.frames.map((f) => f.type).join(', ')}`,
          ),
        );
      }, timeoutMs);
      this.waiters.push({
        match,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  }

  async subscribe(roomId: string): Promise<Extract<ServerFrame, { type: 'subscribed' }>> {
    this.send({ type: 'subscribe', roomId });
    return (await this.waitFor((f) => f.type === 'subscribed' && f.roomId === roomId)) as Extract<
      ServerFrame,
      { type: 'subscribed' }
    >;
  }

  /** Send a command and wait for its ack or nack. */
  async command(command: Command): Promise<Extract<ServerFrame, { type: 'ack' | 'nack' }>> {
    this.nextCommandId += 1;
    const commandId = `c${this.nextCommandId}`;
    this.send({ type: 'command', commandId, command });
    return (await this.waitFor(
      (f) => (f.type === 'ack' || f.type === 'nack') && f.commandId === commandId,
    )) as Extract<ServerFrame, { type: 'ack' | 'nack' }>;
  }

  /** Fire a command without waiting — for the concurrency tests. */
  fire(command: Command): Promise<Extract<ServerFrame, { type: 'ack' | 'nack' }>> {
    return this.command(command);
  }

  async since(roomId: string, roomSeq: number): Promise<Extract<ServerFrame, { type: 'catchup' }>> {
    this.send({ type: 'since', roomId, roomSeq });
    return (await this.waitFor(
      (f) => f.type === 'catchup' && f.roomId === roomId && f.from === roomSeq,
    )) as Extract<ServerFrame, { type: 'catchup' }>;
  }

  /** Every `event` frame this client received, in arrival order. */
  events(roomId?: string) {
    return this.frames.flatMap((frame) =>
      frame.type === 'event' && (!roomId || frame.entry.roomId === roomId) ? [frame.entry] : [],
    );
  }

  /** Kill the socket the way a lost network does: no close frame, no goodbye. */
  kill(): void {
    this.socket.terminate();
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.socket.once('close', () => resolve());
      this.socket.close();
    });
  }
}

/** Poll until `check` passes, or throw. For "nothing else arrived" assertions. */
export async function until(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
