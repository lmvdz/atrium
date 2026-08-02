import type { IncomingMessage } from 'node:http';
import type { AtriumSession, MembershipLike } from '@atrium/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createLogger } from '../src/logger.js';
import type { ServerFrame } from '../src/ws-presence-server.js';
import { createRealtimeServer } from '../src/ws-presence-server.js';

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

/**
 * A rejection value that punishes anyone who reads it.
 *
 * This is the round-8-delta shape, and the reason it is a *getter* rather than
 * an exotic prototype matters: `(error as Error).message` looks like a field
 * access and is arbitrary code. Round 8 hardened `packages/auth`'s cleanup
 * reporter against `Object.create(null)` and a throwing `Symbol.toPrimitive`,
 * and the realtime sweep two files away still read `.message` straight off the
 * value while building its log fields — before it had incremented anything.
 *
 * Real, not contrived: a driver that wraps a protocol error in a lazily-decoded
 * object, an ORM that reconstructs `message` from a response it has not read
 * yet, a Proxy in a test double. `stack` is a trap too, because a logger that
 * survives `message` usually reaches for `stack` next.
 */
function unreadableRejection(): unknown {
  return {
    get message(): string {
      throw new Error('reading this rejection is itself a failure');
    },
    get stack(): string {
      throw new Error('and so is reading its stack');
    },
  };
}

/**
 * Watch for unhandled rejections while `run` is in flight.
 *
 * `apps/server/src/index.ts` calls `process.exit(1)` on one, by design — so in
 * production an unhandled rejection is not a log line, it is a restart. A test
 * that only checked "the socket eventually closed" would miss that entirely.
 */
