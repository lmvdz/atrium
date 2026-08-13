import { randomUUID } from 'node:crypto';
import {
  createAtriumAuth,
  getAtriumSession,
  mintAgentSession,
  provisionAgentConfig,
  provisionAgentPrincipal,
  sessionCookieHeader,
} from '@atrium/auth';
import type { DatabaseHandle } from '@atrium/db';
import {
  acceptedObjects,
  agents,
  attentionItems,
  coreEvents,
  memberships,
  messages,
  proposals,
  rooms,
  users,
  workspaceMembers,
} from '@atrium/db';
import { and, eq, sql } from 'drizzle-orm';
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
    session: {
      authenticateUpgrade: createUpgradeAuthenticator({ auth, db: handle.db, logger }),
    },
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
  // An operating agent must have an owner sidecar (#116 fix r2): `mintAgentSession`
  // now refuses an agent with no `agents` row. Give it a channel room it owns and
  // a human owner (ada) so the config — and therefore the session — can exist.
  const [channel] = await handle.db
    .insert(rooms)
    .values({
      workspaceId: room.workspaceId,
      slug: `chan-${name}-${randomUUID()}`,
      name: `${name}'s channel`,
    })
    .returning({ id: rooms.id });
  await provisionAgentConfig({
    db: handle.db,
    userId: principal.userId,
    ownerUserId: room.people.ada as string,
    channelRoomId: (channel as { id: string }).id,
    host: 'localhost',
    harness: 'claude',
    model: 'opus',
  });
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
    const resolved = await getAtriumSession(
      auth,
      new Headers({ cookie: agent.session.cookie }),
      handle.db,
    );
    expect(resolved).toMatchObject({
      userId: agent.userId,
      principalKind: 'agent',
      emailVerified: true,
    });
  });

  it('stops resolving an agent session once its owner sidecar is deleted (#116 fix r3, F-C)', async () => {
    /**
     * The round-2 leak, from the post-mint side. `mintAgentSession` refuses an
     * agent with NO sidecar — but a cookie outlives its mint. An agent that WAS
     * configured, minted a session, and then had its `agents` row deleted
     * (`DELETE FROM agents WHERE user_id = …`) still presents a valid Better
     * Auth session, and round 2 kept letting it operate: ownerless, the "chain
     * terminates at a human" invariant (#114) bypassed for the life of the
     * cookie.
     *
     * `getAtriumSession` re-reads the sidecar on every resolution now, so the
     * live cookie fails closed the moment the owner is gone — the same recheck
     * the mint did, run again where the session is actually used.
     *
     * RED without the fix: a kind-only `getAtriumSession` returns a usable agent
     * session here regardless of whether any `agents` row exists.
     */
    const agent = await agentInTheRoom();
    const headers = new Headers({ cookie: agent.session.cookie });

    // Live and usable while the sidecar exists.
    expect(await getAtriumSession(auth, headers, handle.db)).toMatchObject({
      userId: agent.userId,
      principalKind: 'agent',
    });

    // De-sidecar it. `agents.channel_room_id` is referenced by nothing that
    // blocks the delete; the row is the agent's config, and removing it removes
    // the owner.
    await handle.db.delete(agents).where(eq(agents.userId, agent.userId));

    // The same cookie, the same function — now no session at all. Not a human,
    // not a downgraded agent: null, the fail-closed verdict `principalKind ===
    // null` gets.
    expect(await getAtriumSession(auth, headers, handle.db)).toBeNull();
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

  it('refuses to mint a session for an agent with NO owner sidecar (#116 fix r2)', async () => {
    // The round-1 leak: an agent principal provisioned but never CONFIGURED had
    // no `agents` row and so no `owner_user_id`, yet round 1 minted it a session
    // and let it operate — the "chain terminates at a human" invariant bypassed.
    // `mintAgentSession` now reads the config row, not just the kind: no sidecar,
    // no session. Catches: dropping the agents-row check back to a kind-only test.
    const bare = await provisionAgentPrincipal({
      db: handle.db,
      email: `bare-${randomUUID()}@agents.invalid`,
      displayName: 'bare',
    });
    await expect(mintAgentSession({ auth, db: handle.db, userId: bare.userId })).rejects.toThrow(
      /has no config sidecar/,
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

  it('attributes an agent’s message to the agent in the read model — front half and back half landed together', async () => {
    /**
     * The pin that used to hold `author_id` at NULL, now inverted by the ticket
     * it was waiting for (#101).
     *
     * Until #101, `projectMessagePosted` wrote `humanId(actor)` → NULL for an
     * agent, on purpose: an author with no voice register renders an agent's
     * sentences as a participant's typed words with nothing to distinguish them,
     * which is a worse falsehood than an unattributed row — AGENTS.md's "no
     * synthesized speech" rule reached from the author end. So filling in
     * `author_id` ALONE was the failure this test existed to catch, and NULL was
     * the honest state while the renderer had no kind to read.
     *
     * #101 landed both halves at once: `projectMessagePosted` now writes
     * `actorUserId(actor)` — the agent's own id — AND the web renderer paints an
     * agent's row in the machine voice register (`MessageRecord.authorKind`,
     * `data-author-kind`, the monospace body, the worded kind), proven by
     * `apps/web/e2e/agent-participant.spec.ts`. So the pin flips: the read model
     * now MUST attribute the agent, because the register that keeps that
     * attribution honest ships with it. A regression that dropped the register
     * would be caught by the web spec; a regression that dropped the attribution
     * is caught here.
     *
     * The invariant this still enforces is the one it always did — attribution
     * and register are never apart — only the true side of it moved.
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
    // The message carries its author — the agent's own `users` id — so the feed
    // reads a real author and its kind, not a NULL that renders unattributed.
    expect(row?.authorId).toBe(agent.userId);
    // And the ledger's trusted actor columns still say a non-human wrote it: the
    // attribution is an agent's, carried by the same discriminant every gate
    // reads, never softened into a person's on the way to the read model.
    expect((await actorRows())[0]).toEqual({
      kind: 'agent',
      id: agent.userId,
      type: 'message_posted',
    });
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
     * ## The shape of the refusal changed in #96 r2, and the change is the point
     *
     * This used to assert an `ack` carrying one issue — the reducer's verdict,
     * folded. That verdict was right and the shape was wrong: the `core_events`
     * row was **still inserted**, and the frame that came back said `ack`. #96's
     * gauntlet: *"'writes nothing' is overstated"*. A certification by a machine
     * is refused at the command layer now, before the append, so what lands is
     * nothing at all and what comes back is a `nack`.
     *
     * Judged in three places, in this order: the object table (was anything
     * certified), the ledger (was anything written at all), and only then the
     * frame. The first two are facts; the third is a claim about them.
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

    // Then the ledger: no durable row for the attempt either. This is the
    // assertion the old version could not make — `object_accepted` was in this
    // list, refused, and history all the same.
    expect((await actorRows()).map((row) => row.type)).toEqual(['proposal_recorded']);

    // Then the frame, and the reason, which must be the humanity gate rather
    // than a membership miss or a malformed frame — an agent IS a member, and
    // this refusal has to come from what it is, not from where it is.
    expect(attempt.type).toBe('nack');
    const said = JSON.stringify(attempt);
    expect(said).toContain('accept_proposal');
    expect(said).toContain('is a certification');
    expect(said).toContain('agent principal');
    expect(said).toContain('may draft a reading');
  });

  /**
   * Every command a machine may not perform, driven from a real agent session,
   * asserted on the ledger rather than on the ack.
   *
   * **#96 r2, finding 3.** The list is `certificationClassOf`'s `'certifies'`
   * row, and the reason it is a list here rather than one example is that the
   * finding was never about `accept_proposal` in particular — it was that the
   * refusal ran as a *fold* for the whole class, so each of these wrote a
   * `core_events` row and acked. `answer_message` and `supersede_object` already
   * carried `requireClean: true` and so aborted their batches; `accept_proposal`,
   * `correct`, `answer_bind` and `reject_proposal` did not.
   *
   * Catches: `certificationClassOf` returning `'open'` for any of these, and the
   * gate in `execute` being removed or moved below the append.
   */
  it('refuses every certification-class command from an agent, before anything is appended', async () => {
    const agent = await agentInTheRoom();
    const scribe = await connectWithCookie(agent.userId, agent.session.cookie);
    await scribe.subscribe(room.roomId);

    // Ids that do not exist: the point is that the refusal comes BEFORE
    // anything is looked up, so a command naming nothing real must still be
    // refused for being a certification rather than for being unresolvable. A
    // test using real ids could not tell the two apart.
    const nowhere = randomUUID();
    const certifying: CommandInput[] = [
      { name: 'accept_proposal', roomId: room.roomId, proposalId: nowhere },
      { name: 'reject_proposal', roomId: room.roomId, proposalId: nowhere },
      { name: 'correct', roomId: room.roomId, objectId: nowhere, action: 'retract' },
      {
        name: 'answer_bind',
        roomId: room.roomId,
        questionId: nowhere,
        answerObjectId: nowhere,
      },
      {
        name: 'answer_message',
        roomId: room.roomId,
        questionId: nowhere,
        body: 'the answer is yes',
        clientMessageId: randomUUID(),
        attachments: [],
      },
    ] as unknown as CommandInput[];

    for (const command of certifying) {
      const attempt = await scribe.command(command);
      expect(attempt.type, `${command.name} must be a hard refusal`).toBe('nack');
      expect(JSON.stringify(attempt)).toContain('is a certification');
    }

    // The whole point, and the assertion the old shape could not make: five
    // refused certifications and not one row of history.
    expect(await actorRows()).toEqual([]);
    expect(await handle.db.select().from(acceptedObjects)).toEqual([]);
  });

  it('stages a claim, an open_question and a decision as ~, a person certifies one to ✓ (confirmed), and the session may certify none (#117)', async () => {
    // The ticket, driven end to end. #117 widened `proposer_kind` so a SESSION
    // may DRAFT a `~`: `record_proposal` is participation (open to an agent), and
    // `draftToProposal` derives the proposer from the session, so an agent's
    // reading lands under `proposer_kind='agent'` with its own id — a machine
    // reading held to the receipt gate, NOT a person's. What did not widen is
    // certification: the agent may certify none of the readings it staged, nor the
    // one a person did.
    //
    // The covenant assertions, each with the guard reverting it goes red:
    //  - staging lands as `~` under the agent (guard: `draftToProposal`'s agent
    //    arm — revert to refuse and the stage nacks);
    //  - a decision is staged the same way but is doubly barred from `✓`: never
    //    machine-mintable (decision_acceptance), and the agent may not certify it
    //    anyway — it stays `proposed`, a `~` no machine can raise;
    //  - a person moves the claim to `✓`, and the projection reads it CONFIRMED —
    //    `accepted_by_kind='human'`, `human_touched_at` set — which is what a `✓`
    //    IS (guard: `actorMatchesProposer` human→true and the human accept path,
    //    the far end that must still hold);
    //  - the agent moves none — claim, open_question, or decision (guard: the
    //    covenant gate refusing every certification-class command from a non-human;
    //    revert it and the agent's `accept_proposal` reaches the reducer and
    //    auto-accepts its own `~` into an unconfirmed object this asserts absent).
    //
    // The reducer-level halves of the fold — an agent accepting its OWN reading
    // mints a `~` not a `✓` (`actorMatchesProposer`'s agent arm; the receipt's
    // machine/human split in `escalation.ts`; the self-staged gate for `agent`) —
    // are unreachable from a socket, because the covenant gate refuses an agent's
    // certification before the reducer runs. Those are pinned where they live:
    // `packages/core/test/authority-matrix.test.ts` (the widened `agent` citation
    // and the agent-accepted-`~` epistemic reading) and
    // `packages/core/test/acceptance.test.ts` (the receipt machine/human split).
    const agent = await agentInTheRoom();
    const person = await personInTheRoom();
    const scribe = await connectWithCookie(agent.userId, agent.session.cookie);
    await scribe.subscribe(room.roomId);

    // A machine reading carries a receipt — a real cited message and a verbatim
    // quote — so the agent posts the messages it will read out of. Posting is
    // participation, which an agent may do.
    const claimBody = 'The flag is off in production.';
    const questionBody = 'Do we keep the flag after launch?';
    for (const body of [claimBody, questionBody]) {
      expect(
        issuesOf(await scribe.command({ name: 'send_message', roomId: room.roomId, body })),
      ).toEqual([]);
    }
    const posted = await handle.db
      .select({ id: messages.id, body: messages.body })
      .from(messages)
      .where(and(eq(messages.roomId, room.roomId), eq(messages.authorId, agent.userId)));
    const idOf = (body: string) =>
      (posted.find((m) => m.body === body) as { id: string } | undefined)?.id ??
      (() => {
        throw new Error(`no message for ${body}`);
      })();

    // Stage a claim and an open_question. Both are `record_proposal`, and the
    // proposer is the session's own — never a value the socket chose.
    expect(
      issuesOf(
        await scribe.command({
          name: 'record_proposal',
          roomId: room.roomId,
          proposal: {
            type: 'claim',
            payload: { statement: claimBody, claimant: agent.userId, verification: 'unverified' },
            confidence: 1,
            provenance: [idOf(claimBody)],
            quote: claimBody,
            interpretationId: null,
          },
        } as unknown as CommandInput),
      ),
    ).toEqual([]);
    expect(
      issuesOf(
        await scribe.command({
          name: 'record_proposal',
          roomId: room.roomId,
          proposal: {
            type: 'open_question',
            payload: { question: questionBody },
            confidence: 1,
            provenance: [idOf(questionBody)],
            quote: questionBody,
            interpretationId: null,
          },
        } as unknown as CommandInput),
      ),
    ).toEqual([]);

    // …and a DECISION, the type no machine may ever certify. Staging it is still
    // participation (a `~`), so it lands; what it can never do is become a `✓`.
    const decisionBody = 'Keep the flag on after launch.';
    expect(
      issuesOf(
        await scribe.command({ name: 'send_message', roomId: room.roomId, body: decisionBody }),
      ),
    ).toEqual([]);
    const decisionMsg = await handle.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.roomId, room.roomId), eq(messages.body, decisionBody)));
    const decisionMsgId = (decisionMsg[0] as { id: string }).id;
    expect(
      issuesOf(
        await scribe.command({
          name: 'record_proposal',
          roomId: room.roomId,
          proposal: {
            type: 'decision',
            payload: { statement: decisionBody, decidedBy: agent.userId },
            confidence: 1,
            provenance: [decisionMsgId],
            quote: decisionBody,
            interpretationId: null,
          },
        } as unknown as CommandInput),
      ),
    ).toEqual([]);

    // All three landed as `~`, under the agent's OWN identity — not a person's, and
    // not a model's. Read from the projection the product writes, not the ack.
    const staged = await handle.db
      .select({
        id: proposals.id,
        type: proposals.type,
        status: proposals.status,
        proposerKind: proposals.proposerKind,
        proposerUserId: proposals.proposerUserId,
        proposerModel: proposals.proposerModel,
      })
      .from(proposals)
      .where(eq(proposals.roomId, room.roomId));
    expect(staged).toHaveLength(3);
    for (const p of staged) {
      expect(p.proposerKind, `${p.type} proposer kind`).toBe('agent');
      expect(p.proposerUserId, `${p.type} proposer id`).toBe(agent.userId);
      expect(p.proposerModel, `${p.type} proposer model`).toBeNull();
      // `proposed` is the `~`: a staged reading, no `✓` yet.
      expect(p.status, `${p.type} status`).toBe('proposed');
    }
    const claimId = (staged.find((p) => p.type === 'claim') as { id: string }).id;
    const questionId = (staged.find((p) => p.type === 'open_question') as { id: string }).id;
    const decisionId = (staged.find((p) => p.type === 'decision') as { id: string }).id;

    // A person in the room certifies ONE — the claim — to `✓`.
    const human = await connectWithCookie(person.userId, person.session.cookie);
    await human.subscribe(room.roomId);
    expect(
      issuesOf(
        await human.command({
          name: 'accept_proposal',
          roomId: room.roomId,
          proposalId: claimId,
        } as CommandInput),
      ),
    ).toEqual([]);
    const certified = await handle.db
      .select({
        proposalId: acceptedObjects.proposalId,
        acceptedBy: acceptedObjects.acceptedBy,
        acceptedByKind: acceptedObjects.acceptedByKind,
        humanTouchedAt: acceptedObjects.humanTouchedAt,
      })
      .from(acceptedObjects)
      .where(eq(acceptedObjects.roomId, room.roomId));
    expect(certified).toHaveLength(1);
    // `✓` BECAUSE a person accepted it — the agent staged the reading, the person
    // certified it, and `acceptedBy` is who the room answers to. The projection
    // reads CONFIRMED, which is what a `✓` IS: `epistemicStateOf` is
    // `isHuman(acceptedBy) || humanTouchedAt !== null`, and both halves say so
    // here — the accepter's kind is `human` and the human-touch instant is set.
    const object = certified[0] as {
      proposalId: string;
      acceptedBy: string | null;
      acceptedByKind: string;
      humanTouchedAt: Date | null;
    };
    expect(object.proposalId).toBe(claimId);
    expect(object.acceptedBy).toBe(person.userId);
    expect(object.acceptedByKind).toBe('human');
    expect(object.humanTouchedAt).not.toBeNull();

    // The session may certify NONE — not the open_question it staged, not the
    // decision it staged, and not its own claim (already `✓`). Each refused for
    // being a certification, by what the session IS, before anything is appended.
    for (const [label, proposalId] of [
      ['the open_question it staged', questionId],
      ['the decision it staged', decisionId],
      ['its own claim', claimId],
    ] as const) {
      const attempt = await scribe.command({
        name: 'accept_proposal',
        roomId: room.roomId,
        proposalId,
      } as CommandInput);
      expect(attempt.type, label).toBe('nack');
      const said = JSON.stringify(attempt);
      expect(said, label).toContain('is a certification');
      expect(said, label).toContain('may draft a reading');
    }

    // Nothing new was certified: still exactly the one the person accepted. The
    // open_question and the decision the agent staged are both still `~`
    // (`proposed`) — a machine raised neither to a `✓`.
    expect(await handle.db.select().from(acceptedObjects)).toHaveLength(1);
    const stillProposed = await handle.db
      .select({ id: proposals.id, status: proposals.status })
      .from(proposals)
      .where(and(eq(proposals.roomId, room.roomId), eq(proposals.status, 'proposed')));
    const proposedIds = stillProposed.map((p) => (p as { id: string }).id).sort();
    expect(proposedIds).toEqual([questionId, decisionId].sort());
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

/**
 * **#96 r2, finding 2** — both blind critics, independently, ship-blocking.
 *
 * `projectAttentionResolved` scoped its UPDATE with `humanId(actor)`, and a null
 * owner **dropped the owner predicate entirely**. Every non-human was anonymous
 * until #96, so that branch had no live caller; the moment an agent holds a
 * session and a room membership it is a wildcard, and `resolve_attention` is
 * deliberately open to an agent (it is participation, not certification), so the
 * wildcard is reachable from an ordinary authenticated socket.
 *
 * Three cases, because the rule has three sides and only asserting the refusal
 * would be satisfied by refusing an agent everything: somebody else's item is
 * refused, its own item works, and the item somebody else owns is *still there*
 * afterwards.
 */
describe('attention resolves by ownership, not by humanity', () => {
  /**
   * A pending item belonging to `targetId`, made the way the product makes one:
   * `sender` posts a message that mentions them.
   *
   * Through the real path rather than an INSERT, because an item this test
   * fabricated could carry a shape the product never produces — and the routing
   * side of attention is exactly what the owner predicate is scoping.
   */
  async function pendingItemFor(sender: TestClient, targetId: string): Promise<string> {
    const surface = '@you';
    const body = `${surface} could you take a look`;
    // The reference kind IS the target's principal kind — a person is named by a
    // `human` reference, an agent by an `agent` reference (#100). The product
    // builds it that way (the composer candidate carries the participant's kind),
    // and the append-boundary trigger refuses a reference whose kind disagrees
    // with the target's own principal_kind, so deriving it here is the faithful
    // way to "make one the way the product makes one".
    const [target] = await handle.db
      .select({ principalKind: users.principalKind })
      .from(users)
      .where(eq(users.id, targetId));
    const kind = (target as { principalKind: 'human' | 'agent' } | undefined)?.principalKind;
    if (kind === undefined) throw new Error(`no principal for mention target ${targetId}`);
    const ack = await sender.command({
      name: 'send_message',
      roomId: room.roomId,
      body,
      references: [{ ordinal: 0, kind, targetId, start: 0, end: surface.length, surface }],
    } as unknown as CommandInput);
    expect(issuesOf(ack)).toEqual([]);
    const rows = await handle.db
      .select({ id: attentionItems.id })
      .from(attentionItems)
      .where(and(eq(attentionItems.roomId, room.roomId), eq(attentionItems.userId, targetId)));
    expect(rows, 'the mention must have routed exactly one item').toHaveLength(1);
    return (rows[0] as { id: string }).id;
  }

  const statusOf = async (id: string) => {
    const [row] = await handle.db
      .select({ status: attentionItems.status })
      .from(attentionItems)
      .where(eq(attentionItems.id, id));
    return (row as { status: string } | undefined)?.status;
  };

  it('refuses an agent resolving a person’s attention item, and leaves it pending', async () => {
    const agent = await agentInTheRoom();
    const person = await personInTheRoom();
    const scribe = await connectWithCookie(agent.userId, agent.session.cookie);
    await scribe.subscribe(room.roomId);
    // The agent mentions the person, which routes an item to THEM. Posting is
    // open to an agent; resolving what the post created is not its to resolve.
    const theirs = await pendingItemFor(scribe, person.userId);

    const attempt = await scribe.command({
      name: 'resolve_attention',
      roomId: room.roomId,
      attentionId: theirs,
      status: 'dismissed',
    } as CommandInput);

    // The fold first, and it is the whole finding: before this fix the UPDATE
    // matched and this row read `dismissed`.
    expect(await statusOf(theirs)).toBe('pending');
    // The projection throws, which aborts the append transaction, so there is no
    // ledger row either — the same "nothing durable" property the certification
    // gate has, arrived at by a different route.
    expect(attempt.type).toBe('nack');
    expect((await actorRows()).filter((row) => row.type === 'attention_resolved')).toEqual([]);
  });

  it('lets an agent resolve its own — the half a refuse-everything fix would break', async () => {
    const agent = await agentInTheRoom();
    const person = await personInTheRoom();
    const scribe = await connectWithCookie(agent.userId, agent.session.cookie);
    await scribe.subscribe(room.roomId);
    const human = await connectWithCookie(person.userId, person.session.cookie);
    await human.subscribe(room.roomId);

    const mine = await pendingItemFor(human, agent.userId);
    const theirs = await pendingItemFor(scribe, person.userId);

    const ack = await scribe.command({
      name: 'resolve_attention',
      roomId: room.roomId,
      attentionId: mine,
      status: 'resolved',
    } as CommandInput);

    expect(issuesOf(ack)).toEqual([]);
    expect(await statusOf(mine)).toBe('resolved');
    // And it touched exactly one row: the wildcard would have taken both.
    expect(await statusOf(theirs)).toBe('pending');
  });

  it('scopes a person the same way it always did — the behaviour that must not move', async () => {
    const alice = await personInTheRoom('alice');
    const bob = await personInTheRoom('bob');
    const client = await connectWithCookie(alice.userId, alice.session.cookie);
    await client.subscribe(room.roomId);
    const other = await connectWithCookie(bob.userId, bob.session.cookie);
    await other.subscribe(room.roomId);

    const hers = await pendingItemFor(other, alice.userId);
    const his = await pendingItemFor(client, bob.userId);

    expect(
      issuesOf(
        await client.command({
          name: 'resolve_attention',
          roomId: room.roomId,
          attentionId: hers,
        } as CommandInput),
      ),
    ).toEqual([]);
    expect(await statusOf(hers)).toBe('resolved');

    const trespass = await client.command({
      name: 'resolve_attention',
      roomId: room.roomId,
      attentionId: his,
    } as CommandInput);
    expect(trespass.type).toBe('nack');
    expect(await statusOf(his)).toBe('pending');
  });
});

/**
 * **#96 r2, finding 1** — both blind critics, ship-blocking, and the one this
 * build's own authority matrix asserted was correct.
 *
 * `decideSupersession` puts `claim` and `open_question` in #4's auto-accept row,
 * and the reducer human-gated only the rows that say `requires_human`. So an
 * authenticated agent could retire a claim **a person had accepted** — a `✓`
 * unmade on a machine's word. #95's decided rule: a non-human may never retire
 * anything `epistemicStateOf(record) === 'confirmed'`.
 *
 * Driven end to end here rather than only in the reducer's own suite, because
 * what made this reachable was the session, and a session is what this file has.
 */
describe('an agent may not retire what a person confirmed', () => {
  /** A claim in the room, accepted by a person: a `✓`. */
  async function confirmedClaim(person: { userId: string; session: { cookie: string } }) {
    const client = await connectWithCookie(person.userId, person.session.cookie);
    await client.subscribe(room.roomId);
    const staged = await client.command({
      name: 'record_proposal',
      roomId: room.roomId,
      proposal: {
        type: 'claim',
        payload: {
          statement: 'The migration ran clean.',
          claimant: person.userId,
          verification: 'unverified',
        },
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
    const proposalId = (recorded as { payload: { proposal: { id: string } } }).payload.proposal.id;
    const accepted = await client.command({
      name: 'accept_proposal',
      roomId: room.roomId,
      proposalId,
    } as CommandInput);
    expect(issuesOf(accepted)).toEqual([]);
    const rows = await handle.db
      .select({ id: acceptedObjects.id, acceptedBy: acceptedObjects.acceptedBy })
      .from(acceptedObjects);
    expect(rows).toHaveLength(1);
    // The premise of the whole test, checked rather than assumed: this object is
    // confirmed BECAUSE a person accepted it, which is what `acceptedBy` records.
    expect((rows[0] as { acceptedBy: string | null }).acceptedBy).toBe(person.userId);
    return { client, objectId: (rows[0] as { id: string }).id };
  }

  it('refuses an agent’s supersession of a human-accepted claim, and the claim stands', async () => {
    const agent = await agentInTheRoom();
    const person = await personInTheRoom();
    const { client, objectId } = await confirmedClaim(person);

    // A replacement, minted by the person, so the only thing under test is who
    // may point the `supersedes` edge.
    const replacement = await client.command({
      name: 'record_proposal',
      roomId: room.roomId,
      proposal: {
        type: 'claim',
        payload: {
          statement: 'The migration needed a retry.',
          claimant: person.userId,
          verification: 'unverified',
        },
        confidence: 1,
        provenance: [],
        quote: null,
        interpretationId: null,
      },
    } as unknown as CommandInput);
    expect(issuesOf(replacement)).toEqual([]);
    const staged = await handle.db
      .select({ payload: coreEvents.payload })
      .from(coreEvents)
      .where(and(eq(coreEvents.roomId, room.roomId), eq(coreEvents.type, 'proposal_recorded')))
      // ORDER BY, because `.at(-1)` below means "the one staged last" and a
      // SELECT with no ORDER BY has no last. Without it this picks whichever row
      // the planner returned first and the test cites the already-accepted
      // proposal — which it did, intermittently, before this line existed.
      .orderBy(coreEvents.seq);
    const secondProposal = (staged.at(-1) as { payload: { proposal: { id: string } } }).payload
      .proposal.id;
    expect(
      issuesOf(
        await client.command({
          name: 'accept_proposal',
          roomId: room.roomId,
          proposalId: secondProposal,
        } as CommandInput),
      ),
    ).toEqual([]);
    const objects = await handle.db.select({ id: acceptedObjects.id }).from(acceptedObjects);
    const replacementId = objects.map((row) => row.id).find((id) => id !== objectId) as string;

    const scribe = await connectWithCookie(agent.userId, agent.session.cookie);
    await scribe.subscribe(room.roomId);
    const attempt = await scribe.command({
      name: 'supersede_object',
      roomId: room.roomId,
      replacementObjectId: replacementId,
      retiredObjectId: objectId,
      clientSupersessionId: randomUUID(),
    } as CommandInput);

    // The fold: the claim is still live. Before this round it was retired, with
    // `supersededById` set and the ack clean.
    const [after] = await handle.db
      .select({ superseded: acceptedObjects.supersededById })
      .from(acceptedObjects)
      .where(eq(acceptedObjects.id, objectId));
    expect((after as { superseded: string | null }).superseded).toBeNull();

    expect(attempt.type).toBe('nack');
    const said = JSON.stringify(attempt);
    expect(said).toContain('has been confirmed by a person');
    expect(said).toContain('agent principal');
    // And nothing durable: no `relation_added` row for the attempt.
    expect((await actorRows()).filter((row) => row.type === 'relation_added')).toEqual([]);
  });

  it('lets the person retire it — the rule is about who, not about whether', async () => {
    const person = await personInTheRoom();
    const { client, objectId } = await confirmedClaim(person);
    const second = await client.command({
      name: 'record_proposal',
      roomId: room.roomId,
      proposal: {
        type: 'claim',
        payload: {
          statement: 'The migration needed a retry.',
          claimant: person.userId,
          verification: 'unverified',
        },
        confidence: 1,
        provenance: [],
        quote: null,
        interpretationId: null,
      },
    } as unknown as CommandInput);
    expect(issuesOf(second)).toEqual([]);
    const staged = await handle.db
      .select({ payload: coreEvents.payload })
      .from(coreEvents)
      .where(and(eq(coreEvents.roomId, room.roomId), eq(coreEvents.type, 'proposal_recorded')))
      // ORDER BY, because `.at(-1)` below means "the one staged last" and a
      // SELECT with no ORDER BY has no last. Without it this picks whichever row
      // the planner returned first and the test cites the already-accepted
      // proposal — which it did, intermittently, before this line existed.
      .orderBy(coreEvents.seq);
    const secondProposal = (staged.at(-1) as { payload: { proposal: { id: string } } }).payload
      .proposal.id;
    expect(
      issuesOf(
        await client.command({
          name: 'accept_proposal',
          roomId: room.roomId,
          proposalId: secondProposal,
        } as CommandInput),
      ),
    ).toEqual([]);
    const objects = await handle.db.select({ id: acceptedObjects.id }).from(acceptedObjects);
    const replacementId = objects.map((row) => row.id).find((id) => id !== objectId) as string;

    const ack = await client.command({
      name: 'supersede_object',
      roomId: room.roomId,
      replacementObjectId: replacementId,
      retiredObjectId: objectId,
      clientSupersessionId: randomUUID(),
    } as CommandInput);
    expect(issuesOf(ack)).toEqual([]);

    const [after] = await handle.db
      .select({ superseded: acceptedObjects.supersededById })
      .from(acceptedObjects)
      .where(eq(acceptedObjects.id, objectId));
    expect((after as { superseded: string | null }).superseded).toBe(replacementId);
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

  /**
   * **#96 r2, finding 4, second half.** `users_principal_kind_immutable` is a
   * BEFORE UPDATE trigger, and the route around a BEFORE UPDATE trigger is not
   * to update. Delete the row and insert the same uuid under the other kind and
   * every `core_events` row that identity ever appended reads back as the other
   * sort of participant — which is exactly what the trigger exists to prevent,
   * reached by going around it.
   *
   * drizzle/0018 states the property the append boundary actually depends on,
   * which is not about UPDATE at all: no `users` row may exist whose
   * `principal_kind` disagrees with the `actor_kind` of anything that uuid has
   * already appended.
   *
   * Catches: the BEFORE INSERT companion being dropped, and the mutant
   * `principal_kind_survives_a_reinsert` in the root ledger.
   */
  it('refuses re-creating a deleted identity under the other kind — history is what it is checked against', async () => {
    const agent = await agentInTheRoom();
    const scribe = await connectWithCookie(agent.userId, agent.session.cookie);
    await scribe.subscribe(room.roomId);
    expect(
      issuesOf(await scribe.command({ name: 'send_message', roomId: room.roomId, body: 'hello' })),
    ).toEqual([]);
    // The history that makes the uuid's kind a fact rather than a setting.
    expect((await actorRows()).map((row) => row.kind)).toEqual(['agent']);

    await scribe.close();
    const email = `revived-${randomUUID()}@example.test`;
    await handle.db.delete(users).where(eq(users.id, agent.userId));

    const revived = await handle.db
      .insert(users)
      .values({
        id: agent.userId,
        email,
        displayName: 'definitely a person',
        emailVerified: true,
        principalKind: 'human',
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(revived, 'the reinsert under the other kind must be refused').not.toBeNull();
    expect(describeDatabaseError(revived)).toMatch(/users_principal_kind_immutable/);
    expect(describeDatabaseError(revived)).toMatch(/already appended history as a/);

    // The control, and it matters: this is a guard on the DISAGREEMENT, not a
    // ban on reusing a uuid. The same identity coming back as what it was is
    // fine, because nothing it wrote is re-read as anything else.
    await handle.db.insert(users).values({
      id: agent.userId,
      email,
      displayName: 'scribe again',
      emailVerified: true,
      principalKind: 'agent',
    });
    const [back] = await handle.db
      .select({ kind: users.principalKind })
      .from(users)
      .where(eq(users.id, agent.userId));
    expect(back).toEqual({ kind: 'agent' });
  });

  /**
   * **#96 r2, finding 4, first half.** 0017 opened the membership gate with
   * `IF NEW."actor_kind"::text IN ('human','agent')`, which is a denylist wearing
   * an allowlist's clothes: a sixth `actor_kind` is not *refused* by that line,
   * it is not *reached* by it, and it appends durable history into any room with
   * no membership check, no identity resolution and no kind agreement — silently.
   *
   * 0018 derives the identified set from `principal_kind` itself and refuses
   * anything that is neither identified nor one of the two enumerated anonymous
   * kinds. This asserts that against the two **deployed** enums rather than
   * against the drizzle constants, because the drift that matters is SQL the
   * TypeScript never sees (the same lesson `ledger-constraints.test.ts` records
   * about `event_type`).
   *
   * It is a live-coverage assertion, and it is what goes red the day somebody
   * adds a label: the union of `principal_kind` and the two anonymous kinds must
   * be exactly `actor_kind`. An unclassified label makes this fail here rather
   * than making the append boundary fail open there.
   *
   * ## The half that cannot be a committed test, and how it was measured
   *
   * The `ELSE` branch itself — an append by a kind nobody has classified — needs
   * a sixth `actor_kind` to exist, and `ALTER TYPE … ADD VALUE` **cannot be
   * undone**, so a test that added one would leak it into every later file in
   * the run. `ledger-constraints.test.ts` records the same limit for
   * `event_type` and answers it the same way: by hand, on a throwaway database,
   * written down. #96 r2, both directions, same database and same probe:
   *
   *  1. `ALTER TYPE public.actor_kind ADD VALUE 'probe_unclassified'`, a real
   *     workspace and room, then `atrium_append_core_event(...)` through the real
   *     function (a direct INSERT proves nothing — `core_events_append_guard`
   *     refuses it first, for a different reason).
   *  2. With **0017's spelling** deployed (restored from the
   *     `identified_set_is_a_denylist_again` mutant): **APPENDED.** Durable
   *     history in a real room, from a kind with no membership, no identity and
   *     no agreement check — nothing raised anywhere.
   *  3. With **0018's spelling** restored, same probe, same database:
   *     **REFUSED**, `actor_kind "probe_unclassified" is neither an identity …
   *     nor one of the anonymous kinds`.
   *
   * The database was then destroyed, because it now carries a label that cannot
   * be removed. What stays committed is the coverage assertion below, which is
   * what turns "somebody added a label" into a red test before it can become a
   * silent exemption.
   */
  it('classifies every deployed actor_kind as identified or anonymous, with nothing left over', async () => {
    const labelsOf = async (type: string): Promise<string[]> => {
      const rows = await handle.db.execute(
        sql`SELECT en.enumlabel::text AS label
            FROM pg_enum en
            JOIN pg_type t ON t.oid = en.enumtypid
            JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = 'public' AND t.typname = ${type}
            ORDER BY en.enumsortorder`,
      );
      return (rows as unknown as { label: string }[]).map((row) => row.label);
    };

    const actorKinds = await labelsOf('actor_kind');
    const principalKinds = await labelsOf('principal_kind');
    // The two the boundary EXCUSES, written out here exactly as the migration
    // writes them out — an exemption is the thing that must be enumerated.
    const anonymous = ['model', 'system'];

    expect(actorKinds.length).toBeGreaterThan(0);
    expect(principalKinds).toEqual(['human', 'agent']);
    expect([...actorKinds].sort()).toEqual([...principalKinds, ...anonymous].sort());
    // …and the two sets do not overlap, or a label would be both checked and
    // excused and the ELSE branch would be measuring nothing.
    expect(principalKinds.filter((kind) => anonymous.includes(kind))).toEqual([]);
  });

  it('derives that set in the deployed function rather than listing it', async () => {
    // Reading the function the database is actually running, not the migration
    // file — a stale anchor reads as green, and this whole chain of migrations
    // is `CREATE OR REPLACE`.
    //
    // Catches: 0018 being reverted to 0017's literal, and the ELSE branch being
    // deleted so an unclassified kind is silently excused again.
    const rows = await handle.db.execute(
      sql`SELECT pg_get_functiondef('public.atrium_core_events_invariants()'::regprocedure) AS def`,
    );
    const definition = (rows as unknown as { def: string }[])[0]?.def ?? '';
    expect(definition).toContain("typname = 'principal_kind'");
    expect(definition).toMatch(/IN \('model', 'system'\)/);
    expect(definition).toMatch(/neither an identity/);
    expect(
      definition,
      'the identified set must be derived from principal_kind, not written out',
    ).not.toMatch(/IN \('human', 'agent'\)/);
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
