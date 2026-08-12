import { randomUUID } from 'node:crypto';
import {
  createAtriumAuth,
  getAtriumSession,
  mintAgentSession,
  provisionAgentPrincipal,
  sessionCookieHeader,
} from '@atrium/auth';
import type { DatabaseHandle } from '@atrium/db';
import {
  acceptedObjects,
  coreEvents,
  memberships,
  messages,
  users,
  workspaceMembers,
} from '@atrium/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CommandInput } from '../../apps/server/src/commands.js';
import { createLogger } from '../../apps/server/src/logger.js';
import { createUpgradeAuthenticator } from '../../apps/server/src/ws-auth.js';
import {
  openDatabase,
  resetDatabase,
  type SeededRoom,
  seedRoom,
  startTestServer,
  TestClient,
  type TestServer,
} from '../support/harness.js';

/**
 * An agent principal, end to end: identity → session → `actorOf` → ledger → core.
 *
 * ## What this file is for, and why none of it is a unit test
 *
 * The claim under test spans four layers and is false if any one of them drops
 * it: a `users` row says what sort of participant it is, Better Auth carries
 * that onto the session it resolves from a cookie, the command layer derives the
 * trusted `Actor` from that session, the ledger writes it into two columns, and
 * the reducer decides every certification gate from the discriminant that came
 * out the far end. A double at any joint would make the test agree with itself.
 *
 * So: the real Better Auth instance over the real test database, a session
 * minted by the library's own adapter and presented as the library's own signed
 * cookie, the real upgrade authenticator, the real server, a real socket, and
 * assertions read from `core_events` rather than from what a command returned.
 * **A verdict is a claim; the fold is the fact.**
 *
 * ## The four questions, and why the third one is the ticket
 *
 *  1. An agent principal is provisioned, holds a session, is a room member, and
 *     posts — and its event lands with a non-human `actor_kind` carrying its own
 *     `userId`.
 *  2. **Flip the input.** The same frames, from a person's session, land
 *     `actor_kind = 'human'`. Without this, an implementation that stamped every
 *     row `agent` would pass (1) exactly as well.
 *  3. A certify attempt from the agent's session is refused by core's existing
 *     gates. This is the one #90 is about: `kind: 'human'` has always meant
 *     "authenticated account", and the whole risk of giving an agent an account
 *     is that every `isHuman` gate goes blind. The gates are not modified by this
 *     ticket; what changes is that they now have a *session-borne* non-human to
 *     refuse rather than only an in-process worker.
 *  4. The database refuses a session that lies about its own kind. Layers 2–4
 *     are application code, and the honest question about an interlock is what
 *     happens when one of its layers is wrong.
 */

const logger = createLogger('error');
const APP_URL = 'http://localhost:3000';
const AUTH_SECRET = 'an-integration-secret-long-enough-for-better-auth-00';

let handle: DatabaseHandle;
let server: TestServer;
let room: SeededRoom;
let auth: ReturnType<typeof createAtriumAuth>;
const open: TestClient[] = [];

/**
 * The real Better Auth configuration, over the real database.
 *
 * `createAtriumAuth` is the same function both processes call in production —
 * there is deliberately only one, so a second configuration cannot become a
 * second definition of a valid session. Building it here rather than stubbing it
 * is what makes "the principal kind rides on the session" a measurement instead
 * of a restatement.
 */
function buildAuth(database: DatabaseHandle) {
  return createAtriumAuth({
    db: database.db,
    baseURL: APP_URL,
    secret: AUTH_SECRET,
    // A no-op transport: nothing here sends mail, and `resolveMailer` refuses to
    // boot in production without a real one rather than printing links to a log.
    mailer: async () => {},
  });
}

/** Everything a provisioned participant needs to be in this room. */
async function admit(userId: string): Promise<void> {
  await handle.db
    .insert(workspaceMembers)
    .values({ organizationId: room.workspaceId, userId, role: 'member' });
  await handle.db.insert(memberships).values({ roomId: room.roomId, userId, role: 'member' });
}

/** A socket carrying a real session cookie, exactly as a browser would. */
async function connectWithCookie(userId: string, cookie: string): Promise<TestClient> {
  const client = await TestClient.connect(server.url, userId, { headers: { cookie } });
  open.push(client);
  return client;
}