async function withUnhandledRejectionWatch(run: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const listen = (reason: unknown) => seen.push(reason);
  process.on('unhandledRejection', listen);
  try {
    await run();
    // Node decides a rejection is unhandled at a microtask checkpoint on a later
    // turn than the one that created it, so this is a real timer rather than an
    // `await Promise.resolve()` that would run too early to see anything.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    process.off('unhandledRejection', listen);
  }
  return seen;
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
    /**
     * The TTL is 120ms and the ceiling below is two of those plus an allowance,
     * not the 2s this carried through round 8. **"At most one TTL" is a bound**,
     * and a ceiling fifty times the value under test would have passed against a
     * TTL of a second and a half — proving the cache expires eventually, which
     * is not what the name of this test claims. Swept in round 9 along with the
     * two the delta named; the rule is that slack is small next to the number
     * being measured.
     */
    const revalidateTtlMs = 120;
    let valid = true;
    await server.close();
    await listen(
      startServer({
        revalidateTtlMs,
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
      { timeout: revalidateTtlMs * 2 + 120, interval: 10 },
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
    /**
     * Same round-9 sweep as the TTL test: the back-off is the number under test,
     * so the ceiling is two of it plus an allowance rather than a flat 2s. At
     * 30ms against 2s this passed against a back-off two orders of magnitude
     * wider than the one configured.
     */
    const revalidateBackoffMs = 120;
    let failing = true;
    const revalidateSession = vi.fn(async () => {
      if (failing) throw new Error('database is on fire');
      return ada;
    });
    await server.close();
    await listen(startServer({ revalidateTtlMs: 0, revalidateBackoffMs, revalidateSession }));

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
      { timeout: revalidateBackoffMs * 2 + 120, interval: 20 },
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

  /**
   * The accepted bound — and, since the round-7 delta, an actual ceiling.
   *
   * `broadcastPresence` fans out to the roster without re-asking membership per
   * recipient, so a socket that joined before its owner was removed keeps
   * receiving that room's presence frames until the sweep notices. Round 6
   * accepted 15s on the strength of a paragraph and round 7 wrote the paragraph
   * down; the delta showed the number was a description of the default
   * configuration rather than a guarantee, because a hung membership lookup held
   * the `sweeping` latch and every later interval was skipped.
   *
   * **What round 7's test measured, and did not.** It installed a 60s interval
   * so nothing would sweep, then evicted the socket by *sending a command* — so
   * it measured the command path, which was never the thing in doubt, and left
   * the advertised window untested. The three tests below measure the window
   * itself, with a clock, and fail when it is exceeded.
   */
  it('leaks presence but never command authority, inside the window', async () => {
    // The default 60s sweep from `startServer` holds the window open, which is
    // what makes the leak observable at all. What is asserted here is the
    // *content* of the window — that is all this test is for; the two below
    // measure its length.
    const removed = await connect('ada');
    send(removed, { type: 'command', command: 'room.join', roomId });
    await nextFrame(removed, 'joined');
    await nextFrame(removed, 'presence');

    // What `beforeRemoveMember` does to the database, mid-connection. This
    // socket sends nothing, so only the sweep could notice — and it will not.
    memberships.delete(membershipKey(roomId, ada.userId));

    const staying = await connect('grace');
    send(staying, { type: 'command', command: 'room.join', roomId });
    await nextFrame(staying, 'joined');

    /**
     * The leak, named. Catches: an eviction signal landing here (#27) without
     * this comment and the README paragraph being updated — this test then fails
     * and says the accepted bound is no longer the behaviour, which is the point
     * of writing an accepted limit down as an assertion instead of a sentence.
     */
    const leaked = await nextFrame(removed, 'presence');
    expect(leaked.roomId).toBe(roomId);
    expect(leaked.members).toHaveLength(2);

    /**
     * And the half that makes it acceptable: authority is already gone. Catches
     * any change that lets a removed member's command through on the strength of
     * still being on the roster — which is what the leak would otherwise imply.
     */
    send(removed, { type: 'command', command: 'room.rename', roomId, name: 'mine now' });
    const denial = await nextFrame(removed, 'command_error');
    expect(denial.reason).toBe('not_a_member');

    staying.close();
    removed.close();
  });

  it('closes the presence window within one sweep interval, measured', async () => {
    /**
     * The first half of the ceiling: when the membership lookup answers, the
     * window is one sweep interval. Measured with a clock rather than described,
     * and the removed socket sends **nothing** — no command-driven eviction is
     * allowed to stand in for the sweep, which is what round 7's version did.
     *
     * Catches: deleting the membership loop from `sweepConnections`, and any
     * change that widens the window without widening the advertised bound — the
     * `widen-sweep-window` mutation in `scripts/mutation-ledger.mjs` sweeps four
     * times less often, still evicts, and fails here.
     *
     * **The interval is 150ms and not 40ms because of that mutation.** The first
     * draft used 40ms with 250ms of scheduling slack, which is four intervals of
     * slack — it passed against a sweep running a quarter as often, and was
     * therefore measuring "it closed eventually", the very thing round 7's
     * version was faulted for. The slack has to be small next to the interval,
     * not next to the test.
     */
    const sweepIntervalMs = 150;
    await server.close();
    await listen(startServer({ sweepIntervalMs }));

    const removed = await connect('ada');
    send(removed, { type: 'command', command: 'room.join', roomId });
    await nextFrame(removed, 'joined');
    await nextFrame(removed, 'presence');

    const staying = await connect('grace');
    send(staying, { type: 'command', command: 'room.join', roomId });
    await nextFrame(staying, 'joined');
    await nextFrame(removed, 'presence');

    const closed = new Promise<number>((resolve) => removed.once('close', resolve));
    const removedAt = Date.now();
    memberships.delete(membershipKey(roomId, ada.userId));

    expect(await closed).toBe(1008);
    const window = Date.now() - removedAt;
    expect(server.presence(roomId)).toEqual([{ userId: grace.userId, displayName: 'grace' }]);

    /**
     * Two intervals, not one. The removal can land a hair after a sweep has
     * already read this connection, so the sweep that notices is the *next* one
     * — that is inherent to a polling bound and is why the README says "up to".
     * Anything beyond two intervals is the bound failing, not the schedule.
     */
    expect(window).toBeLessThan(sweepIntervalMs * 2 + 120);
    staying.close();
  });

  it('closes the window on a bound even when the membership lookup never answers', async () => {
    /**
     * The second half of the ceiling, and the one that was not there.
     *
     * Round 7 awaited `loadRoomMembership` with no deadline behind a `sweeping`
     * latch cleared in a `finally`. A lookup that never settles never reaches
     * that `finally`, so the latch stayed held and every later interval returned
     * at `if (sweeping) return` — presence to a removed member persisted for as
     * long as the query stayed wedged, which is to say indefinitely.
     *
     * **Verified against `fix/auth-r7`: this test hangs until vitest times it
     * out.** Against r8 the hung lookup is a sweep failure like any other, so
     * the socket is closed after `sweepFailureLimit` sweeps — bounded, and the
     * bound is measured here rather than asserted.
     *
     * Catches: removing `withLookupDeadline` from the membership await, and
     * removing the latch's own deadline.
     */
    const sweepIntervalMs = 100;
    const sweepFailureLimit = 3;
    let wedged = false;
    /** Every promise this test refused to settle, so nothing outlives it. */
    const hung: (() => void)[] = [];

    await server.close();
    await listen(
      startServer({
        sweepIntervalMs,
        sweepFailureLimit,
        sweepUnverifiedMs: 300_000,
        loadRoomMembership: async (room, user) => {
          if (wedged && user === ada.userId) {
            // Not slow. Never. A pooled connection that will not come back.
            return new Promise<MembershipLike | null>((resolve) => {
              hung.push(() => resolve(null));
            });
          }
          const role = memberships.get(membershipKey(room, user));
          return role ? { role } : null;
        },
      }),
    );

    const removed = await connect('ada');
    send(removed, { type: 'command', command: 'room.join', roomId });
    await nextFrame(removed, 'joined');

    const closed = new Promise<number>((resolve) => removed.once('close', resolve));
    const wedgedAt = Date.now();
    wedged = true;
    memberships.delete(membershipKey(roomId, ada.userId));

    expect(await closed).toBe(1008);
    const window = Date.now() - wedgedAt;
    expect(server.presence(roomId)).toHaveLength(0);

    /**
     * The stated bound: `sweepFailureLimit` sweeps, each of which cannot start
     * before the previous one's deadline. One interval of slack for the sweep
     * that was already in flight, and 120ms of scheduling allowance — small next
     * to the interval on purpose, so this is an inequality about the bound and
     * not about the machine.
     */
    expect(window).toBeLessThan(sweepIntervalMs * (sweepFailureLimit + 1) + 120);
    for (const settle of hung) settle();
  });

  it('starts the next sweep even while a lookup from the last one is still hanging', async () => {
    /**
     * The mechanism underneath the test above, isolated — because "the socket
     * eventually closed" is also what a single very slow sweep looks like, and
     * the defect was specifically that *later sweeps did not run at all*.
     *
     * grace is the metronome again: her lookups answer immediately, so counting
     * them counts sweeps. ada's hang forever. Against r7 the count stops at one
     * and never moves; against r8 it keeps climbing, because the latch has a
     * deadline of its own and the pass resumes where the last one stopped.
     *
     * **The interval and the wait were both wrong until round 9.** 25ms against
     * a 4s ceiling is 160 intervals of slack: it proved sweeps *happen*, which
     * was never the question, rather than that they happen at the interval. It
     * is the same fault round 8 corrected in the two window tests above and did
     * not carry across the file — so `widen-sweep-window` was green here while
     * being the mutation that exists to catch exactly this. The interval is now
     * large enough that a fixed scheduling allowance is small beside it, and the
     * ceiling is four intervals of work plus that allowance.
     *
     * Catches: reverting the `sweeping` latch to one cleared only in `finally`,
     * and `widen-sweep-window` — the sweep still runs, four times less often.
     */
    const sweepIntervalMs = 100;
    let wedged = false;
    let graceLookups = 0;
    const hung: (() => void)[] = [];

    await server.close();
    await listen(
      startServer({
        sweepIntervalMs,
        sweepFailureLimit: 1_000,
        sweepUnverifiedMs: 300_000,
        loadRoomMembership: async (room, user) => {
          if (wedged && user === ada.userId) {
            return new Promise<MembershipLike | null>((resolve) => {
              hung.push(() => resolve(null));
            });
          }
          if (user === grace.userId) graceLookups += 1;
          const role = memberships.get(membershipKey(room, user));
          return role ? { role } : null;
        },
      }),
    );

    const stuck = await connect('ada');
    send(stuck, { type: 'command', command: 'room.join', roomId });
    await nextFrame(stuck, 'joined');
    const metronome = await connect('grace');
    send(metronome, { type: 'command', command: 'room.join', roomId });
    await nextFrame(metronome, 'joined');

    wedged = true;
    const before = graceLookups;

    // Four further sweeps' worth of the metronome answering, inside four
    // intervals plus a scheduling allowance. Under r7's latch this never
    // arrives, whatever the timeout is set to; under a sweep running four times
    // less often it does not arrive in time either, which is the point.
    await vi.waitFor(
      () => {
        expect(graceLookups).toBeGreaterThanOrEqual(before + 4);
      },
      { timeout: sweepIntervalMs * 4 + 120, interval: 10 },
    );

    expect(stuck.readyState).toBe(stuck.OPEN);
    stuck.close();
    metronome.close();
    for (const settle of hung) settle();
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
 * The round-8 delta's blocking finding, at each site, plus the shape that made
 * it possible in the first place.
 *
 * Round 8 gave the sweep a two-sided guarantee — one interval when the lookup
 * answers, `sweepFailureLimit` sweeps or `sweepUnverifiedMs` when it does not —
 * and then defeated it with its own logging. `(error as Error).message` built
 * into the log fields *before* `recordSweepFailure` meant a rejection carrying a
 * throwing `message` getter threw inside the loop, before any counter moved. The
 * pass was abandoned, the latch released, and the next interval started over
 * with `sweepFailures === 0` — so a removed, silent socket kept receiving
 * presence for as long as the dependency kept rejecting that way. Which is
 * indefinitely. There is no third case in the advertised guarantee, and this was
 * one.
 *
 * Every test below therefore asserts the *bound*, not the eviction: a socket
 * that closes eventually is also what the broken version would do if anything
 * else happened to close it. The window is measured, and the slack is small next
 * to the interval, per the lesson round 8 learned the hard way one item over.
 */
describe('a rejection value nobody can read cannot suspend the sweep', () => {
  it('still evicts within the failure bound when the membership lookup rejects unreadably', async () => {
    /**
     * `ws-server.ts:910` in round 8 — the site the delta named, and the one with
     * the worst consequence, because `checkedEveryRoom` is the only thing
     * between "the lookup failed" and `clearSweepFailures` at the foot of the
     * loop.
     *
     * **Verified against `fix/auth-r8`: this test times out.** The throw comes
     * from the log fields, so the flag is never cleared, `recordSweepFailure` is
     * never reached, the pass unwinds to the outer handler, and every later
     * interval repeats the same abort with the counter still at zero. The socket
     * is never closed and the assertion below waits forever.
     *
     * Catches: moving the `logSafely(...)` call back above
     * `checkedEveryRoom = false`, and reverting `describeUnknown(error)` to
     * `(error as Error).message`. Either alone reproduces the escape — see the
     * `sweep-log-before-counting` and `sweep-reads-error-message` entries in
     * `scripts/mutation-ledger.mjs`.
     */
    const sweepIntervalMs = 100;
    const sweepFailureLimit = 3;
    let wedged = false;

    await server.close();
    await listen(
      startServer({
        sweepIntervalMs,
        sweepFailureLimit,
        sweepUnverifiedMs: 300_000,
        loadRoomMembership: async (room, user) => {
          if (wedged && user === ada.userId) throw unreadableRejection();
          const role = memberships.get(membershipKey(room, user));
          return role ? { role } : null;
        },
      }),
    );

    const removed = await connect('ada');
    send(removed, { type: 'command', command: 'room.join', roomId });
    await nextFrame(removed, 'joined');

    const closed = new Promise<number>((resolve) => removed.once('close', resolve));
    const wedgedAt = Date.now();
    wedged = true;

    const unhandled = await withUnhandledRejectionWatch(async () => {
      expect(await closed).toBe(1008);
    });

    /**
     * The counter advanced, and this is the assertion that says so. Closing
     * within `sweepFailureLimit` sweeps is only possible if each pass recorded a
     * failure against this connection; a version that logs first and counts
     * never — which is round 8 — cannot satisfy an upper bound at all.
     */
    const window = Date.now() - wedgedAt;
    expect(window).toBeLessThan(sweepIntervalMs * (sweepFailureLimit + 1) + 120);
    expect(server.presence(roomId)).toHaveLength(0);

    // And the same value did not take the process down on its way past. Round 8
    // rethrew it out of `sweepConnections` into a `.catch` that read `.message`
    // too, so the chain rejected and `index.ts` would have exited.
    expect(unhandled).toEqual([]);
  });

  it('still evicts within the failure bound when session revalidation rejects unreadably', async () => {
    /**
     * `ws-server.ts:874` in round 8, the sibling site. Same defect, reached
     * through the session store rather than the membership read — and it costs
     * one thing more, because the back-off (`connection.retryAfter`) was armed
     * *after* the format too. Losing it means the sweep re-asks a store that is
     * already failing, every interval, with no negative caching at all.
     *
     * **Verified against `fix/auth-r8`: this test times out**, for the same
     * reason as the one above.
     *
     * `revalidateBackoffMs` is 0 so that each sweep genuinely re-asks and the
     * bound under test is the *failure count* rather than the back-off; with a
     * long back-off the sweep takes the `now < retryAfter` branch, which is a
     * different (also tested) path.
     *
     * Catches: reverting the ordering in the session `catch` of
     * `sweepConnections`, or its `describeUnknown`.
     */
    const sweepIntervalMs = 100;
    const sweepFailureLimit = 3;
    let wedged = false;

    await server.close();
    await listen(
      startServer({
        sweepIntervalMs,
        sweepFailureLimit,
        sweepUnverifiedMs: 300_000,
        revalidateTtlMs: 0,
        revalidateBackoffMs: 0,
        revalidateSession: async (headers: Headers) => {
          const who = headers.get('cookie')?.replace('who=', '') ?? '';
          if (wedged && who === 'ada') throw unreadableRejection();
          return sessions.get(who) ?? null;
        },
      }),
    );

    const removed = await connect('ada');
    send(removed, { type: 'command', command: 'room.join', roomId });
    await nextFrame(removed, 'joined');

    const closed = new Promise<number>((resolve) => removed.once('close', resolve));
    const wedgedAt = Date.now();
    wedged = true;

    const unhandled = await withUnhandledRejectionWatch(async () => {
      expect(await closed).toBe(1008);
    });

    const window = Date.now() - wedgedAt;
    expect(window).toBeLessThan(sweepIntervalMs * (sweepFailureLimit + 1) + 120);
    expect(unhandled).toEqual([]);
  });

  it('keeps sweeping when something inside a pass throws an unreadable value', async () => {
    /**
     * The outer catch, which round 9 made structurally unable to reject.
     *
     * The two tests above close the sites. This one closes the *shape*: whatever
     * escapes `sweepConnections` — today only a logger throwing from `revoke`,
     * tomorrow whatever a future edit adds — must not turn into a rejected
     * promise, because the call is `void`ed and `index.ts` exits the process on
     * an unhandled rejection by design. Round 8's handler read
     * `(error as Error).message` off the escaping value, so a hostile value
     * reaching one lookup was a server restart.
     *
     * `logger.info` is the lever because `revoke` calls it outside every `try`,
     * which makes it the one honest way to get an arbitrary throw out of a pass
     * without editing the source under test. It throws once and then behaves, so
     * the assertion is about recovery rather than about a permanently broken
     * logger.
     *
     * **Against `fix/auth-r8` this test fails on the `unhandled` assertion**: the
     * escaping value is unreadable, so the `.catch` handler throws, the chain
     * rejects, and Node reports it.
     *
     * Catches: deleting the terminal `.catch` from the sweep chain, moving
     * `releaseLatch()` back below the description, or restoring
     * `(error as Error).message` in the outer handler.
     */
    const sweepIntervalMs = 100;
    let throwOnNextRevoke = true;
    let graceLookups = 0;

    await server.close();
    await listen(
      startServer({
        sweepIntervalMs,
        sweepFailureLimit: 1_000,
        sweepUnverifiedMs: 300_000,
        logger: {
          ...logger,
          info: (message: string, fields?: Record<string, unknown>) => {
            if (message === 'revoking socket' && throwOnNextRevoke) {
              throwOnNextRevoke = false;
              throw unreadableRejection();
            }
            logger.info(message, fields);
          },
        },
        loadRoomMembership: async (room, user) => {
          if (user === grace.userId) graceLookups += 1;
          const role = memberships.get(membershipKey(room, user));
          return role ? { role } : null;
        },
      }),
    );

    const doomed = await connect('ada');
    send(doomed, { type: 'command', command: 'room.join', roomId });
    await nextFrame(doomed, 'joined');
    const metronome = await connect('grace');
    send(metronome, { type: 'command', command: 'room.join', roomId });
    await nextFrame(metronome, 'joined');

    const unhandled = await withUnhandledRejectionWatch(async () => {
      // The revocation the sweep is about to attempt is the one whose logging
      // throws, so the pass unwinds from inside `revoke`.
      memberships.delete(membershipKey(roomId, ada.userId));

      const before = graceLookups;
      /**
       * Two further sweeps' worth of the metronome answering, which is the
       * latch releasing and the interval still firing. The slack is one interval
       * — small next to what it measures, so this is an inequality about the
       * sweep and not about the scheduler.
       */
      await vi.waitFor(
        () => {
          expect(graceLookups).toBeGreaterThanOrEqual(before + 2);
        },
        { timeout: sweepIntervalMs * 3 + 120, interval: 10 },
      );
    });

    expect(unhandled).toEqual([]);
    doomed.close();
    metronome.close();
  });

  it('still evicts within the failure bound when the logger itself throws', async () => {
    /**
     * The other half of the guard, and it exists because a mutation found it
     * unmeasured.
     *
     * `describeUnknown` makes the *value* safe to describe. It does nothing
     * about the logger: a transport with a closed socket, or a serializer that
     * chokes on what it is handed, throws from inside `logger.error` — and in
     * round 8 that throw escaped the membership `catch`, unwound the whole
     * connection loop past the `recordSweepFailure` at the bottom of it, and
     * left the counter at zero exactly as the unreadable rejection did.
     *
     * `packages/auth` already had this covered on its own path
     * (`unguard-logger`, 2 of its suite). This is the same property on the
     * realtime path, which round 8 did not carry across.
     *
     * **Found by mutation, not by reading**: `sweep-unguarded-log` — the
     * describer kept, `guardedErrorLog` removed — was green against the suite as
     * first written. A guard nothing fails without is a guard nobody has
     * checked, so it gets this test rather than a sentence.
     *
     * Catches: `sweep-unguarded-log` in `scripts/mutation-ledger.mjs`.
     */
    const sweepIntervalMs = 100;
    const sweepFailureLimit = 3;
    let wedged = false;

    await server.close();
    await listen(
      startServer({
        sweepIntervalMs,
        sweepFailureLimit,
        sweepUnverifiedMs: 300_000,
        logger: {
          ...logger,
          error: (message: string) => {
            if (message === 'membership sweep failed') throw new Error('log transport is gone');
          },
        },
        loadRoomMembership: async (room, user) => {
          if (wedged && user === ada.userId) throw new Error('database is on fire');
          const role = memberships.get(membershipKey(room, user));
          return role ? { role } : null;
        },
      }),
    );

    const removed = await connect('ada');
    send(removed, { type: 'command', command: 'room.join', roomId });
    await nextFrame(removed, 'joined');

    const closed = new Promise<number>((resolve) => removed.once('close', resolve));
    const wedgedAt = Date.now();
    wedged = true;

    const unhandled = await withUnhandledRejectionWatch(async () => {
      expect(await closed).toBe(1008);
    });

    const window = Date.now() - wedgedAt;
    expect(window).toBeLessThan(sweepIntervalMs * (sweepFailureLimit + 1) + 120);
    expect(unhandled).toEqual([]);
  });

  it('answers a command whose membership lookup rejects unreadably', async () => {
    /**
     * The command path, `ws-server.ts:547` in round 8. No counter here — the
     * guarantee is the *reply*: "could not learn whether you are a member" is
     * answered rather than dropped, because telling somebody they are not a
     * member when the truth is that the database did not answer sends them to
     * argue with an admin about permissions they already have.
     *
     * Reading `.message` first threw out of `handleCommand`, out of
     * `handleFrame`, and — since the `message` listener called it
     * fire-and-forget — into an unhandled rejection. The client waited forever
     * for a reply that had become a process exit.
     *
     * **Against `fix/auth-r8` this test times out** waiting for the
     * `command_error` frame, and reports an unhandled rejection.
     *
     * Catches: restoring `(error as Error).message` in `handleCommand`'s catch,
     * and removing the terminal `.catch` on the `handleFrame` call.
     */
    await server.close();
    await listen(
      startServer({
        loadRoomMembership: async () => {
          throw unreadableRejection();
        },
      }),
    );

    const socket = await connect('ada');
    const unhandled = await withUnhandledRejectionWatch(async () => {
      send(socket, { type: 'command', command: 'room.join', roomId });
      const refusal = await nextFrame(socket, 'command_error');
      expect(refusal.reason).toBe('unavailable');
    });

    expect(unhandled).toEqual([]);
    socket.close();
  });

  it('answers a command whose session revalidation rejects unreadably, and arms the back-off', async () => {
    /**
     * `ws-server.ts:700` in round 8. Two things are downstream of the format
     * here and both matter: the refusal frame, and `connection.retryAfter` —
     * the negative cache. Losing the back-off means every frame in a burst
     * re-asks a session store that is already failing, which is the exact
     * hammering round 3 introduced the back-off to stop.
     *
     * The second assertion is what makes this more than a copy of the test
     * above: five frames, one lookup. A version that formats before arming the
     * back-off does five lookups — if it survives the first at all.
     *
     * **Against `fix/auth-r8` this test times out** on the first refusal frame.
     *
     * Catches: moving the `retryAfter` assignment back below the log in
     * `stillAuthenticated`, and restoring `(error as Error).message` there.
     */
    let lookups = 0;
    await server.close();
    await listen(
      startServer({
        revalidateTtlMs: 0,
        revalidateBackoffMs: 10_000,
        // Long enough that the idle sweep cannot be the thing that arms it.
        sweepIntervalMs: 60_000,
        revalidateSession: async () => {
          lookups += 1;
          throw unreadableRejection();
        },
      }),
    );

    const socket = await connect('ada');
    const unhandled = await withUnhandledRejectionWatch(async () => {
      for (let i = 0; i < 5; i += 1) {
        send(socket, { type: 'command', command: 'room.join', roomId });
      }
      await nextFrame(socket, 'error');
    });

    expect(unhandled).toEqual([]);
    // One lookup for five frames: the back-off was armed before anything read
    // the rejection, so the remaining four were refused from the cached verdict.
    expect(lookups).toBe(1);
    socket.close();
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
