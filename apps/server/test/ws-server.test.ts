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

/** The one origin these tests are allowed to arrive from. */
const appOrigin = 'http://localhost:3000';

/** cookie value → session. Anything else is anonymous. */
let sessions: Map<string, AtriumSession>;

/** (roomId, userId) → role. Absent means "not a member". */
let memberships: Map<string, string>;

function membershipKey(room: string, user: string): string {
  return `${room}:${user}`;
}

let server: ReturnType<typeof createRealtimeServer>;
let port: number;

/** The wiring every test starts from; individual tests override a piece. */
function startServer(
  overrides: Partial<Parameters<typeof createRealtimeServer>[0]> = {},
): ReturnType<typeof createRealtimeServer> {
  return createRealtimeServer({
    host: '127.0.0.1',
    // 0 asks the OS for a free port, so parallel test files never collide.
    port: 0,
    heartbeatIntervalMs: 60_000,
    // Long enough that no test is swept by accident; the tests that care about
    // the sweep set their own.
    sweepIntervalMs: 60_000,
    logger,
    isReady: () => true,
    allowedOrigins: [appOrigin],
    environment: 'test',
    authenticateUpgrade: async (request: IncomingMessage) => {
      const who = request.headers.cookie?.replace('who=', '') ?? '';
      return sessions.get(who) ?? null;
    },
    loadRoomMembership: async (room, user): Promise<MembershipLike | null> => {
      const role = memberships.get(membershipKey(room, user));
      return role ? { role } : null;
    },
    ...overrides,
  });
}

async function listen(next: ReturnType<typeof createRealtimeServer>): Promise<void> {
  server = next;
  await server.listen();
  const address = server.httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  port = address.port;
}