/** The trusted actor columns of every row this room holds, in ledger order. */
async function actorRows(): Promise<{ kind: string; id: string | null; type: string }[]> {
  const rows = await handle.db
    .select({
      kind: coreEvents.actorKind,
      id: coreEvents.actorId,
      type: coreEvents.type,
      seq: coreEvents.seq,
    })
    .from(coreEvents)
    .where(eq(coreEvents.roomId, room.roomId))
    .orderBy(coreEvents.seq);
  return rows.map(({ kind, id, type }) => ({ kind, id, type }));
}

const issuesOf = (ack: { type: string; issues?: string[] }) =>
  ack.type === 'ack' ? (ack.issues ?? []) : ['NACK'];

/**
 * Everything a postgres rejection said, including what it said underneath.
 *
 * Drizzle wraps a driver error and its own `message` is "Failed query: …", so a
 * `toThrow(/…/)` against the top-level message can only ever match SQL text. The
 * RAISE message and the `CONSTRAINT` name — the two things that say *which*
 * refusal this is — live on the cause. A test that could not see them would pass
 * for a syntax error as readily as for the rule it names.
 */
function describeDatabaseError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth += 1) {
    const record = current as { message?: unknown; constraint_name?: unknown; cause?: unknown };
    if (typeof record.message === 'string') parts.push(record.message);
    if (typeof record.constraint_name === 'string') parts.push(record.constraint_name);
    current = record.cause;
  }
  return parts.join(' | ');
}

beforeAll(() => {
  handle = openDatabase(10);
  auth = buildAuth(handle);
});

beforeEach(async () => {
  await resetDatabase(handle);
  room = await seedRoom(handle, ['ada']);
  server = await startTestServer(handle, {
    // The real seam. Every other integration suite uses the stub, because their
    // questions are not about who is connected; this one's is.
    session: { authenticateUpgrade: createUpgradeAuthenticator({ auth, logger }) },
  });
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()));
  await server?.close();
});

afterAll(async () => {
  await handle?.close();
});

/** Provision an agent, admit it to the room, and give it a real session cookie. */
async function agentInTheRoom(name = 'scribe') {
  const principal = await provisionAgentPrincipal({
    db: handle.db,
    email: `${name}-${randomUUID()}@agents.invalid`,
    displayName: name,
  });
  await admit(principal.userId);
  const session = await mintAgentSession({ auth, db: handle.db, userId: principal.userId });
  return { ...principal, session };
}

/** A person, admitted the same way, holding a session minted the same way. */
async function personInTheRoom(name = 'grace') {
  const [row] = await handle.db
    .insert(users)
    .values({
      email: `${name}-${randomUUID()}@example.test`,
      displayName: name,
      emailVerified: true,
    })
    .returning({ id: users.id });
  const userId = (row as { id: string }).id;
  await admit(userId);
  /**
   * Minted through Better Auth's adapter and presented with Better Auth's own
   * cookie construction, exactly as `mintAgentSession` does — the only
   * difference between the two sessions in this file is the identity they belong
   * to, which is the whole point of the flip test.
   *
   * `mintAgentSession` refuses a person by design, so this stands in for the
   * sign-in a person would do. That it has to be written out here rather than
   * called is the refusal working: there is no shipped function that hands out a
   * session for an arbitrary user id.
   */
  const context = await auth.$context;
  const created = await context.internalAdapter.createSession(userId, false);
  return { userId, session: { cookie: await sessionCookieHeader(auth, created.token) } };
}

