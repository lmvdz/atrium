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

/**
 * Stop this client reading, without stopping it writing.
 *
 * Several properties below are about the window between `socket.close()` and
 * the peer answering — the closing *handshake*, during which the socket is
 * still open and frames still arrive. Normally `ws` answers a close frame the
 * instant it reads one, so that window is a few microseconds wide and a test
 * that aims at it is a race. Pausing the underlying TCP socket means the client
 * never reads the close frame, never replies, and the window stays open for as
 * long as the test needs. Nothing about the server changes; the test just stops
 * being in a hurry.
 */
function pauseReads(socket: WebSocket): void {
  (socket as unknown as { _socket: { pause: () => void } })._socket.pause();
}

function resumeReads(socket: WebSocket): void {
  (socket as unknown as { _socket: { resume: () => void } })._socket.resume();
}

/**
 * Count frames as the *server* receives them.
 *
 * The server runs in this process, so its own socket object is reachable — and
 * a listener attached to it fires after the server's own, which is registered
 * first. `handleFrame` runs synchronously as far as its first `await`, so by
 * the time this counter moves the frame has already passed every check that
 * happens before one. That is a synchronisation point rather than a sleep: it
 * says "the server has seen N frames", which is the thing the assertions below
 * actually need to wait for.
 */
function countServerFrames(): { seen: () => number } {
  let seen = 0;
  for (const socket of server.wss.clients) {
    socket.on('message', () => {
      seen += 1;
    });
  }
  return { seen: () => seen };
}