beforeEach(async () => {
  sessions = new Map([
    ['ada', ada],
    ['grace', grace],
  ]);
  memberships = new Map([
    [membershipKey(roomId, ada.userId), 'member'],
    [membershipKey(roomId, grace.userId), 'admin'],
  ]);

  await listen(startServer());
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

function connect(who: string, origin: string | null = appOrigin): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: {
      ...(who ? { cookie: `who=${who}` } : {}),
      // A `ws` client sends no Origin unless told to. Browsers always do, and
      // the server refuses the ones that do not, so the tests speak like a
      // browser rather than turning the check off.
      ...(origin ? { origin } : {}),
    },
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
      headers: { cookie: 'who=ada', origin: appOrigin },
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

/**
 * A WebSocket handshake is exempt from the same-origin policy and still carries
 * cookies. Without an Origin check, any page a signed-in person visits can open
 * an authenticated socket as them — the valid session is what makes it work.
 */
describe('the origin check', () => {
  it('refuses a socket opened from somebody else’s page', async () => {
    await expect(connect('ada', 'https://evil.test')).rejects.toThrow(/403/);
  });

  it('refuses a client that sends no origin at all', async () => {
    // Otherwise the check is optional: anything that can omit a header escapes it.
    await expect(connect('ada', null)).rejects.toThrow(/403/);
  });

  it('lets a deployment opt in to origin-less clients explicitly', async () => {
    await server.close();
    await listen(startServer({ allowOriginless: true }));
    const socket = await connect('ada', null);
    await nextFrame(socket, 'welcome');
    socket.close();
  });

  it('checks the origin before the session, so a valid cookie does not help', async () => {
    // The hijack uses a *real* session; refusing on origin first is the point.
    await expect(connect('ada', 'https://evil.test')).rejects.toThrow(/403/);
    await expect(connect('', 'https://evil.test')).rejects.toThrow(/403/);
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

  it('does not let its denial reasons enumerate the command catalog', async () => {
    // `message.send` is in `commandPolicy` and has no handler yet. A distinct
    // `not_implemented` reason would let anybody with a socket tell "exists,
    // unbuilt" from "does not exist" and read the roadmap off the wire.
    const socket = await connect('grace');
    send(socket, { type: 'command', command: 'message.send', roomId });
    const authorizedButUnbuilt = await nextFrame(socket, 'command_error');

    send(socket, { type: 'command', command: 'message.sendx', roomId });
    const genuinelyUnknown = await nextFrame(socket, 'command_error');

    expect(authorizedButUnbuilt.reason).toBe('unknown_command');
    expect(authorizedButUnbuilt.reason).toBe(genuinelyUnknown.reason);
    socket.close();
  });

  it('refuses a command string long enough to be a payload', async () => {
    const socket = await connect('ada');
    send(socket, { type: 'command', command: 'x'.repeat(5000), roomId });
    const error = await nextFrame(socket, 'error');
    expect(error.message).toMatch(/unknown frame type/);
    socket.close();
  });

  it('refuses, without claiming anything about membership, when the lookup throws', async () => {
    await server.close();
    await listen(
      startServer({
        authenticateUpgrade: async () => ada,
        loadRoomMembership: async () => {
          throw new Error('database is on fire');
        },
      }),
    );

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

/**
 * Revocation, over a real socket.
 *
 * Round 1 authenticated once at the handshake and never again, so a socket
 * outlived whatever authority opened it: signing out, having a session revoked,
 * or being removed from the workspace changed nothing until the client happened
 * to reconnect. These are the tests that fail against that code.
 */
describe('revocation reaches a live connection', () => {
  it('refuses the next command after the caller loses their membership', async () => {
    const socket = await connect('ada');
    send(socket, { type: 'command', command: 'room.join', roomId });
    await nextFrame(socket, 'joined');

    // What `beforeRemoveMember` does to the database, mid-connection.
    memberships.delete(membershipKey(roomId, ada.userId));

    send(socket, { type: 'command', command: 'room.join', roomId });
    const error = await nextFrame(socket, 'command_error');
    expect(error.reason).toBe('not_a_member');
    socket.close();
  });

  it('demotes a live connection when the role behind it is demoted', async () => {
    const socket = await connect('grace');
    send(socket, { type: 'command', command: 'room.archive', roomId });
    // grace is an admin, so this is authorized (and unimplemented).
    expect((await nextFrame(socket, 'command_error')).reason).toBe('unknown_command');

    memberships.set(membershipKey(roomId, grace.userId), 'member');

    send(socket, { type: 'command', command: 'room.archive', roomId });
    expect((await nextFrame(socket, 'command_error')).reason).toBe('insufficient_role');
    socket.close();
  });

  it('closes the socket once its session is gone', async () => {
    await server.close();
    await listen(
      startServer({
        // Zero TTL: every command re-validates. Production trades a short cache
        // for the read; the behaviour under test is the same either way.
        revalidateTtlMs: 0,
        revalidateSession: async (headers: Headers) => {
          const who = headers.get('cookie')?.replace('who=', '') ?? '';
          return sessions.get(who) ?? null;
        },
      }),
    );

    const socket = await connect('ada');
    send(socket, { type: 'command', command: 'room.join', roomId });
    await nextFrame(socket, 'joined');
    expect(server.presence(roomId)).toHaveLength(1);

    // Signed out elsewhere, or the session revoked by an admin.
    sessions.delete('ada');

    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    send(socket, { type: 'command', command: 'room.join', roomId });
    expect(await closed).toBe(1008);
    await vi.waitFor(() => {
      expect(server.presence(roomId)).toHaveLength(0);
    });
  });

  it('reuses a validation for at most one TTL, and no longer', async () => {
    let valid = true;
    await server.close();
    await listen(
      startServer({
        revalidateTtlMs: 40,
        revalidateSession: async () => (valid ? ada : null),
      }),
    );

    const socket = await connect('ada');
    send(socket, { type: 'command', command: 'room.join', roomId });
    await nextFrame(socket, 'joined');

    valid = false;
    // Inside the window the cached answer still stands — that is the trade, and
    // it is bounded rather than forever.
    send(socket, { type: 'command', command: 'room.presence', roomId });
    await nextFrame(socket, 'presence');

    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    await new Promise((resolve) => setTimeout(resolve, 60));
    send(socket, { type: 'command', command: 'room.presence', roomId });
    expect(await closed).toBe(1008);
  });

  it('closes a socket whose session was replaced by a different one', async () => {
    await server.close();
    await listen(
      startServer({
        revalidateTtlMs: 0,
        revalidateSession: async () => ({ ...ada, sessionId: 'a-different-session' }),
      }),
    );

    const socket = await connect('ada');
    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    send(socket, { type: 'command', command: 'room.join', roomId });
    expect(await closed).toBe(1008);
  });

  it('refuses the command but keeps the socket when revalidation itself fails', async () => {
    await server.close();
    await listen(
      startServer({
        revalidateTtlMs: 0,
        revalidateSession: async () => {
          throw new Error('database is on fire');
        },
      }),
    );

    const socket = await connect('ada');
    send(socket, { type: 'command', command: 'room.join', roomId });
    const error = await nextFrame(socket, 'error');
    expect(error.message).toMatch(/could not check your session/);
    // Not knowing is not a reason to hang up on somebody mid-sentence.
    expect(socket.readyState).toBe(socket.OPEN);
    socket.close();
  });
});

/**
 * The negative half of the cache.
 *
 * Round 2 cached only the *positive* verdict, so a socket whose session had gone
 * — or whose database was down — re-asked on every single frame, and every one
 * of those reads was spent to produce a refusal that had already been produced.
 * A client controls how many frames it sends.
 */
describe('negative verdicts are cached too', () => {
  it('does not re-ask the session store for a socket it already revoked', async () => {
    const revalidateSession = vi.fn(async () => null);
    await server.close();
    await listen(startServer({ revalidateTtlMs: 0, revalidateSession }));

    const socket = await connect('ada');
    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    send(socket, { type: 'command', command: 'room.join', roomId });
    expect(await closed).toBe(1008);

    const asked = revalidateSession.mock.calls.length;
    // Frames can still arrive during the closing handshake; none of them may
    // cost another lookup.
    for (let i = 0; i < 5; i += 1) send(socket, { type: 'command', command: 'room.join', roomId });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(revalidateSession.mock.calls.length).toBe(asked);
  });

  it('backs off instead of reading the session store once per refused frame', async () => {
    const revalidateSession = vi.fn(async () => {
      throw new Error('database is on fire');
    });
    await server.close();
    await listen(
      startServer({ revalidateTtlMs: 0, revalidateBackoffMs: 5_000, revalidateSession }),
    );

    const socket = await connect('ada');
    for (let i = 0; i < 5; i += 1) {
      send(socket, { type: 'command', command: 'room.join', roomId });
      const error = await nextFrame(socket, 'error');
      expect(error.message).toMatch(/could not check your session/);
    }

    // Five refusals, one lookup: the verdict was remembered, and every frame
    // was still refused.
    expect(revalidateSession).toHaveBeenCalledTimes(1);
    expect(socket.readyState).toBe(socket.OPEN);
    socket.close();
  });

  it('asks again once the back-off has passed', async () => {
    let failing = true;
    const revalidateSession = vi.fn(async () => {
      if (failing) throw new Error('database is on fire');
      return ada;
    });
    await server.close();
    await listen(startServer({ revalidateTtlMs: 0, revalidateBackoffMs: 30, revalidateSession }));

    const socket = await connect('ada');
    send(socket, { type: 'command', command: 'room.join', roomId });
    await nextFrame(socket, 'error');

    failing = false;
    await new Promise((resolve) => setTimeout(resolve, 50));
    send(socket, { type: 'command', command: 'room.join', roomId });
    await nextFrame(socket, 'joined');
    socket.close();
  });
});

/**
 * Revocation has to reach the *subscription*, not just the command path.
 *
 * This is the largest gap round 2's gauntlet found. A removed member's next
 * command was refused — but a socket that only listens sends no commands, so
 * nothing ever refused it, and it went on receiving presence and every broadcast
 * from a room it had been thrown out of. "Cannot send" is not revocation;
 * "cannot see" is.
 */
describe('revocation reaches a subscription, not only a command', () => {
  it('takes a removed member off the roster and closes their socket', async () => {
    await server.close();
    await listen(startServer({ sweepIntervalMs: 25 }));

    const listener = await connect('ada');
    send(listener, { type: 'command', command: 'room.join', roomId });
    await nextFrame(listener, 'joined');
    expect(server.presence(roomId)).toHaveLength(1);

    // What `beforeRemoveMember` does to the database, mid-connection. The
    // socket sends nothing at all from here on.
    memberships.delete(membershipKey(roomId, ada.userId));

    const closed = new Promise<number>((resolve) => listener.once('close', resolve));
    expect(await closed).toBe(1008);
    expect(server.presence(roomId)).toHaveLength(0);
  });

  it('stops delivering a room’s broadcasts to somebody who was removed from it', async () => {
    await server.close();
    await listen(startServer({ sweepIntervalMs: 25 }));

    const removed = await connect('ada');
    send(removed, { type: 'command', command: 'room.join', roomId });
    await nextFrame(removed, 'joined');
    await nextFrame(removed, 'presence');

    const staying = await connect('grace');
    send(staying, { type: 'command', command: 'room.join', roomId });
    await nextFrame(staying, 'joined');
    // Both are in the room, and ada is told about grace arriving.
    expect((await nextFrame(removed, 'presence')).members).toHaveLength(2);

    memberships.delete(membershipKey(roomId, ada.userId));
    await vi.waitFor(() => {
      expect(server.presence(roomId)).toEqual([{ userId: grace.userId, displayName: 'grace' }]);
    });

    // The room keeps talking. Nothing more reaches the removed member — and the
    // assertion is about what they *receive*, not about what they may send.
    const before = (inbox.get(removed) ?? []).length;
    const third = await connect('grace');
    send(third, { type: 'command', command: 'room.presence', roomId });
    await nextFrame(third, 'presence');
    send(staying, { type: 'command', command: 'room.leave', roomId });
    await nextFrame(staying, 'left');

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((inbox.get(removed) ?? []).length).toBe(before);
    third.close();
  });

  it('tells the room who is left the moment somebody is evicted', async () => {
    await server.close();
    await listen(startServer({ sweepIntervalMs: 25 }));

    const staying = await connect('grace');
    send(staying, { type: 'command', command: 'room.join', roomId });
    await nextFrame(staying, 'joined');
    await nextFrame(staying, 'presence');

    const removed = await connect('ada');
    send(removed, { type: 'command', command: 'room.join', roomId });
    await nextFrame(removed, 'joined');
    expect((await nextFrame(staying, 'presence')).members).toHaveLength(2);

    memberships.delete(membershipKey(roomId, ada.userId));

    const after = await nextFrame(staying, 'presence');
    expect(after.members.map((m) => m.displayName)).toEqual(['grace']);
    staying.close();
  });

  it('evicts on the command path too, without waiting for the sweep', async () => {
    // Same guarantee, reached a frame earlier: a denial that says "not a
    // member" is also the moment to take the socket off that room's roster.
    const removed = await connect('ada');
    send(removed, { type: 'command', command: 'room.join', roomId });
    await nextFrame(removed, 'joined');

    memberships.delete(membershipKey(roomId, ada.userId));
    send(removed, { type: 'command', command: 'room.presence', roomId });
    expect((await nextFrame(removed, 'command_error')).reason).toBe('not_a_member');

    expect(server.presence(roomId)).toHaveLength(0);
    removed.close();
  });

  it('does not evict anybody because a membership lookup failed', async () => {
    // "The database did not answer" is not "you were removed". Turning a blip
    // into a mass disconnection is its own outage.
    let failing = false;
    await server.close();
    await listen(
      startServer({
        sweepIntervalMs: 25,
        loadRoomMembership: async (room, user) => {
          if (failing) throw new Error('database is on fire');
          const role = memberships.get(membershipKey(room, user));
          return role ? { role } : null;
        },
      }),
    );

    const socket = await connect('ada');
    send(socket, { type: 'command', command: 'room.join', roomId });
    await nextFrame(socket, 'joined');

    failing = true;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(socket.readyState).toBe(socket.OPEN);
    expect(server.presence(roomId)).toHaveLength(1);
    socket.close();
  });

  it('drops an idle socket whose session was revoked, with no command sent', async () => {
    // The other half of the same gap: signing out on another device must not
    // wait for this one to type.
    await server.close();
    await listen(
      startServer({
        sweepIntervalMs: 25,
        revalidateTtlMs: 0,
        revalidateSession: async (headers: Headers) => {
          const who = headers.get('cookie')?.replace('who=', '') ?? '';
          return sessions.get(who) ?? null;
        },
      }),
    );

    const socket = await connect('ada');
    send(socket, { type: 'command', command: 'room.join', roomId });
    await nextFrame(socket, 'joined');

    sessions.delete('ada');
    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    expect(await closed).toBe(1008);
    expect(server.presence(roomId)).toHaveLength(0);
  });
});

/**
 * The fail-open default, closed.
 *
 * Round 2 made `revalidateSession` optional and defaulted the missing case to
 * `return true`, so forgetting to wire it up silently restored round 1: a socket
 * that outlives its session forever. Production does not get to arrive that way.
 */
describe('a production server refuses to start without a session validator', () => {
  const base = {
    host: '127.0.0.1',
    port: 0,
    heartbeatIntervalMs: 60_000,
    logger,
    isReady: () => true,
    allowedOrigins: [appOrigin],
    authenticateUpgrade: async () => ada,
    loadRoomMembership: async () => ({ role: 'member' }),
  } as const;

  it('throws, naming what to pass', () => {
    expect(() => createRealtimeServer({ ...base, environment: 'production' })).toThrow(
      /revalidateSession is required when NODE_ENV=production/,
    );
  });

  it('starts in production once one is passed', () => {
    const built = createRealtimeServer({
      ...base,
      environment: 'production',
      revalidateSession: async () => ada,
    });
    expect(built.connectionCount()).toBe(0);
  });

  it('still allows it in development, loudly', () => {
    const warn = vi.fn();
    const built = createRealtimeServer({
      ...base,
      environment: 'development',
      logger: { ...logger, warn },
    });
    expect(built.connectionCount()).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('sockets will not be re-validated'),
      expect.anything(),
    );
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