describe('an agent principal, from provisioning to the ledger', () => {
  it('is an identity of a stated kind, with no credential to sign in with', async () => {
    const agent = await agentInTheRoom();

    const [row] = await handle.db
      .select({ kind: users.principalKind, verified: users.emailVerified })
      .from(users)
      .where(eq(users.id, agent.userId));
    expect(row).toEqual({ kind: 'agent', verified: true });

    // No password row and no OAuth row. Even if `/sign-in/email` were mounted —
    // it is not — there is nothing here to authenticate against. This is the
    // third of the three independent reasons provisioning is programmatic, and
    // the only one that is a property of the data rather than of a config list.
    const accounts = await handle.db.execute(
      `SELECT count(*)::int AS n FROM auth_accounts WHERE user_id = '${agent.userId}'`,
    );
    expect((accounts as unknown as { n: number }[])[0]?.n).toBe(0);
  });

  it('holds a real session that Better Auth resolves as a non-human principal', async () => {
    const agent = await agentInTheRoom();

    // Read back through the library, from the cookie, by the same function the
    // WebSocket upgrade and every web page call. Catches: minting a row that no
    // real code path would accept, which is what a hand-built session would be.
    const resolved = await getAtriumSession(auth, new Headers({ cookie: agent.session.cookie }));
    expect(resolved).toMatchObject({
      userId: agent.userId,
      principalKind: 'agent',
      emailVerified: true,
    });
  });

  it('refuses to mint a session for a person — this is not a sign-in bypass', async () => {
    // The helper reads `principal_kind` off the row rather than trusting a
    // parameter, and the column is immutable, so what it permits is a property of
    // the identity. Catches: relaxing the check to a caller-supplied flag, which
    // would turn a provisioning helper into "log in as anyone".
    const person = await personInTheRoom();
    await expect(mintAgentSession({ auth, db: handle.db, userId: person.userId })).rejects.toThrow(
      /is a human principal/,
    );
  });

  it('joins a room as a member and posts, and its event lands as a non-human with its own id', async () => {
    const agent = await agentInTheRoom();
    const client = await connectWithCookie(agent.userId, agent.session.cookie);
    await client.subscribe(room.roomId);

    const ack = await client.command({
      name: 'send_message',
      roomId: room.roomId,
      body: 'I read the last twelve messages and nothing was settled.',
    } as CommandInput);
    expect(issuesOf(ack)).toEqual([]);

    // THE FOLD, not the ack. Both halves of the acceptance in one assertion:
    // the kind is not `human`, and the id is the agent's own — which is what
    // makes it a participant rather than an anonymous writer.
    expect(await actorRows()).toEqual([
      { kind: 'agent', id: agent.userId, type: 'message_posted' },
    ]);

    // And the membership was real, not waived: the append boundary reads
    // `memberships` under the lock for an agent exactly as it does for a person.
    const held = await handle.db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.roomId, room.roomId), eq(memberships.userId, agent.userId)));
    expect(held).toHaveLength(1);
  });

  it('lands actor_kind = human for the same frames from a person’s session', async () => {
    /**
     * The flip, and it is the assertion that makes the one above mean anything.
     *
     * An implementation that stamped every row `agent`, or that read the kind off
     * something other than the identity, passes the previous test perfectly. The
     * only difference between these two runs is whose cookie opened the socket:
     * same server, same room, same command, same body.
     *
     * Catches: `actorOf` returning a literal of either kind.
     */
    const person = await personInTheRoom();
    const client = await connectWithCookie(person.userId, person.session.cookie);
    await client.subscribe(room.roomId);

    const ack = await client.command({
      name: 'send_message',
      roomId: room.roomId,
      body: 'I read the last twelve messages and nothing was settled.',
    } as CommandInput);
    expect(issuesOf(ack)).toEqual([]);

    expect(await actorRows()).toEqual([
      { kind: 'human', id: person.userId, type: 'message_posted' },
    ]);
  });

  it('leaves an agent’s message unattributed in the read model, on purpose and not by accident', async () => {
    /**
     * A deliberate deferral, pinned so it cannot become a silent one.
     *
     * `projectMessagePosted` writes `humanId(actor)`, which is NULL for an agent,
     * so an agent's message row carries no author. Filling it in is the front
     * half of a change whose back half is a voice register — AGENTS.md's "no
     * synthesized speech" rule — and the feed's attribution cell has no kind to
     * read yet. Half of that change renders an agent's sentences as a
     * participant's typed words with nothing to distinguish them, which is a
     * worse falsehood than an unattributed row.
     *
     * This test exists to fail when somebody lands the front half alone. It is
     * not asserting that NULL is right; it is asserting that the current state is
     * the one that was chosen, and that the ledger row — which does carry the
     * agent's id — is where attribution actually lives meanwhile.
     */
    const agent = await agentInTheRoom();
    const client = await connectWithCookie(agent.userId, agent.session.cookie);
    await client.subscribe(room.roomId);
    await client.command({
      name: 'send_message',
      roomId: room.roomId,
      body: 'A note from the scribe.',
    } as CommandInput);

    const [row] = await handle.db
      .select({ authorId: messages.authorId })
      .from(messages)
      .where(eq(messages.roomId, room.roomId));
    expect(row?.authorId).toBeNull();
    expect((await actorRows())[0]?.id).toBe(agent.userId);
  });
});

