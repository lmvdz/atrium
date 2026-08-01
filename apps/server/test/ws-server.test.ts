import type { IncomingMessage } from 'node:http';
import type { AtriumSession, MembershipLike } from '@atrium/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createLogger } from '../src/logger.js';
import type { ServerFrame } from '../src/ws-server.js';
import { createRealtimeServer } from '../src/ws-server.js';

/**
 * The realtime surface's trust boundary, exercised over a real socket.
 *
 * Authentication and membership are injected, so these tests are about the
 * server's own decisions — who gets a socket, which commands run, what a denial
 * looks like on the wire — and not about Better Auth, which has its own tests.
 */

const ada: AtriumSession = {
  sessionId: 'session-ada',
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'ada@example.com',
  displayName: 'ada',
  emailVerified: true,
  activeWorkspaceId: null,
};

const grace: AtriumSession = {
  sessionId: 'session-grace',
  userId: '22222222-2222-4222-8222-222222222222',
  email: 'grace@example.com',
  displayName: 'grace',
  emailVerified: true,
  activeWorkspaceId: null,
};

const roomId = '33333333-3333-4333-8333-333333333333';
const otherRoomId = '44444444-4444-4444-8444-444444444444';

const logger = createLogger('error');

/** cookie value → session. Anything else is anonymous. */
const sessions = new Map<string, AtriumSession>([
  ['ada', ada],
  ['grace', grace],
]);

/** (roomId, userId) → role. Absent means "not a member". */
let memberships: Map<string, string>;

function membershipKey(room: string, user: string): string {
  return `${room}:${user}`;
}

let server: ReturnType<typeof createRealtimeServer>;
let port: number;

beforeEach(async () => {
  memberships = new Map([
    [membershipKey(roomId, ada.userId), 'member'],
    [membershipKey(roomId, grace.userId), 'admin'],
  ]);

  server = createRealtimeServer({
    host: '127.0.0.1',
    // 0 asks the OS for a free port, so parallel test files never collide.
    port: 0,
    heartbeatIntervalMs: 60_000,
    logger,
    isReady: () => true,
    authenticateUpgrade: async (request: IncomingMessage) => {
      const who = request.headers.cookie?.replace('who=', '') ?? '';
      return sessions.get(who) ?? null;
    },
    loadRoomMembership: async (room, user): Promise<MembershipLike | null> => {
      const role = memberships.get(membershipKey(room, user));
      return role ? { role } : null;
    },
  });

  await server.listen();
  const address = server.httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  port = address.port;
});

afterEach(async () => {
  await server.close();
});

/**
 * Every frame a socket has received and no assertion has claimed yet. The
 * server sends `welcome` the instant the socket opens, so a test that only
 * starts listening after `connect()` resolves would race it — buffering from
 * the moment of construction removes the race rather than sleeping past it.
 */
const inbox = new WeakMap<WebSocket, ServerFrame[]>();

function connect(who: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: who ? { cookie: `who=${who}` } : {},
  });
  const frames: ServerFrame[] = [];
  inbox.set(socket, frames);
  socket.on('message', (raw: Buffer | string) => {
    frames.push(JSON.parse(raw.toString()) as ServerFrame);
  });

  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
    socket.once('unexpected-response', (_request, response) => {
      reject(new Error(`upgrade rejected with ${response.statusCode}`));
    });
  });
}

/** Takes the next unclaimed frame of a given type, waiting for it if need be. */
async function nextFrame<T extends ServerFrame['type']>(
  socket: WebSocket,
  type: T,
  timeoutMs = 2000,
): Promise<Extract<ServerFrame, { type: T }>> {
  const frames = inbox.get(socket) ?? [];
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const index = frames.findIndex((frame) => frame.type === type);
    if (index >= 0) {
      const [frame] = frames.splice(index, 1);
      return frame as Extract<ServerFrame, { type: T }>;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for a "${type}" frame`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function send(socket: WebSocket, frame: unknown): void {
  socket.send(JSON.stringify(frame));
}

describe('the upgrade', () => {
  it('refuses an unauthenticated client with 401, before the handshake', async () => {
    await expect(connect('')).rejects.toThrow(/401/);
  });

  it('refuses a session it does not recognise', async () => {
    await expect(connect('mallory')).rejects.toThrow(/401/);
  });

  it('refuses any path other than /ws', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/admin`, {
      headers: { cookie: 'who=ada' },
    });
    await expect(
      new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
        socket.once('unexpected-response', (_r, response) =>
          reject(new Error(`rejected with ${response.statusCode}`)),
        );
      }),
    ).rejects.toThrow(/404/);
  });

  it('greets an authenticated client with who it thinks they are', async () => {
    const socket = await connect('ada');
    const welcome = await nextFrame(socket, 'welcome');
    expect(welcome.user).toEqual({ id: ada.userId, displayName: 'ada' });
    socket.close();
  });
});

