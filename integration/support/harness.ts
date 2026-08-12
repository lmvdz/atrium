import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
// `workspaceMembers` lives in `@atrium/db`'s auth-schema module, which the
// `/schema` subpath does not re-export; the package root does.
import { createDatabase, type DatabaseHandle, workspaceMembers } from '@atrium/db';
import { memberships, rooms, users, workspaces } from '@atrium/db/schema';
import { sql } from 'drizzle-orm';
import { WebSocket } from 'ws';
import type { AttachmentSigner } from '../../apps/server/src/attachments.js';
import { type CommandInput, createCommandService } from '../../apps/server/src/commands.js';
import { createEventBus, type EventBus } from '../../apps/server/src/event-bus.js';
import { createLedger, type Ledger } from '../../apps/server/src/ledger.js';
import { createLogger } from '../../apps/server/src/logger.js';
import type { ClientFrameInput, ServerFrame } from '../../apps/server/src/protocol.js';
import {
  createMembershipAuthorizer,
  createStubSessionAuthenticator,
  type SessionAuthenticator,
} from '../../apps/server/src/session.js';
import { createRealtimeServer, type RealtimeServer } from '../../apps/server/src/ws-server.js';
import type { SocketLike } from '../../apps/web/src/lib/realtime.js';
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
  'message_references',
  'attachments',
  'corrections',
  'object_sources',
  'proposal_sources',
  'relations',
  'attention_items',
  'accepted_objects',
  'proposals',
  'interpretations',
  'sessions',
  'plans',
  'agents',
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
  await resetQueue(handle);
}

/**
 * Empty pg-boss's job table, if pg-boss has ever run against this database.
 *
 * `pgboss` is a schema drizzle does not own and `APP_TABLES` therefore does not
 * name, which meant a test that enqueued an interpretation left its jobs behind
 * — and with `fileParallelism: false` the very next file inherits them. A
 * worker suite is the first thing here to enqueue anything, so this is the
 * first time it mattered; it lives in the shared reset rather than in that
 * suite because the leak is not that suite's property, it is the reset's gap.
 *
 * Guarded on the schema existing: most files never start a queue, and a reset
 * that fails because pg-boss has not been installed yet would take every one of
 * them down.
 */