describe('the certify boundary, against a session-borne non-human', () => {
  it('refuses an agent’s acceptance of a person’s decision proposal, and writes nothing', async () => {
    /**
     * The gate that matters, exercised from a socket for the first time.
     *
     * Until an agent could hold a session, `reduce.ts`'s ten `isHuman` gates were
     * only ever reached by the in-process interpret worker, which has no session
     * and no membership. This is the same gate, asked by an authenticated,
     * subscribed, fully provisioned room member that happens not to be a person —
     * which is the configuration #90 calls campaign-stopping if it is wrong.
     *
     * Judged on `accepted_objects` and on the ack's `issues`, in that order: the
     * refusal convention here is an `ack` with a non-empty `issues` array, so a
     * test that read only the frame type would call this a success.
     */
    const agent = await agentInTheRoom();
    const person = await personInTheRoom();

    const human = await connectWithCookie(person.userId, person.session.cookie);
    await human.subscribe(room.roomId);
    const staged = await human.command({
      name: 'record_proposal',
      roomId: room.roomId,
      proposal: {
        type: 'decision',
        payload: { statement: 'We ship behind a flag.', decidedBy: person.userId },
        confidence: 1,
        provenance: [],
        quote: null,
        interpretationId: null,
      },
    } as unknown as CommandInput);
    expect(issuesOf(staged)).toEqual([]);

    const [recorded] = await handle.db
      .select({ payload: coreEvents.payload })
      .from(coreEvents)
      .where(and(eq(coreEvents.roomId, room.roomId), eq(coreEvents.type, 'proposal_recorded')));
    // Read out of the LEDGER rather than out of the ack: the id the agent will
    // cite has to be the one the room holds, and an ack is a claim about that.
    const proposalId = (recorded as { payload: { proposal: { id: string } } }).payload.proposal.id;

    const scribe = await connectWithCookie(agent.userId, agent.session.cookie);
    await scribe.subscribe(room.roomId);
    const attempt = await scribe.command({
      name: 'accept_proposal',
      roomId: room.roomId,
      proposalId,
    } as CommandInput);

    // The fold first: nothing was certified.
    expect(await handle.db.select().from(acceptedObjects)).toEqual([]);

    // Then the reason, which must be the humanity gate rather than a membership
    // miss or a malformed frame — an agent IS a member, and this refusal has to
    // come from what it is, not from where it is.
    const issues = issuesOf(attempt);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('a decision never auto-accepts');
    expect(issues[0]).toContain('an agent actor');
  });

  it('refuses an agent’s attempt to stage a proposal rather than recording it as a person’s', async () => {
    // `Proposer` is `human | model` and has no agent variant, so the two moves
    // available were to write an agent's reading down as a human's — the r9
    // defect with a new author — or to refuse it. It refuses, by name.
    //
    // Catches: `draftToProposal` going back to an unconditional
    // `{ kind: 'human', userId: session.userId }`, which would put a machine's
    // reading into the room wearing a member's name and skipping the receipt gate
    // a human acceptance skips.
    const agent = await agentInTheRoom();
    const scribe = await connectWithCookie(agent.userId, agent.session.cookie);
    await scribe.subscribe(room.roomId);

    const attempt = await scribe.command({
      name: 'record_proposal',
      roomId: room.roomId,
      proposal: {
        type: 'claim',
        payload: {
          statement: 'The flag is off in production.',
          claimant: room.people.ada as string,
          verification: 'unverified',
        },
        confidence: 1,
        provenance: [],
        quote: null,
        interpretationId: null,
      },
    } as unknown as CommandInput);

    expect(attempt.type).toBe('nack');
    expect(JSON.stringify(attempt)).toContain('may not stage a proposal');
    expect((await actorRows()).filter((row) => row.type === 'proposal_recorded')).toEqual([]);
  });

  it('lets an agent do everything a member does that is not certification', async () => {
    // The other half of the boundary, and the half a gate-only test would miss:
    // "refuses an agent" is trivially satisfiable by refusing an agent
    // everything, and that product is not the one this ticket describes. An agent
    // is a participant; it is only certification that it may not do.
    const agent = await agentInTheRoom();
    const client = await connectWithCookie(agent.userId, agent.session.cookie);
    await client.subscribe(room.roomId);

    for (const command of [
      { name: 'send_message', roomId: room.roomId, body: 'first' },
      { name: 'set_presence', roomId: room.roomId, state: 'online' },
      { name: 'set_typing', roomId: room.roomId, typing: true },
    ] as CommandInput[]) {
      const ack = await client.command(command);
      expect(issuesOf(ack), `${command.name} should be open to an agent`).toEqual([]);
    }
  });
});

