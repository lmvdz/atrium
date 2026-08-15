import { randomUUID } from 'node:crypto';
import { provisionAgentConfig } from '@atrium/auth';
import type { DatabaseHandle } from '@atrium/db';
import { plans, sessions } from '@atrium/db/schema';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { createRealtimeClient, type RealtimeClient } from '../../apps/web/src/lib/realtime.js';
import {
  nodeSocketFactory,
  openDatabase,
  resetDatabase,
  type SeededRoom,
  seedRoom,
  startTestServer,
  type TestServer,
  until,
} from '../support/harness.js';

/**
 * #159 ROUND-4, FINDING 3 (both foreign lineages, HIGH): `recoverProgress` — the
 * client method that floors a room's live progress channel by the durable
 * `sessions.progress` snapshot — existed and was unit-tested, but nothing on the
 * PRODUCTION path ever called it. Round-3's `subscribed` handler only prompted a
 * `changed(roomId, 'projection')` re-read; no code turned that into a
 * `recoverProgress` call. So a reconnect or late-join accepted any live frame
 * whose `progressSeq` sat in `(0, snapshot]` — the exact gap round-3 believed it
 * had closed.
 *
 * This test is deliberately NOT the round-3 test (`control-plane-data.test.ts`'s
 * "a reconnecting client recovers…"), which hand-calls `client.recoverProgress(...)`
 * after a hand-built `subscribed` frame — proving the mechanism works, never that
 * production wires it. Here the server is REAL (`startTestServer`), the socket is
 * REAL (`nodeSocketFactory`, real `ws`), the subscribe is the client's own
 * `join()` → `subscribe` frame, and the floor is asserted to have appeared with
 * NO call to `recoverProgress` anywhere in this file. It fails on the code before
 * the fix (the `subscribed` frame carried no snapshot and `handleFrame` never
 * called `recoverProgress`) and passes once `ws-server.ts`'s `handleSubscribe`
 * reads `commands.progressSnapshot(roomId)` onto the frame and
 * `realtime.ts`'s `subscribed` case floors from it directly.
 */

let handle: DatabaseHandle;
let server: TestServer;
let room: SeededRoom;
const clients: RealtimeClient[] = [];

beforeEach(async () => {
  handle ??= openDatabase(20);
  await resetDatabase(handle);
  room = await seedRoom(handle, ['ada', 'hexi'], { agents: ['hexi'] });
  server = await startTestServer(handle);
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await server?.close();
});

afterAll(async () => {
  await handle?.close();
});

