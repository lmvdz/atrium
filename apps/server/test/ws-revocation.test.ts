import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { CommandService } from '../src/commands.js';
import type { Ledger } from '../src/ledger.js';
import { createLogger } from '../src/logger.js';
import type { ServerFrame } from '../src/protocol.js';
import { type MembershipPair, membershipKey } from '../src/session.js';
import { createRealtimeServer, type RealtimeServer } from '../src/ws-server.js';

/**
 * That the fan-out membership re-check **runs on its own** (#22 r9, D2).
 *
 * The rule itself — who is dropped, what they are told, what survives — is
 * `integration/server/catchup.test.ts`, against a real Postgres and real
 * memberships. Those tests call `revalidateSubscriptions()` directly, on purpose:
 * a test that sleeps past an interval is measuring the interval rather than the
 * rule.
 *
 * Which leaves exactly one thing unasserted, and it is the one that decides
 * whether any of it ships: **is anything calling it?** A perfect rule that only
 * a test ever reaches is r8's defect with a function in front of it. So this
 * file connects a real socket to a real server, subscribes, revokes, and then
 * touches nothing — the assertion is that the frame arrives anyway.
 *
 * No database. The membership answer is the one seam that is stubbed, because
 * the question here is not what the answer is; it is whether anybody asks.
 */

const logger = createLogger('error');
const ROOM = 'room-1';
const USER = 'user-1';

const servers: RealtimeServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const server of servers.splice(0)) await server.close();
});

/** Just enough command service for `subscribe` and the revalidation pass. */
function stubCommands(members: Set<string>): CommandService {
  return {
    execute: () => Promise.reject(new Error('not used')),
    requireMembership: (session, roomId) =>
      members.has(membershipKey(session.userId, roomId))
        ? Promise.resolve({ seenSeq: 0 })
        : Promise.reject(new Error('not a member')),
    stillMembers: (pairs: readonly MembershipPair[]) =>
      Promise.resolve(
        new Set(
          pairs
            .map((pair) => membershipKey(pair.userId, pair.roomId))
            .filter((key) => members.has(key)),
        ),
      ),
  };
}

const stubLedger = { head: () => Promise.resolve(0) } as unknown as Ledger;

async function start(members: Set<string>, intervalMs: number): Promise<RealtimeServer> {
  const server = createRealtimeServer({
    host: '127.0.0.1',
    port: 0,
    heartbeatIntervalMs: 30_000,
    logger,
    isReady: () => true,
    commands: stubCommands(members),
    ledger: stubLedger,
    membershipRevalidateIntervalMs: intervalMs,
    session: { authenticateUpgrade: async () => ({ userId: USER, method: 'stub' }) },
  });
  servers.push(server);
  await server.listen();
  return server;
}

function connect(server: RealtimeServer): {
  socket: WebSocket;
  frames: ServerFrame[];
  opened: Promise<void>;
} {
  const { port } = server.httpServer.address() as AddressInfo;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(socket);
  const frames: ServerFrame[] = [];
  socket.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as ServerFrame));
  return {
    socket,
    frames,
    opened: new Promise<void>((resolve) => socket.on('open', () => resolve())),
  };
}

function waitFor(
  frames: ServerFrame[],
  match: (frame: ServerFrame) => boolean,
  timeoutMs = 5_000,
): Promise<ServerFrame> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      const found = frames.find(match);
      if (found) {
        clearInterval(tick);
        resolve(found);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(tick);
        reject(new Error(`timed out; saw: ${frames.map((f) => f.type).join(', ')}`));
      }
    }, 5);
  });
}

describe('the membership revalidation timer', () => {
  it('drives the membership revalidation pass on its own timer', async () => {
    const members = new Set([membershipKey(USER, ROOM)]);
    const server = await start(members, 25);
    const client = connect(server);
    await client.opened;

    client.socket.send(JSON.stringify({ type: 'subscribe', roomId: ROOM }));
    await waitFor(client.frames, (f) => f.type === 'subscribed');
    expect(server.hub.subscriberCount(ROOM)).toBe(1);

    // The revocation. Nothing below calls `revalidateSubscriptions` — if the
    // timer is not wired, or is wired to a body that does nothing, this test
    // times out, which is exactly what shipping r8's behaviour behind a correct
    // but unreached function would look like.
    members.clear();

    const told = await waitFor(client.frames, (f) => f.type === 'unsubscribed');
    expect(told).toEqual({ type: 'unsubscribed', roomId: ROOM });
    expect(server.hub.subscriberCount(ROOM)).toBe(0);
  });

  it('leaves a live subscription alone across many passes', async () => {
    // The other direction, and the reason it is here rather than only in the
    // integration suite: a timer that evicted unconditionally would pass the
    // test above and would disconnect every room in production on the first
    // tick. Ten passes at 10 ms, and the subscription is still there.
    const server = await start(new Set([membershipKey(USER, ROOM)]), 10);
    const client = connect(server);
    await client.opened;

    client.socket.send(JSON.stringify({ type: 'subscribe', roomId: ROOM }));
    await waitFor(client.frames, (f) => f.type === 'subscribed');

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(server.hub.subscriberCount(ROOM)).toBe(1);
    expect(client.frames.filter((f) => f.type === 'unsubscribed')).toEqual([]);
  });
});