describe('the database does not take the application’s word for the kind', () => {
  it('refuses an append whose actor_kind disagrees with the identity’s principal_kind', async () => {
    /**
     * The fourth layer, measured rather than assumed.
     *
     * Session → `actorOf` → ledger are three layers of application code, and the
     * honest question about an interlock is what happens when one of them is
     * wrong. Here one of them is *made* wrong: the socket authenticates through
     * the stub with `?principal=human` over an agent's user id, which is exactly
     * the shape of a regression in `actorOf` or in `getAtriumSession` — a session
     * that says "person" for a machine.
     *
     * The append is refused by `atrium_core_events_invariants`, which reads
     * `users.principal_kind` for the id in `actor_id` and will not store a row
     * that contradicts it. So the failure mode of the whole interlock is a loud
     * refusal and an empty ledger, not durable history that every `isHuman` gate
     * downstream reads as a person's.
     *
     * Catches: deleting the agreement check from the trigger. Nothing else in
     * this repository would notice — every application path derives the kind
     * correctly, which is precisely why the check has to be tested by breaking
     * the application path on purpose.
     */
    const agent = await agentInTheRoom();

    // A second server, on the stub seam, so the lie can be told at all.
    const lying = await startTestServer(handle);
    try {
      const client = await TestClient.connect(lying.url, agent.userId, {
        principalKind: 'human',
      });
      open.push(client);
      await client.subscribe(room.roomId);

      const attempt = await client.command({
        name: 'send_message',
        roomId: room.roomId,
        body: 'attributed to a person who does not exist',
      } as CommandInput);

      expect(attempt.type).toBe('nack');
      expect(await actorRows()).toEqual([]);
    } finally {
      await lying.close();
    }
  });

  it('refuses the reverse lie too — a person’s session claiming to be an agent', async () => {
    // Symmetry is not decoration here. A one-directional check would leave "mark
    // a person's history as a machine's" open, which launders a member's
    // judgement into something the room reads as a draft.
    const person = await personInTheRoom();

    const lying = await startTestServer(handle);
    try {
      const client = await TestClient.connect(lying.url, person.userId, {
        principalKind: 'agent',
      });
      open.push(client);
      await client.subscribe(room.roomId);

      const attempt = await client.command({
        name: 'send_message',
        roomId: room.roomId,
        body: 'a person, filed as a machine',
      } as CommandInput);

      expect(attempt.type).toBe('nack');
      expect(await actorRows()).toEqual([]);
    } finally {
      await lying.close();
    }
  });

  it('refuses to change what an identity is, once it has one', async () => {
    // The immutability the agreement check rests on. Without it, "this agent
    // should have been a person" is a one-column UPDATE that silently re-reads
    // every row the identity ever appended as the other sort of participant — and
    // makes the trigger start refusing appends for a reason nobody can find.
    const agent = await agentInTheRoom();
    // Read off the driver's own error rather than Drizzle's wrapper: the wrapper
    // says only "failed query", and a test that matched on that would pass for a
    // syntax error, a dead connection, or a constraint nobody meant to hit. The
    // named CONSTRAINT is what says this refusal is the one under test.
    const refusal = await handle.db
      .update(users)
      .set({ principalKind: 'human' })
      .where(eq(users.id, agent.userId))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(refusal, 'the update must be refused, not silently applied').not.toBeNull();
    expect(describeDatabaseError(refusal)).toMatch(/users_principal_kind_immutable/);
    expect(describeDatabaseError(refusal)).toMatch(/may not become a/);

    // An unrelated update to the same row still works: the trigger refuses a
    // change to this column, not writes to the identity.
    await handle.db
      .update(users)
      .set({ displayName: 'scribe mk ii' })
      .where(eq(users.id, agent.userId));
    const [row] = await handle.db
      .select({ name: users.displayName, kind: users.principalKind })
      .from(users)
      .where(eq(users.id, agent.userId));
    expect(row).toEqual({ name: 'scribe mk ii', kind: 'agent' });
  });

  it('leaves the anonymous kinds exactly where 0004 left them — no identity to look up', async () => {
    /**
     * The half of 0004's invariant that survives, and the half of 0017 that must
     * NOT have leaked onto it.
     *
     * A `model` actor is named by a model string and a `system` actor by nothing.
     * Neither has a `users` row, so neither can be looked up, hold a membership,
     * or be checked for agreement — 0017 widened the membership rule to the kinds
     * that carry an IDENTITY, not to the kinds that are non-human, and the room
     * check for these two is still the EXECUTE grant.
     *
     * Catches: scoping the new block to `actor_kind <> 'system'`, or to "not
     * human", either of which would send a model id into `users."id" = …::uuid`
     * and turn the interpret worker's every append into a cast error.
     */
    // A real message for the reading to rest on, posted by a person over a real
    // socket — a model proposal must cite one and quote it, and a fixture that
    // dodged that would be exercising a shape the worker never produces.
    const person = await personInTheRoom();
    const human = await connectWithCookie(person.userId, person.session.cookie);
    await human.subscribe(room.roomId);
    const body = 'The flag is off in production.';
    await human.command({ name: 'send_message', roomId: room.roomId, body } as CommandInput);
    const [posted] = await handle.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.roomId, room.roomId));
    const messageId = (posted as { id: string }).id;

    const appended = await server.ledger.append({
      roomId: room.roomId,
      actor: { kind: 'model', model: 'claude-opus-4.6' },
      build: ({ id, at }) => ({
        id,
        at,
        type: 'proposal_recorded',
        proposal: {
          id: randomUUID(),
          roomId: room.roomId,
          type: 'claim',
          payload: {
            statement: body,
            claimant: person.userId,
            verification: 'unverified',
          },
          confidence: 0.9,
          proposer: { kind: 'model', model: 'claude-opus-4.6' },
          provenance: [messageId],
          quote: body,
          interpretationId: null,
          status: 'proposed',
          createdAt: at,
        },
      }),
      project: async () => {},
    });
    expect(appended.issues).toEqual([]);

    // The row is there, named by the model string, with no membership anywhere —
    // which is the unchanged behaviour, measured rather than assumed.
    expect((await actorRows()).at(-1)).toEqual({
      kind: 'model',
      id: 'claude-opus-4.6',
      type: 'proposal_recorded',
    });
    const held = await handle.db.select().from(memberships);
    expect(held.map((row) => row.userId)).not.toContain('claude-opus-4.6');
  });

  it('refuses an agent that is not a member, and one that is not an identity at all', async () => {
    // The widening, from the other side. An agent is checked for membership
    // exactly as a person is — the rule is about carrying an identity, not about
    // being a person — so an unadmitted agent gets the same refusal an unadmitted
    // person gets, and an `agent` actor naming no user at all gets the
    // identity-resolution refusal.
    //
    // Catches: `IN ('human', 'agent')` narrowed back to `= 'human'`, which would
    // let any agent append into any room it had never joined.
    const stranger = await provisionAgentPrincipal({
      db: handle.db,
      email: `stranger-${randomUUID()}@agents.invalid`,
      displayName: 'stranger',
    });

    for (const [actor, expected] of [
      [{ kind: 'agent', userId: stranger.userId } as const, /holds no membership in room/],
      [{ kind: 'agent', userId: randomUUID() } as const, /is not an identity in this database/],
    ] as const) {
      const refusal = await server.ledger
        .append({
          roomId: room.roomId,
          actor,
          build: ({ id, at }) => ({
            id,
            at,
            type: 'message_posted',
            roomId: room.roomId,
            messageId: randomUUID(),
            body: 'from outside the room',
            replyToId: null,
            clientMessageId: null,
            attachments: [],
            references: [],
          }),
          project: async () => {},
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(refusal, `${JSON.stringify(actor)} must be refused`).not.toBeNull();
      expect(describeDatabaseError(refusal)).toMatch(expected);
    }

    expect(await actorRows()).toEqual([]);
  });
});