/** A promise somebody else settles. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Nothing here is allowed to become an unhandled rejection before the server
  // awaits it.
  promise.catch(() => {});
  return { promise, resolve, reject };
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

  /**
   * The `rawPathname` guard, tested at the boundary it is actually load-bearing
   * on — the round-4 delta's third finding, answered.
   *
   * Codex was right that the web route cannot prove this: a Next route handler
   * is handed a `Request`, and constructing one already ran the WHATWG URL
   * parser, so `rawPathname` and `new URL().pathname` return the same string
   * there for every input (`mounted.test.ts` measures it). **Here they do not.**
   * Node's HTTP parser passes the request target through verbatim, so
   * `req.url` really is `/nope/../ws`, and the choice of function decides
   * whether this server answers an upgrade for a path it never registered.
   *
   * So the request line is written onto a raw socket by hand rather than handed
   * to a WebSocket client library, which would normalise it before it left.
   *
   * Catches: reverting `ws-server.ts`'s `rawPathname(request.url ?? '/')` to
   * `new URL(request.url ?? '/', 'http://localhost').pathname`. That turns the
   * path into `/ws`, the request gets past the path check, and the assertion
   * below reads 101 (or 401/403 from the checks after it) instead of 404.
   */
  it('refuses a request line whose dot segments would canonicalize to /ws', async () => {
    const { createConnection } = await import('node:net');

    const statusFor = (target: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port }, () => {
          socket.write(
            [
              `GET ${target} HTTP/1.1`,
              'Host: 127.0.0.1',
              'Upgrade: websocket',
              'Connection: Upgrade',
              'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
              'Sec-WebSocket-Version: 13',
              `Origin: ${appOrigin}`,
              'Cookie: who=ada',
              '',
              '',
            ].join('\r\n'),
          );
        });
        let received = '';
        socket.on('data', (chunk) => {
          received += chunk.toString('utf8');
          const line = received.split('\r\n')[0];
          if (line !== undefined && received.includes('\r\n')) {
            socket.destroy();
            resolve(line);
          }
        });
        socket.on('error', reject);
        socket.setTimeout(5_000, () => {
          socket.destroy();
          reject(new Error(`no response to ${target}`));
        });
      });

    // The premise, measured on this very request: Node hands the target over
    // un-canonicalized, and a URL parser would rewrite it to the mounted path.
    expect(new URL('/nope/../ws', 'http://127.0.0.1').pathname).toBe('/ws');

    await expect(statusFor('/nope/../ws')).resolves.toContain('404');
    await expect(statusFor('/ws/../ws')).resolves.toContain('404');
    // The control: the path it really does publish still upgrades, so a guard
    // that simply refused everything would not pass this test either.
    await expect(statusFor('/ws')).resolves.toContain('101');
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

    /**
     * Past the window, the next command closes it. Polled rather than slept
     * past: the assertion is "the first command sent after the TTL expires is
     * refused", and a fixed sleep tuned to be comfortably longer than the TTL is
     * a guess about a scheduler dressed up as a fact.
     */
    let closedWith: number | null = null;
    socket.once('close', (code: number) => {
      closedWith = code;
    });
    await vi.waitFor(
      () => {
        send(socket, { type: 'command', command: 'room.presence', roomId });
        expect(closedWith).toBe(1008);
      },
      { timeout: 2_000, interval: 10 },
    );
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
  /**
   * Sticky revocation, which round 3 deleted the coverage for while appearing
   * to add it.
   *
   * The r3 test sent ten frames in one burst and asserted one session read. It
   * passed — but it passed on the *coalescing* property (`connection.pending`),
   * because all ten reached the cache check before the first answer came back.
   * Remove the `revoked` early return entirely and it still passed. grok found
   * that, and it is the round's most important finding because it is about the
   * process rather than the code.
   *
   * This aims at the property directly: the frames go **after** the revocation
   * has settled, into the window where the socket is closing and the peer has
   * not answered yet. Nothing is coalesced, because there is nothing in flight
   * to coalesce with.
   *
   * Catches: deleting `if (connection.revoked) return false;` from
   * `stillAuthenticated` — the ten frames then find a stale cache
   * (`revalidateTtlMs: 0`) and the session store is read a second time.
   */
  it('asks the session store nothing more once the socket is revoked', async () => {
    const revalidateSession = vi.fn(async () => null);
    await server.close();
    await listen(startServer({ revalidateTtlMs: 0, revalidateSession }));

    const socket = await connect('ada');
    const frames = countServerFrames();

    // The client stops reading, so the close frame the server is about to send
    // is never answered and the socket stays open at both ends.
    pauseReads(socket);

    // One frame, which revokes.
    send(socket, { type: 'command', command: 'room.join', roomId });
    await vi.waitFor(() => {
      expect(revalidateSession).toHaveBeenCalledTimes(1);
    });

    // Ten more, every one of them after the verdict was reached.
    for (let i = 0; i < 10; i += 1) send(socket, { type: 'command', command: 'room.join', roomId });
    await vi.waitFor(() => {
      expect(frames.seen()).toBe(11);
    });

    expect(revalidateSession).toHaveBeenCalledTimes(1);
    resumeReads(socket);
    // Nor did any of them get an answer: a revoked socket is not a socket with
    // a narrower vocabulary, it is one with nothing left to say to.
    const received = (inbox.get(socket) ?? []).map((frame) => frame.type);
    expect(received).not.toContain('joined');
    expect(received).not.toContain('command_error');
    socket.terminate();
  });

  /**
   * The frames nobody thought of as privileged.
   *
   * Round 3 asked "is this still a session?" inside `handleCommand`, so `hello`,
   * `ping` and `echo` were answered without it — and `hello` re-emits the
   * connection id and the display name of the person behind the socket. A client
   * that simply never sent a command was never re-validated on the frame path at
   * all; only the sweep could reach it. Its gauntlet listed this as polish; it is
   * the same fail-open as the rest of the round, wearing a different frame type.
   *
   * Catches: moving the `stillAuthenticated` call back inside `handleCommand`.
   * Each of these three frames is then answered by a socket whose session is
   * gone, and the socket is never closed at all.
   */
  it.each([
    ['hello', { type: 'hello' }, 'welcome'],
    ['ping', { type: 'ping' }, 'pong'],
    ['echo', { type: 'echo', payload: 'still there?' }, 'echo'],
  ] as const)('re-validates the session before answering %s, too', async (_name, frame, reply) => {
    await server.close();
    await listen(
      startServer({
        revalidateTtlMs: 0,
        revalidateSession: async (headers: Headers) => {
          const who = headers.get('cookie')?.replace('who=', '') ?? '';
          return sessions.get(who) ?? null;
        },
      }),
    );

    const socket = await connect('ada');
    // The greeting the server volunteers on connect, claimed so the assertion
    // below is about a reply to *this* frame.
    await nextFrame(socket, 'welcome');

    // Signed out on another device.
    sessions.delete('ada');

    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    send(socket, frame);
    expect(await closed).toBe(1008);
    expect((inbox.get(socket) ?? []).map((received) => received.type)).not.toContain(reply);
  });

  it('still answers those frames while the session is good', async () => {
    // The other half: re-validating every frame must not turn the keepalive and
    // the greeting into errors for a socket that is perfectly fine.
    // Catches: refusing non-command frames outright instead of checking them.
    await server.close();
    await listen(
      startServer({
        revalidateTtlMs: 0,
        revalidateSession: async (headers: Headers) => {
          const who = headers.get('cookie')?.replace('who=', '') ?? '';
          return sessions.get(who) ?? null;
        },
      }),
    );

    const socket = await connect('ada');
    await nextFrame(socket, 'welcome');
    send(socket, { type: 'ping' });
    await nextFrame(socket, 'pong');
    send(socket, { type: 'hello' });
    expect((await nextFrame(socket, 'welcome')).user.displayName).toBe('ada');
    send(socket, { type: 'echo', payload: 42 });
    expect((await nextFrame(socket, 'echo')).payload).toBe(42);
    socket.close();
  });

  /**
   * Shared rejection, which round 3's sequential test could not see.
   *
   * That test sent five frames one at a time, awaiting the refusal in between —
   * so `retryAfter` alone satisfied it and dropping `connection.pending` changed
   * nothing. A client picks how far apart its frames are, and the interesting
   * case is "not at all".
   *
   * Catches: removing the `if (connection.pending) return connection.pending`
   * sharing from `revalidateOnce` while leaving `retryAfter` in place — the five
   * frames are all in flight before the first rejection sets the back-off, so
   * the session store is read five times.
   */
  it('costs one lookup for a burst that arrives before the first answer', async () => {
    const gate = deferred<AtriumSession | null>();
    const revalidateSession = vi.fn(() => gate.promise);
    await server.close();
    await listen(
      startServer({ revalidateTtlMs: 0, revalidateBackoffMs: 5_000, revalidateSession }),
    );

    const socket = await connect('ada');
    const frames = countServerFrames();

    for (let i = 0; i < 5; i += 1) send(socket, { type: 'command', command: 'room.join', roomId });
    // All five are in the server, all five are waiting on the same lookup.
    await vi.waitFor(() => {
      expect(frames.seen()).toBe(5);
    });

    gate.reject(new Error('database is on fire'));

    for (let i = 0; i < 5; i += 1) {
      const error = await nextFrame(socket, 'error');
      expect(error.message).toMatch(/could not check your session/);
    }
    expect(revalidateSession).toHaveBeenCalledTimes(1);
    expect(socket.readyState).toBe(socket.OPEN);
    socket.close();
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
    // Same shape as the TTL test: retry until the back-off has genuinely
    // elapsed, rather than sleeping for a number chosen to be bigger than it.
    await vi.waitFor(
      async () => {
        send(socket, { type: 'command', command: 'room.join', roomId });
        await nextFrame(socket, 'joined', 25);
      },
      { timeout: 2_000, interval: 20 },
    );
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
  /**
   * Catches: deleting the `for (const roomId of connection.rooms)` membership
   * loop from `sweepConnections`. This socket sends nothing after joining, so
   * the sweep is the only thing that can notice — with the loop gone the close
   * never arrives and this times out.
   */
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

  /**
   * The roster is cleared *before* the close is even requested, and that is a
   * different claim from "the roster ends up clear".
   *
   * `socket.close()` starts a handshake the peer has to answer, and until it
   * does the socket is still on the roster, still in `presence()`, and still
   * receiving every broadcast the room makes. The close handler clears the
   * roster too — so a test that waits for the socket to close cannot tell the
   * two apart, which is what round 3's version could not do. This one never
   * lets the handshake finish.
   *
   * Catches: removing `leaveAllRooms(socket)` from `revoke` while leaving the
   * `close` handler exactly as it is. The removed member then sits in
   * `presence()` for the whole handshake and receives the room's next broadcast.
   */
  it('clears the roster before the close handshake, not when it finishes', async () => {
    await server.close();
    await listen(startServer({ sweepIntervalMs: 25 }));

    const removed = await connect('ada');
    send(removed, { type: 'command', command: 'room.join', roomId });
    await nextFrame(removed, 'joined');

    const staying = await connect('grace');
    send(staying, { type: 'command', command: 'room.join', roomId });
    await nextFrame(staying, 'joined');
    expect(server.presence(roomId)).toHaveLength(2);

    // From here the close can start but can never complete.
    pauseReads(removed);
    const framesBefore = (inbox.get(removed) ?? []).length;
    memberships.delete(membershipKey(roomId, ada.userId));

    await vi.waitFor(() => {
      expect(server.presence(roomId)).toEqual([{ userId: grace.userId, displayName: 'grace' }]);
    });
    // …and the socket really is still open at both ends, which is the whole
    // point: the roster was cleared while it was.
    expect(removed.readyState).toBe(removed.OPEN);

    // The room talks. Nothing reaches the removed member.
    const third = await connect('grace');
    send(third, { type: 'command', command: 'room.join', roomId });
    await nextFrame(third, 'joined');
    await nextFrame(staying, 'presence');

    resumeReads(removed);
    const closed = new Promise<number>((resolve) => removed.once('close', resolve));
    expect(await closed).toBe(1008);
    // Everything after the pause is the close itself; no presence, no broadcast.
    expect((inbox.get(removed) ?? []).length).toBe(framesBefore);
    third.close();
    staying.close();
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

    /**
     * Wait for the close to land before counting, and the count needs no sleep
     * afterwards: the close frame is the last byte the server can put on that
     * socket, so anything it had sent arrived before it and anything it might
     * have sent later cannot be sent at all. Round 3 slept fifty milliseconds
     * here and hoped. The listener goes on before the removal, because the
     * eviction and the close are the same turn.
     */
    const closed = new Promise<number>((resolve) => removed.once('close', resolve));
    memberships.delete(membershipKey(roomId, ada.userId));
    expect(await closed).toBe(1008);
    await vi.waitFor(() => {
      expect(server.presence(roomId)).toEqual([{ userId: grace.userId, displayName: 'grace' }]);
    });
    const before = (inbox.get(removed) ?? []).length;

    // The room keeps talking. Nothing more reaches the removed member — and the
    // assertion is about what they *receive*, not about what they may send.
    const third = await connect('grace');
    send(third, { type: 'command', command: 'room.presence', roomId });
    await nextFrame(third, 'presence');
    send(staying, { type: 'command', command: 'room.leave', roomId });
    await nextFrame(staying, 'left');

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

  /**
   * "The database did not answer" is not "you were removed". Turning a blip into
   * a mass disconnection is its own outage.
   *
   * Round 3's version of this asserted only that the socket stayed open, which
   * is also what happens if the sweep never runs at all — grok's point, and the
   * same shape as the theatre test. So the sweep now has to *prove it looked*:
   * `lookups` counts the failing calls, and the assertion is that several
   * happened and the socket survived them.
   *
   * Catches: deleting the membership loop from `sweepConnections` (the lookup
   * count stops at the one the join made), and evicting on the first failure.
   */
  it('does not evict anybody because a membership lookup failed', async () => {
    let failing = false;
    let lookups = 0;
    await server.close();
    await listen(
      startServer({
        sweepIntervalMs: 15,
        // High enough that this test is about the tolerance and not about its
        // bound; the bound has tests of its own below.
        sweepFailureLimit: 1_000,
        sweepUnverifiedMs: 300_000,
        loadRoomMembership: async (room, user) => {
          if (failing) {
            lookups += 1;
            throw new Error('database is on fire');
          }
          const role = memberships.get(membershipKey(room, user));
          return role ? { role } : null;
        },
      }),
    );

    const socket = await connect('ada');
    send(socket, { type: 'command', command: 'room.join', roomId });
    await nextFrame(socket, 'joined');

    failing = true;
    await vi.waitFor(() => {
      expect(lookups).toBeGreaterThanOrEqual(3);
    });
    expect(socket.readyState).toBe(socket.OPEN);
    expect(server.presence(roomId)).toHaveLength(1);
    socket.close();
  });

  /**
   * Major finding 4: that tolerance had no end.
   *
   * Both of round 3's critics arrived at the same sentence — a revoked session
   * keeps receiving broadcasts for exactly as long as the dependency stays
   * down, and nobody controls that duration. So it is bounded now: N sweeps
   * that cannot get an answer, or T milliseconds, whichever comes first.
   *
   * Catches: reverting `sweepConnections`'s membership `catch` to a bare
   * `continue` (nothing ever evicts and this times out).
   */
  it('closes a socket after enough sweeps have failed to verify it', async () => {
    let joined = false;
    await server.close();
    await listen(
      startServer({
        sweepIntervalMs: 15,
        sweepFailureLimit: 3,
        sweepUnverifiedMs: 300_000,
        loadRoomMembership: async (room, user) => {
          if (room === roomId && user === ada.userId && joined) {
            throw new Error('database is on fire');
          }
          const role = memberships.get(membershipKey(room, user));
          return role ? { role } : null;
        },
      }),
    );

    const socket = await connect('ada');
    send(socket, { type: 'command', command: 'room.join', roomId });
    await nextFrame(socket, 'joined');
    joined = true;

    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    expect(await closed).toBe(1008);
    expect(server.presence(roomId)).toHaveLength(0);
  });

  /**
   * …and the same bound in wall-clock time, so a long sweep interval cannot turn
   * "three sweeps" into an hour.
   *
   * Catches: dropping the `sweepUnverifiedMs` half of
   * `evictIfUnverifiableTooLong` — with the count set to a thousand, time is
   * the only thing that can close this socket.
   */
  it('closes a socket nothing has verified for long enough, however few sweeps that took', async () => {
    let joined = false;
    await server.close();
    await listen(
      startServer({
        sweepIntervalMs: 15,
        sweepFailureLimit: 1_000,
        sweepUnverifiedMs: 40,
        loadRoomMembership: async (room, user) => {
          if (room === roomId && user === ada.userId && joined) {
            throw new Error('database is on fire');
          }
          const role = memberships.get(membershipKey(room, user));
          return role ? { role } : null;
        },
      }),
    );

    const socket = await connect('ada');
    send(socket, { type: 'command', command: 'room.join', roomId });
    await nextFrame(socket, 'joined');
    joined = true;

    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    expect(await closed).toBe(1008);
  });

  /**
   * Major finding 6: the back-off was honoured on the command path and ignored
   * on the idle one, so a socket whose session lookup had just failed was asked
   * again by the very next sweep — negative caching that held only for the half
   * of the code with somebody typing into it.
   *
   * grace is the metronome: every sweep visits every connection, so counting
   * *her* membership lookups counts sweeps without touching ada's counters.
   *
   * Catches: deleting the `now < connection.retryAfter` check from
   * `sweepConnections` — ada's session store is then read once per sweep.
   */
  it('honours the back-off on the idle path, not only the command path', async () => {
    let adaLookups = 0;
    let sweeps = 0;
    await server.close();
    await listen(
      startServer({
        sweepIntervalMs: 10,
        revalidateTtlMs: 0,
        revalidateBackoffMs: 10_000,
        sweepFailureLimit: 1_000,
        sweepUnverifiedMs: 300_000,
        revalidateSession: async (headers: Headers) => {
          const who = headers.get('cookie')?.replace('who=', '') ?? '';
          if (who === 'ada') {
            adaLookups += 1;
            throw new Error('database is on fire');
          }
          return sessions.get(who) ?? null;
        },
        loadRoomMembership: async (room, user) => {
          if (user === grace.userId) sweeps += 1;
          const role = memberships.get(membershipKey(room, user));
          return role ? { role } : null;
        },
      }),
    );

    const metronome = await connect('grace');
    send(metronome, { type: 'command', command: 'room.join', roomId });
    await nextFrame(metronome, 'joined');

    const socket = await connect('ada');
    send(socket, { type: 'command', command: 'room.join', roomId });
    // ada's very first command already fails to verify, which is what arms the
    // back-off — the sweep is then the only thing that could re-ask.
    await nextFrame(socket, 'error');
    expect(adaLookups).toBe(1);

    const before = sweeps;
    await vi.waitFor(() => {
      expect(sweeps).toBeGreaterThanOrEqual(before + 4);
    });
    expect(adaLookups).toBe(1);
    expect(socket.readyState).toBe(socket.OPEN);
    socket.close();
    metronome.close();
  });

  /**
   * A `room.join` that was already past both of its checks when the revocation
   * landed must not put the socket back on the roster it was just taken off.
   *
   * Round 3's gauntlet listed this as polish; the visible consequence is stale
   * presence — a room showing somebody who is on their way out for the whole
   * close handshake.
   *
   * Catches: removing the `connection.revoked || readyState !== OPEN` re-check
   * from the `room.join` branch of `handleCommand`.
   */
  it('does not re-add a socket that was revoked while its join was in flight', async () => {
    const gate = deferred<{ role: string } | null>();
    await server.close();
    await listen(
      startServer({
        sweepIntervalMs: 15,
        revalidateTtlMs: 60_000,
        revalidateSession: async (headers: Headers) => {
          const who = headers.get('cookie')?.replace('who=', '') ?? '';
          return sessions.get(who) ?? null;
        },
        loadRoomMembership: async (room, user) => {
          if (room === otherRoomId) return gate.promise;
          const role = memberships.get(membershipKey(room, user));
          return role ? { role } : null;
        },
      }),
    );

    memberships.set(membershipKey(otherRoomId, ada.userId), 'member');
    const socket = await connect('ada');
    send(socket, { type: 'command', command: 'room.join', roomId });
    await nextFrame(socket, 'joined');
    expect(server.presence(roomId)).toHaveLength(1);

    // The close must not finish before the in-flight join resumes, or the
    // connection is gone and the branch under test is unreachable.
    pauseReads(socket);

    // A join whose membership lookup hangs.
    const frames = countServerFrames();
    send(socket, { type: 'command', command: 'room.join', roomId: otherRoomId });
    await vi.waitFor(() => {
      expect(frames.seen()).toBe(1);
    });

    // …and while it hangs, the socket loses its session and the sweep revokes.
    memberships.delete(membershipKey(roomId, ada.userId));
    await vi.waitFor(() => {
      expect(server.presence(roomId)).toHaveLength(0);
    });

    // Now let the join finish. It was authorized when it started, and it is
    // resuming into a connection that has since been revoked.
    gate.resolve({ role: 'member' });
    // The handler's continuation is a microtask chained off that promise and
    // everything after the await is synchronous, so one turn of the macrotask
    // queue is strictly more than it needs. A drain, not a sleep — the server
    // is running in this process.
    await new Promise((resolve) => setImmediate(resolve));

    expect(server.presence(otherRoomId)).toHaveLength(0);
    expect(server.presence(roomId)).toHaveLength(0);

    resumeReads(socket);
    socket.terminate();
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