describe('the production (re)subscribe path floors the live progress channel (#159 round-4, finding 3)', () => {
  it('refuses a live frame at/under the recovered snapshot seq and accepts one past it, through the REAL subscribed frame', async () => {
    const ada = room.people.ada as string;
    const hexi = room.people.hexi as string;
    await provisionAgentConfig({
      db: handle.db,
      userId: hexi,
      ownerUserId: ada,
      channelRoomId: room.roomId,
      host: 'fly-ord',
      harness: 'claude-code',
      model: 'opus',
      budgetLimitMicros: 20_000_000,
    });
    const planId = randomUUID();
    await handle.db.insert(plans).values({
      id: planId,
      roomId: room.roomId,
      agentUserId: hexi,
      title: 'a plan',
      status: 'open',
    });
    // A DURABLE snapshot at seq 7, exactly as the settle-clear invariant leaves a
    // still-RUNNING session: `sessions.progress` is non-null only while `status`
    // is `open` (the CHECK from round-1 finding 5).
    const [row] = await handle.db
      .insert(sessions)
      .values({
        roomId: room.roomId,
        planId,
        harness: 'claude-code',
        model: 'opus',
        status: 'open',
        progress: {
          progressSeq: 7,
          phase: 'writing',
          spendMicros: 4200,
          contextPct: 0.5,
          updatedAt: new Date().toISOString(),
        },
      })
      .returning({ id: sessions.id });
    const sessionId = (row as { id: string }).id;

    const sockets: WebSocket[] = [];
    const client = createRealtimeClient({
      userId: ada,
      url: server.url,
      reconnect: false,
      socketFactory: nodeSocketFactory({
        userId: ada,
        onSocket: (socket) => sockets.push(socket),
      }),
    });
    clients.push(client);
    await client.connect();
    // The ONLY action this test takes to trigger recovery: subscribe, exactly as
    // the browser client does on mount and on every reconnect. Nothing here calls
    // `recoverProgress` — if the floor appears, production wired it.
    client.join(room.roomId);

    await until(
      () => client.room(room.roomId).progressFloor?.[sessionId] === 7,
      15_000,
      'the real subscribed frame to floor the session at the durable snapshot seq (7)',
    );

    // A straggler AT the snapshot's floor — a duplicate/reorder a disconnect could
    // easily produce — is refused. `<=` per `recoverProgress`'s own drop rule.
    server.realtime.deliverProgress(room.roomId, [
      {
        type: 'session_heartbeat',
        roomId: room.roomId,
        sessionId,
        progressSeq: 7,
        spendMicros: 1,
        contextPct: 0.1,
        at: new Date().toISOString(),
      },
    ]);
    // A straggler UNDER the snapshot — the exact shape of a frame the client
    // missed while disconnected, arriving late over the lossy bus.
    server.realtime.deliverProgress(room.roomId, [
      {
        type: 'session_heartbeat',
        roomId: room.roomId,
        sessionId,
        progressSeq: 5,
        spendMicros: 1,
        contextPct: 0.1,
        at: new Date().toISOString(),
      },
    ]);
    // Give both frames a full round trip; then assert neither ever showed.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(client.room(room.roomId).progress?.[sessionId]).toBeUndefined();
    expect(client.room(room.roomId).progressFloor?.[sessionId]).toBe(7);

    // A frame PAST the snapshot is the real thing: applied, and raises the floor.
    server.realtime.deliverProgress(room.roomId, [
      {
        type: 'session_heartbeat',
        roomId: room.roomId,
        sessionId,
        progressSeq: 9,
        spendMicros: 2,
        contextPct: 0.2,
        at: new Date().toISOString(),
      },
    ]);
    await until(
      () => client.room(room.roomId).progress?.[sessionId]?.progressSeq === 9,
      15_000,
      'the fresh frame past the snapshot to apply',
    );
  });

  it('carries `progress: []` for a room with no durable snapshot yet — the floor is a no-op, not a refusal of every frame', async () => {
    const ada = room.people.ada as string;
    const hexi = room.people.hexi as string;
    await provisionAgentConfig({
      db: handle.db,
      userId: hexi,
      ownerUserId: ada,
      channelRoomId: room.roomId,
      host: 'fly-ord',
      harness: 'claude-code',
      model: 'opus',
      budgetLimitMicros: 20_000_000,
    });
    const planId = randomUUID();
    await handle.db.insert(plans).values({
      id: planId,
      roomId: room.roomId,
      agentUserId: hexi,
      title: 'a plan',
      status: 'open',
    });
    const [row] = await handle.db
      .insert(sessions)
      .values({
        roomId: room.roomId,
        planId,
        harness: 'claude-code',
        model: 'opus',
        status: 'open',
      })
      .returning({ id: sessions.id });
    const sessionId = (row as { id: string }).id;

    const sockets: WebSocket[] = [];
    const client = createRealtimeClient({
      userId: ada,
      url: server.url,
      reconnect: false,
      socketFactory: nodeSocketFactory({
        userId: ada,
        onSocket: (socket) => sockets.push(socket),
      }),
    });
    clients.push(client);
    await client.connect();
    client.join(room.roomId);
    await until(() => client.room(room.roomId).subscribed, 15_000, 'the client to subscribe');

    expect(client.room(room.roomId).progressFloor?.[sessionId]).toBeUndefined();

    server.realtime.deliverProgress(room.roomId, [
      {
        type: 'session_heartbeat',
        roomId: room.roomId,
        sessionId,
        progressSeq: 0,
        spendMicros: 1,
        contextPct: 0.1,
        at: new Date().toISOString(),
      },
    ]);
    await until(
      () => client.room(room.roomId).progress?.[sessionId]?.progressSeq === 0,
      15_000,
      'the first frame, seq 0, to apply against an empty floor',
    );
  });
});