export async function resetQueue(handle: DatabaseHandle): Promise<void> {
  await handle.db.execute(sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema = 'pgboss' AND table_name = 'job') THEN
        TRUNCATE pgboss.job CASCADE;
      END IF;
    END
    $$;
  `);
}

export interface SeededRoom {
  roomId: string;
  /** The workspace the room belongs to — `rooms.workspace_id` is NOT NULL. */
  workspaceId: string;
  /** userId per label, e.g. `people.alice`. */
  people: Record<string, string>;
}

/**
 * A room with members. Ids are uuids because the schema's columns are.
 *
 * `options.agents` names the members that are provisioned as **agent**
 * principals rather than people. They are otherwise seeded identically —
 * same `users` row, same `workspace_members` row, same `memberships` row — which
 * is the claim drizzle/0017 makes and the reason the parameter is a list of
 * names rather than a separate function: an agent that needed its own seeding
 * path would be evidence that it is not the same sort of member after all.
 *
 * Every name in `agents` must also be in `people`, so the roster stays one list
 * and a typo cannot silently seed a person the caller meant to be a machine.
 */
export async function seedRoom(
  handle: DatabaseHandle,
  people: readonly string[],
  options: { slug?: string; agents?: readonly string[] } = {},
): Promise<SeededRoom> {
  const roomId = randomUUID();
  const ids: Record<string, string> = {};
  const agents = new Set(options.agents ?? []);
  for (const name of agents) {
    if (!people.includes(name)) {
      throw new Error(`seedRoom: "${name}" is named as an agent but is not in the roster`);
    }
  }

  for (const name of people) {
    const id = randomUUID();
    ids[name] = id;
    await handle.db.insert(users).values({
      id,
      email: `${name}-${id}@example.test`,
      displayName: name,
      principalKind: agents.has(name) ? 'agent' : 'human',
    });
  }
  /* A ROOM NOW LIVES IN A WORKSPACE, AND A MEMBERSHIP IS NOW DERIVED FROM ONE.
     Two changes the auth lane (#26) made that this fixture has to reflect:
     `rooms.workspace_id` is NOT NULL, and every authorization read joins
     `workspace_members` so that a `memberships` row whose workspace member row
     is gone grants nothing. Seeding only `memberships` would have produced a
     harness where every authorization check answers "not a member" — the tests
     would fail loudly, which is the good outcome, but the fixture would be
     asserting against a database shape production does not have. */
  const workspaceId = randomUUID();
  await handle.db.insert(workspaces).values({
    id: workspaceId,
    name: 'test workspace',
    slug: `ws-${workspaceId.slice(0, 8)}`,
  });
  await handle.db.insert(rooms).values({
    id: roomId,
    workspaceId,
    slug: options.slug ?? `room-${roomId.slice(0, 8)}`,
    name: options.slug ?? 'test room',
  });
  for (const name of people) {
    await handle.db.insert(workspaceMembers).values({
      organizationId: workspaceId,
      userId: ids[name] as string,
      role: 'member',
    });
    await handle.db.insert(memberships).values({
      roomId,
      userId: ids[name] as string,
      role: 'member',
    });
  }
  return { roomId, workspaceId, people: ids };
}

export interface TestServer {
  realtime: RealtimeServer;
  ledger: Ledger;
  url: string;
  /** Present when this server was started with cross-instance fan-out. */
  bus?: EventBus;
  close: () => Promise<void>;
}

export interface TestServerOptions {
  /**
   * Wire the Postgres LISTEN/NOTIFY bus, as `index.ts` always does.
   *
   * Off by default so the tests that are about one instance stay about one
   * instance. `startSecondInstance` turns it on for both, which is the only way
   * to ask the question it exists to ask.
   *
   * Note what this no longer switches off: **delivery**. The reconciler runs
   * either way, because a durable path that a flag can remove is the r2-delta
   * blocking finding with a flag in front of it. Without the bus an instance
   * simply learns about a peer commit on the next reconcile rather than
   * immediately.
   */
  bus?: boolean;
  /** Names the instance in logs and in the notification origin filter. */
  instanceId?: string;
  /** Shorten the reconciliation timer so a test does not wait on wall clock. */
  reconcileIntervalMs?: number;
  /**
   * Shorten the fan-out membership re-check (#22 r9, D2).
   *
   * Defaulted long here rather than short, and deliberately: a test that wants
   * the revocation window measured drives `realtime.revalidateSubscriptions()`
   * directly, so what it asserts is the *rule*. Leaving the timer at a hundred
   * milliseconds for every other test would let a pass fire in the middle of an
   * unrelated assertion and make the suite depend on wall clock.
   */
  membershipRevalidateIntervalMs?: number;
  attachmentCapabilities?: Pick<AttachmentSigner, 'verify'>;
  /**
   * The identity seam, when a suite needs the real one.
   *
   * Defaults to `createStubSessionAuthenticator()`, which is what every suite
   * about the ledger, the protocol or the fan-out wants: those questions are not
   * about who is connected, and making each of them mint a Better Auth session
   * would be a slower test of the same thing.
   *
   * `integration/server/agent-principal.test.ts` passes the real
   * `createUpgradeAuthenticator`, because its question IS who is connected —
   * specifically whether the principal kind on the identity survives the trip
   * through Better Auth into the actor the ledger writes. A stub that was told
   * the answer could not ask that.
   */
  session?: SessionAuthenticator;
}

/** A realtime server on an ephemeral port, wired exactly as `index.ts` wires it. */
export async function startTestServer(
  handle: DatabaseHandle,
  options: TestServerOptions = {},
): Promise<TestServer> {
  const logger = createLogger('error');
  const bus = options.bus
    ? createEventBus({ sql: handle.sql, logger, instanceId: options.instanceId })
    : undefined;
  // The instance id goes to the ledger, which passes it to the append function
  // as the notification origin — the doorbell is rung by the database now.
  const ledger = createLedger({ db: handle.db, logger, instanceId: bus?.instanceId });
  await ledger.hydrate();
  const commands = createCommandService({
    db: handle.db,
    ledger,
    authorizer: createMembershipAuthorizer(handle.db),
    attachmentCapabilities: options.attachmentCapabilities,
  });
  const realtime = createRealtimeServer({
    host: '127.0.0.1',
    port: 0,
    heartbeatIntervalMs: 30_000,
    logger,
    isReady: () => true,
    commands,
    ledger,
    bus,
    reconcileIntervalMs: options.reconcileIntervalMs ?? 200,
    membershipRevalidateIntervalMs: options.membershipRevalidateIntervalMs ?? 60_000,
    session: options.session ?? createStubSessionAuthenticator(),
    // ORIGIN POLICY, STATED. The merged server requires it (the auth lane's
    // rule: originless must be opt-in, because an attacker who simply omits the
    // header would otherwise face no check). These are node `ws` clients with no
    // browser and no Origin header, so the exemption is declared here in one
    // visible line rather than inherited from a default that would have to be
    // fail-open to be useful.
    allowedOrigins: [],
    allowOriginless: true,
  });
  await realtime.listen();
  const address = realtime.httpServer.address() as AddressInfo;
  return {
    realtime,
    ledger,
    bus,
    url: `ws://127.0.0.1:${address.port}/ws`,
    close: () => realtime.close(),
  };
}