describe('commands', () => {
  it('lets a member join a room', async () => {
    const socket = await connect('ada');
    send(socket, { type: 'command', command: 'room.join', roomId, requestId: 'r1' });
    const joined = await nextFrame(socket, 'joined');
    expect(joined).toMatchObject({ roomId, requestId: 'r1' });
    socket.close();
  });

  it('rejects a command for a room the caller does not belong to', async () => {
    const socket = await connect('ada');
    send(socket, { type: 'command', command: 'room.join', roomId: otherRoomId });
    const error = await nextFrame(socket, 'command_error');
    expect(error).toMatchObject({ reason: 'not_a_member', roomId: otherRoomId });
    socket.close();
  });

  it('rejects an admin-only command from a plain member', async () => {
    const socket = await connect('ada');
    send(socket, { type: 'command', command: 'room.archive', roomId });
    const error = await nextFrame(socket, 'command_error');
    expect(error.reason).toBe('insufficient_role');
    socket.close();
  });

  it('rejects a command it has never heard of', async () => {
    const socket = await connect('ada');
    send(socket, { type: 'command', command: 'room.drop', roomId });
    const error = await nextFrame(socket, 'command_error');
    expect(error.reason).toBe('unknown_command');
    socket.close();
  });

  it('rejects a workspace command even from a room owner', async () => {
    memberships.set(membershipKey(roomId, ada.userId), 'owner');
    const socket = await connect('ada');
    send(socket, { type: 'command', command: 'workspace.delete', roomId });
    const error = await nextFrame(socket, 'command_error');
    expect(error.reason).toBe('wrong_scope');
    socket.close();
  });

  it('answers an authorized-but-unimplemented command honestly', async () => {
    const socket = await connect('grace');
    send(socket, { type: 'command', command: 'message.send', roomId });
    const error = await nextFrame(socket, 'command_error');
    expect(error.reason).toBe('not_implemented');
    socket.close();
  });

  it('refuses, without claiming anything about membership, when the lookup throws', async () => {
    await server.close();
    server = createRealtimeServer({
      host: '127.0.0.1',
      port: 0,
      heartbeatIntervalMs: 60_000,
      logger,
      isReady: () => true,
      authenticateUpgrade: async () => ada,
      loadRoomMembership: async () => {
        throw new Error('database is on fire');
      },
    });
    await server.listen();
    const address = server.httpServer.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    port = address.port;

    const socket = await connect('ada');
    send(socket, { type: 'command', command: 'room.join', roomId });
    const error = await nextFrame(socket, 'command_error');
    expect(error.reason).toBe('unavailable');
    // The caller is refused, which is the part that matters.
    expect(server.presence(roomId)).toHaveLength(0);
    socket.close();
  });

  it('rejects a frame that is not valid JSON', async () => {
    const socket = await connect('ada');
    socket.send('{nope');
    const error = await nextFrame(socket, 'error');
    expect(error.message).toMatch(/not valid JSON/);
    socket.close();
  });
});

describe('presence', () => {
  it('shows both people in a room to both of them', async () => {
    const first = await connect('ada');
    send(first, { type: 'command', command: 'room.join', roomId });
    await nextFrame(first, 'joined');
    // Claim the roster ada's own join produced, so the next one is grace's.
    expect((await nextFrame(first, 'presence')).members).toHaveLength(1);

    const second = await connect('grace');
    send(second, { type: 'command', command: 'room.join', roomId });
    await nextFrame(second, 'joined');

    // Both sockets are told, not just the one that joined.
    const onFirst = await nextFrame(first, 'presence');
    const onSecond = await nextFrame(second, 'presence');
    expect(onFirst.roomId).toBe(roomId);
    expect(onFirst.members.map((m) => m.displayName)).toEqual(['ada', 'grace']);
    expect(onSecond.members.map((m) => m.displayName)).toEqual(['ada', 'grace']);
    expect(server.presence(roomId)).toHaveLength(2);

    first.close();
    second.close();
  });

  it('counts a person once however many tabs they have open', async () => {
    const tabOne = await connect('ada');
    send(tabOne, { type: 'command', command: 'room.join', roomId });
    await nextFrame(tabOne, 'joined');

    const tabTwo = await connect('ada');
    send(tabTwo, { type: 'command', command: 'room.join', roomId });
    await nextFrame(tabTwo, 'joined');

    expect(server.presence(roomId)).toEqual([{ userId: ada.userId, displayName: 'ada' }]);
    tabOne.close();
    tabTwo.close();
  });

  it('drops a person from the roster when their socket closes', async () => {
    const socket = await connect('ada');
    send(socket, { type: 'command', command: 'room.join', roomId });
    await nextFrame(socket, 'joined');
    expect(server.presence(roomId)).toHaveLength(1);

    socket.close();
    await vi.waitFor(() => {
      expect(server.presence(roomId)).toHaveLength(0);
    });
  });

  it('leaves a room on request without dropping the connection', async () => {
    const socket = await connect('ada');
    send(socket, { type: 'command', command: 'room.join', roomId });
    await nextFrame(socket, 'joined');

    send(socket, { type: 'command', command: 'room.leave', roomId });
    await nextFrame(socket, 'left');
    expect(server.presence(roomId)).toHaveLength(0);
    expect(server.connectionCount()).toBe(1);
    socket.close();
  });
});