/**
 * A second server process, in the way that matters: its own connection pool,
 * its own in-memory `CoreState`, its own hub, its own listener.
 *
 * Sharing one `DatabaseHandle` would be the tempting shortcut and would prove
 * nothing — the point of the question is that instance B's commits reach
 * instance A's subscribers *through the database*, and a shared pool is not
 * that. Each instance gets a real handle, which the caller must close.
 */
export async function startSecondInstance(
  options: { url?: string; instanceId?: string; reconcileIntervalMs?: number } = {},
): Promise<{ handle: DatabaseHandle; server: TestServer; close: () => Promise<void> }> {
  const handle = createDatabase({ url: options.url ?? databaseUrl(), max: 10 });
  const server = await startTestServer(handle, {
    bus: true,
    instanceId: options.instanceId ?? `instance-${randomUUID()}`,
    reconcileIntervalMs: options.reconcileIntervalMs,
  });
  return {
    handle,
    server,
    close: async () => {
      await server.close();
      await handle.close();
    },
  };
}

/**
 * The production client (`apps/web/src/lib/realtime.ts`), over a real socket.
 *
 * This is the thing r1's acceptance test did not do. It drove the *harness*
 * through a reconnect — subscribe, kill, reconnect, one `since`, stitch the two
 * halves together in the test — and so it could not exercise the interleaving
 * of live delivery and catch-up that the recovery path actually consists of.
 * Whatever the test stitched together was right by construction; the client
 * was never asked.
 *
 * The adapter below is the whole bridge: `ws` speaks events, the client expects
 * `onopen`/`onmessage`/`onclose` handles. Nothing about the client's behaviour
 * is mocked, stubbed or reimplemented here.
 */
export function nodeSocketFactory(options: {
  /** Authenticated identity consumed only by the integration stub upgrader. */
  userId: string;
  onSocket?: (socket: WebSocket) => void;
  /**
   * Lose a frame on the way in, as a wire does.
   *
   * The socket stays open, the server believes it sent, and the client never
   * hears — which is the failure the `head` frame exists for and the one
   * #22's r3 delta found unpinned:
   *
   * > The pin is theatre (`reconcile.test.ts:280–308` waits for a head after
   * > subscribe and never drops an event frame); r4's test must drop an event
   * > frame after a successful fan-out and assert convergence.
   *
   * Dropped at the client's edge rather than by instrumenting the server,
   * because the server must be the one that shipped: a test that stopped the
   * broadcast would be testing a delivery that never happened, and the whole
   * point is that it did.
   */
  dropFrame?: (frame: ServerFrame) => boolean;
}) {
  return (url: string): SocketLike => {
    // CATCHES: removing the authenticated test upgrade credential after the
    // production client stopped putting identity in its URL. Query identity is
    // not restored; this header belongs solely to createStubSessionAuthenticator.
    const socket = new WebSocket(url, { headers: { 'x-atrium-user': options.userId } });
    const adapter: SocketLike = {
      get readyState() {
        return socket.readyState;
      },
      send: (data: string) => socket.send(data),
      close: (code?: number, reason?: string) => socket.close(code, reason),
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
    };
    socket.on('open', () => adapter.onopen?.({}));
    socket.on('message', (raw) => {
      const data = raw.toString();
      if (options.dropFrame?.(JSON.parse(data) as ServerFrame)) return;
      adapter.onmessage?.({ data });
    });
    socket.on('close', (code) => adapter.onclose?.({ code }));
    // Swallowed rather than thrown: a `terminate()`d socket emits ECONNRESET on
    // some platforms and nothing on others, and an unhandled 'error' on a `ws`
    // socket takes the whole process down.
    socket.on('error', () => adapter.onerror?.({}));
    options.onSocket?.(socket);
    return adapter;
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
  /** The identity this socket connected as — the stub authenticator's `?user=`. */
  userId = '';
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

  /**
   * Open a socket as `userId`.
   *
   * `options.headers` is how a caller presents a credential this harness does not
   * mint — a real Better Auth session cookie, for the suites that wire the real
   * upgrade authenticator instead of the stub. It is merged UNDER the stub's own
   * header rather than over it, so a caller cannot half-replace the identity and
   * end up with a socket whose two credentials name different people.
   *
   * `options.principalKind` is the stub's principal claim. Absent means the stub
   * defaults to `human`, which is what almost every suite here wants; a suite
   * that means "agent" has to say so, because a silent default in this position
   * is how a test that thinks it is exercising the agent path exercises the
   * person path instead.
   */
  static async connect(
    url: string,
    userId: string,
    options: { headers?: Record<string, string>; principalKind?: 'human' | 'agent' } = {},
  ): Promise<TestClient> {
    const socket = new WebSocket(url, {
      headers: {
        ...options.headers,
        'x-atrium-user': userId,
        ...(options.principalKind ? { 'x-atrium-principal': options.principalKind } : {}),
      },
    });
    const client = new TestClient(socket);
    client.userId = userId;
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    await client.waitFor((f) => f.type === 'welcome');
    return client;
  }

  send(frame: ClientFrameInput): void {
    this.socket.send(JSON.stringify(frame));
  }

  /**
   * Wait for a frame.
   *
   * `fromIndex` is not a convenience: without it, a second request with the
   * same parameters matches the *first* request's reply, still sitting in the
   * log. A test that asks for the same gap twice would then assert twice about
   * one answer and never see the second — which is exactly the shape of test
   * that reports green through a regression.
   */
  waitFor(
    match: (frame: ServerFrame) => boolean,
    timeoutMs = 15_000,
    fromIndex = 0,
  ): Promise<ServerFrame> {
    const seen = this.frames.slice(fromIndex).find(match);
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
  async command(command: CommandInput): Promise<Extract<ServerFrame, { type: 'ack' | 'nack' }>> {
    this.nextCommandId += 1;
    const commandId = `c${this.nextCommandId}`;
    this.send({ type: 'command', commandId, command });
    return (await this.waitFor(
      (f) => (f.type === 'ack' || f.type === 'nack') && f.commandId === commandId,
    )) as Extract<ServerFrame, { type: 'ack' | 'nack' }>;
  }

  /** Fire a command without waiting — for the concurrency tests. */
  fire(command: CommandInput): Promise<Extract<ServerFrame, { type: 'ack' | 'nack' }>> {
    return this.command(command);
  }

  /** Ask for a gap, and wait for the reply *this* call produced. */
  async since(
    roomId: string,
    roomSeq: number,
    limit?: number,
  ): Promise<Extract<ServerFrame, { type: 'catchup' }>> {
    const mark = this.frames.length;
    this.send(
      limit === undefined
        ? { type: 'since', roomId, roomSeq }
        : { type: 'since', roomId, roomSeq, limit },
    );
    return (await this.waitFor(
      (f) => f.type === 'catchup' && f.roomId === roomId && f.from === roomSeq,
      15_000,
      mark,
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
