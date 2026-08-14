import { randomUUID } from 'node:crypto';
import type { DatabaseHandle } from '@atrium/db';
import {
  acceptedObjects,
  attentionItems,
  coreEvents,
  plans,
  sessionSignals,
  sessionSubscriptions,
  sessions,
} from '@atrium/db/schema';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../apps/server/src/logger.js';
import { sweepExpiredSubscriptions } from '../../apps/server/src/subscriptions.js';
import { violatesConstraint } from '../support/constraints.js';
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
 * THE SIGNAL/INTERRUPT BOUNDARY, END TO END (#127, from #123's binding
 * resolution).
 *
 * Two ledger-only events — `session_signaled {steer|interrupt|resume}` and
 * `session_subscribed` — through the REAL boundary (`TestClient` → ws → commands
 * → ledger → projections), against the real migrations.
 *
 * Every enforcement here is red-on-revert and each test asserts ONE clause by its
 * OWN message. That is #122's standing lesson made a rule: a shared nack
 * assertion tests the disjunction — "something refused this" — so a guard can be
 * deleted while its own test stays green because a neighbouring guard catches the
 * same input. Each refusal below names a different rule and a different sentence.
 */

let handle: DatabaseHandle;
let server: TestServer;
let room: SeededRoom;
/** A second room, for the cross-room provenance flip. */
let otherRoom: SeededRoom;
let agentId: string;
let ownerId: string;
let bystanderId: string;
const open: TestClient[] = [];

async function connect(userId: string, principalKind: 'human' | 'agent'): Promise<TestClient> {
  const client = await TestClient.connect(server.url, userId, { principalKind });
  open.push(client);
  return client;
}

beforeEach(async () => {
  handle ??= openDatabase(10);
  await resetDatabase(handle);
  // alice OWNS the agent hexi; bob is an ordinary member who owns nothing.
  room = await seedRoom(handle, ['alice', 'bob', 'hexi'], { agents: ['hexi'] });
  ownerId = room.people.alice as string;
  bystanderId = room.people.bob as string;
  agentId = room.people.hexi as string;
  await handle.db.execute(sql`
    UPDATE rooms SET agent_user_id = ${agentId} WHERE id = ${room.roomId}
  `);
  await handle.db.execute(sql`
    INSERT INTO agents (user_id, owner_user_id, channel_room_id, host, harness, model)
    VALUES (${agentId}, ${ownerId}, ${room.roomId}, 'localhost', 'claude', 'opus')
  `);
  // A second room the same people are in — the cross-room provenance flip needs a
  // message that really exists somewhere the signal cannot reach.
  otherRoom = await seedRoom(handle, ['alice', 'bob'], { slug: 'elsewhere' });
  server = await startTestServer(handle);
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()));
  await server?.close();
});

afterAll(async () => {
  await handle?.close();
});

/**
 * A funded plan with one open session under it, opened by the agent.
 *
 * The slice is set with a raw UPDATE rather than a human `set_plan_rlimit`, the
 * same shortcut `lifecycle-events.test.ts` takes: it adds no `plan_rlimit_set`
 * ledger row, so the event-sequence assertions below stay about signals.
 */
async function openSession(slice = 100): Promise<{ planId: string; sessionId: string }> {
  const hexi = await connect(agentId, 'agent');
  const opened = await hexi.command({
    name: 'open_plan',
    roomId: room.roomId,
    agentUserId: agentId,
    title: 'the signal lane',
    budgetLimitMicros: null,
  });
  expect(opened.type).toBe('ack');
  const [plan] = await handle.db.select().from(plans).where(eq(plans.roomId, room.roomId));
  const planId = plan?.id as string;
  await handle.db.execute(sql`UPDATE plans SET rlimit_slice = ${slice} WHERE id = ${planId}`);
  const draw = await hexi.command({
    name: 'open_session',
    roomId: room.roomId,
    planId,
    harness: 'omp',
    model: 'haiku',
  });
  expect(draw.type).toBe('ack');
  if (draw.type !== 'ack' || draw.draw?.outcome !== 'granted') {
    throw new Error('the fixture failed to draw a session');
  }
  return { planId, sessionId: draw.draw.sessionId };
}

/** Post a message in a room and return its id — a cause a signal can cite. */
async function postMessage(client: TestClient, roomId: string, body: string): Promise<string> {
  const ack = await client.command({ name: 'send_message', roomId, body });
  expect(ack.type).toBe('ack');
  const [row] = await handle.db
    .select({ id: sql<string>`id::text` })
    .from(sql`messages`)
    .where(sql`room_id = ${roomId}::uuid AND body = ${body}`);
  return row?.id as string;
}

async function signalRows(sessionId: string) {
  return handle.db
    .select()
    .from(sessionSignals)
    .where(eq(sessionSignals.sessionId, sessionId))
    .orderBy(asc(sessionSignals.createdAt));
}

async function planRow(planId: string) {
  const [row] = await handle.db.select().from(plans).where(eq(plans.id, planId));
  return row;
}

async function refusalCount(): Promise<number> {
  const [{ n } = { n: 0 }] = await handle.db
    .select({ n: sql<number>`count(*)::int` })
    .from(coreEvents)
    .where(and(eq(coreEvents.roomId, room.roomId), eq(coreEvents.type, 'draw_refused')));
  return n;
}

/** Settle the session through its opener, so it is terminal for the next check. */
async function settle(sessionId: string): Promise<void> {
  const hexi = await connect(agentId, 'agent');
  const ack = await hexi.command({
    name: 'settle_session',
    roomId: room.roomId,
    sessionId,
    outcome: 'settled',
    exitSummary: 'done',
    spendMicros: 0,
    contextPct: 0,
  });
  expect(ack.type).toBe('ack');
}

describe('a steer reaches a running session, receipted and provenanced', () => {
  /**
   * ACCEPTANCE 1. A steered OPEN session gets a receipted `session_signals` row
   * carrying its `causeMessageId` provenance — and the steer is appendable by ANY
   * authenticated room member, because that append is public, receipted, and
   * powerless over covenant and purse (#123 resolution 5).
   *
   * RED-ON-REVERT: stop writing `causeMessageId` in `projectSessionSignaled` and
   * the provenance assertion goes null — this test goes red.
   */
  it('records a steer from any member with its cause message and its raiser', async () => {
    const { sessionId } = await openSession();
    const bob = await connect(bystanderId, 'human');
    const causeMessageId = await postMessage(bob, room.roomId, 'try the other migration order');

    const ack = await bob.command({
      name: 'signal_session',
      roomId: room.roomId,
      sessionId,
      kind: 'steer',
      body: 'try the other migration order',
      causeMessageId,
    });
    expect(ack.type).toBe('ack');

    const [row] = await signalRows(sessionId);
    expect(row).toMatchObject({
      sessionId,
      kind: 'steer',
      body: 'try the other migration order',
      causeMessageId,
      subscriptionId: null,
      // The TRUSTED actor off the ledger row, not the payload.
      raisedByUserId: bystanderId,
    });
    expect(row?.signaledByEventId).toBeTruthy();
  });

  /**
   * A revision NAMES the append it replaces, and only a real earlier signal of
   * this same session in this room qualifies (#123 resolution 4).
   *
   * RED-ON-REVERT: delete the `requireSupersededSignal` call in `signal_session`
   * and the invented id acks — this test goes red on the nack and on the
   * one-signal count.
   */
  it('refuses a supersedesEventId that is not an earlier signal of this session', async () => {
    const { sessionId } = await openSession();
    const bob = await connect(bystanderId, 'human');

    const first = await bob.command({
      name: 'signal_session',
      roomId: room.roomId,
      sessionId,
      kind: 'steer',
      body: 'first thought',
    });
    expect(first.type).toBe('ack');
    const [firstRow] = await signalRows(sessionId);

    const invented = await bob.command({
      name: 'signal_session',
      roomId: room.roomId,
      sessionId,
      kind: 'steer',
      body: 'second thought',
      supersedesEventId: randomUUID(),
    });
    expect(invented.type).toBe('nack');
    if (invented.type === 'nack') {
      expect(invented.message).toContain('is not an earlier session_signaled');
    }
    expect(await signalRows(sessionId)).toHaveLength(1);

    // The flip: naming the REAL earlier signal is accepted, forward-only.
    const revision = await bob.command({
      name: 'signal_session',
      roomId: room.roomId,
      sessionId,
      kind: 'steer',
      body: 'second thought',
      supersedesEventId: firstRow?.signaledByEventId,
    });
    expect(revision.type).toBe('ack');
    const rows = await signalRows(sessionId);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.supersedesEventId).toBe(firstRow?.signaledByEventId);
  });

  /**
   * FLIP THE INPUT — a cross-room `causeMessageId` is refused (#123 resolution 4).
   * The message really exists; it is simply in a room this signal cannot reach,
   * which is exactly the case a nullable free-text field would have let through.
   *
   * RED-ON-REVERT: delete the `requireSameRoomCause` call in `signal_session` and
   * the append reaches the projection, where the composite `(room_id,
   * cause_message_id)` FK refuses it as a raw constraint error rather than as this
   * sentence — this test goes red on the message assertion.
   */
  it('refuses a causeMessageId from another room', async () => {
    const { sessionId } = await openSession();
    const alice = await connect(ownerId, 'human');
    // A member of the OTHER room posts there — `seedRoom` mints its own users, so
    // this is deliberately somebody else's identity in somebody else's room. What
    // is being flipped is the message's room, not the signaller's membership.
    const elsewhereAuthor = await connect(otherRoom.people.alice as string, 'human');
    const elsewhere = await postMessage(
      elsewhereAuthor,
      otherRoom.roomId,
      'a sentence in another room',
    );

    const ack = await alice.command({
      name: 'signal_session',
      roomId: room.roomId,
      sessionId,
      kind: 'steer',
      body: 'cite the other room',
      causeMessageId: elsewhere,
    });
    expect(ack.type).toBe('nack');
    if (ack.type === 'nack') {
      expect(ack.message).toContain('names no message in room');
    }
    expect(await signalRows(sessionId)).toHaveLength(0);
  });
});

describe('an interrupt is the agent’s or its owner’s, and nobody else’s', () => {
  /**
   * FLIP THE INPUT — a non-owner member's interrupt is REFUSED, and the same act
   * by the agent's owner is accepted (#123 resolution 5, codex r1.4).
   *
   * The check is a LOOKUP (`plans.agent_user_id` → `agents.owner_user_id`) because
   * `execute` discards the role `Authorizer.authorize` returns — an authorization
   * whose answer nobody reads is decoration, which is precisely what the gauntlet
   * found. Bob is a full room member in good standing: membership is not the
   * question here, lineage is.
   *
   * RED-ON-REVERT: delete the `requireSessionControl` call in the `interrupt`
   * branch of `signal_session` and bob's interrupt acks and rows up — this test
   * goes red on the nack, on the message, and on the zero-row assertion.
   */
  it('refuses a bystander’s interrupt and accepts the owner’s', async () => {
    const { sessionId } = await openSession();
    const bob = await connect(bystanderId, 'human');
    const alice = await connect(ownerId, 'human');

    const bystander = await bob.command({
      name: 'signal_session',
      roomId: room.roomId,
      sessionId,
      kind: 'interrupt',
      body: 'stop that',
    });
    expect(bystander.type).toBe('nack');
    if (bystander.type === 'nack') {
      expect(bystander.message).toContain('agent principal or the human who owns that agent');
    }
    expect(await signalRows(sessionId)).toHaveLength(0);

    // Bob may still STEER the same session — the two rules are different, and a
    // refusal that swallowed both would be authority nobody voted for.
    const steer = await bob.command({
      name: 'signal_session',
      roomId: room.roomId,
      sessionId,
      kind: 'steer',
      body: 'consider stopping',
    });
    expect(steer.type).toBe('ack');

    const owner = await alice.command({
      name: 'signal_session',
      roomId: room.roomId,
      sessionId,
      kind: 'interrupt',
      body: 'stop that',
    });
    expect(owner.type).toBe('ack');
    const kinds = (await signalRows(sessionId)).map((row) => row.kind);
    expect(kinds).toEqual(['steer', 'interrupt']);
  });

  /**
   * THE TABLE BACKSTOP, asked of the table (#127 §5 of drizzle/0045). The command
   * check binds the command path; this binds a direct writer. A `session_signals`
   * row whose `raised_by_user_id` is neither the agent nor its owner is refused by
   * `session_signals_interrupt_authorized` even with no command in sight.
   *
   * RED-ON-REVERT: drop the trigger (or narrow it to `kind = 'steer'`) and this
   * raw INSERT succeeds — this test goes red.
   */
  it('refuses a hand-written interrupt row from a member who owns nothing', async () => {
    const { sessionId } = await openSession();
    await violatesConstraint('session_signals_interrupt_authorized', () =>
      handle.db.execute(sql`
        INSERT INTO session_signals (room_id, session_id, kind, raised_by_user_id)
        VALUES (${room.roomId}::uuid, ${sessionId}::uuid, 'interrupt', ${bystanderId}::uuid)
      `),
    );

    // The flip: the OWNER's hand-written row is accepted by the same trigger, so
    // what is being enforced is lineage and not "no direct writes".
    await handle.db.execute(sql`
      INSERT INTO session_signals (room_id, session_id, kind, raised_by_user_id)
      VALUES (${room.roomId}::uuid, ${sessionId}::uuid, 'interrupt', ${ownerId}::uuid)
    `);
    expect(await signalRows(sessionId)).toHaveLength(1);
  });
});

describe('signals target open sessions only', () => {
  /**
   * FLIP THE INPUT — a signal at a SETTLED session is refused (#123 resolution 3).
   * NEW enforcement: the 0025 trigger freezes a terminal `sessions` row and
   * structurally cannot refuse a later ledger append that merely names one.
   *
   * The race model is the sentence in the refusal: an interrupt REQUESTS, an exit
   * CONCLUDES. Whichever reaches the append lock first wins, and once the exit has
   * won there is no process left to signal.
   *
   * RED-ON-REVERT: delete the `requireOpenTarget` call in `signal_session` and the
   * append reaches the projection, which refuses it with ITS message — this test
   * goes red on the command's own sentence.
   */
  it('refuses a steer at a session that has already published its exit receipt', async () => {
    const { sessionId } = await openSession();
    await settle(sessionId);
    const alice = await connect(ownerId, 'human');

    const ack = await alice.command({
      name: 'signal_session',
      roomId: room.roomId,
      sessionId,
      kind: 'steer',
      body: 'too late',
    });
    expect(ack.type).toBe('nack');
    if (ack.type === 'nack') {
      expect(ack.message).toContain('An interrupt requests; an exit concludes');
    }
    expect(await signalRows(sessionId)).toHaveLength(0);
  });

  /**
   * THE PROJECTION'S OWN nack, reached by removing the command's head start: a
   * signal whose session exits between the command's read and the projection's is
   * refused there too. Provoked here by settling the session in the SAME room
   * first and then driving the projection directly through the ledger, which is
   * the path a second writer takes.
   *
   * RED-ON-REVERT: delete the open-session read in `projectSessionSignaled` and
   * this append succeeds — a signal rows up against a settled session, and this
   * test goes red on the throw and on the zero-row assertion.
   */
  it('refuses a signal at the projection when the command is bypassed', async () => {
    const { sessionId } = await openSession();
    await settle(sessionId);

    await expect(
      server.ledger.append({
        roomId: room.roomId,
        actor: { kind: 'human', userId: ownerId },
        build: ({ id, at }) => ({
          id,
          at,
          type: 'session_signaled' as const,
          roomId: room.roomId,
          sessionId,
          signalId: randomUUID(),
          kind: 'steer' as const,
          body: 'bypassing the command',
          causeMessageId: null,
          supersedesEventId: null,
          subscriptionId: null,
        }),
        project: async (context) => {
          const { projectRoomEvent } = await import('../../apps/server/src/projections.js');
          await projectRoomEvent(context, {});
        },
      }),
      // The PROJECTION's own sentence, not the command's — the two clauses are
      // asserted separately on purpose (see the note on that guard).
    ).rejects.toThrow(/refused at the PROJECTION/);
    expect(await signalRows(sessionId)).toHaveLength(0);
  });
});

describe('a resume is a draw, and it passes the #118 boundary', () => {
  /**
   * ACCEPTANCE 2, the covenant-critical one. A resume on a SPENT slice is REFUSED
   * as a durable `draw_refused` row, and NO signal lands (#123 resolution 2).
   *
   * #115 decision 2 defined the slice as authorized "spawns/continues"; #118 built
   * only the spawn half, so a free `resume` kind would have restarted paid work
   * outside the authorization boundary entirely — the campaign-stopping finding.
   * The slice here funds exactly the one spawn already taken, so the very next
   * continuation is the contested draw.
   *
   * RED-ON-REVERT: delete the `authorizedDraws + 1 > slice` refusal in
   * `resume_session` and the resume acks as a `session_signaled {resume}`, a
   * signal rows up, and `draw_refused` stays at zero — this test goes red three
   * ways.
   */
  it('REFUSES an over-slice resume as a draw_refused row, and no signal lands', async () => {
    const { planId, sessionId } = await openSession(1);
    expect((await planRow(planId))?.authorizedDraws).toBe(1);
    const alice = await connect(ownerId, 'human');

    const ack = await alice.command({
      name: 'resume_session',
      roomId: room.roomId,
      sessionId,
      body: 'carry on',
    });
    // The refusal is a durable ROW, not a dropped command, so it ACKs — and the
    // ack's `draw` outcome is how a caller tells it from a granted continuation.
    expect(ack.type).toBe('ack');
    if (ack.type === 'ack') {
      expect(ack.draw).toEqual({
        outcome: 'refused',
        reason: 'budget',
        slice: 1,
        authorizedDraws: 1,
      });
    }

    expect(await refusalCount()).toBe(1);
    expect(await signalRows(sessionId)).toHaveLength(0);
    // The committed accounting did not move: the draw was refused, not granted.
    expect((await planRow(planId))?.authorizedDraws).toBe(1);
  });

  /**
   * The other side of the same boundary: a resume WITHIN the slice is granted, it
   * rows up as a `session_signaled {kind:'resume'}`, and it SPENDS one draw. That
   * spend is what makes the refusal above reachable at all — a continuation that
   * checked the slice and never decremented it would let the second resume through
   * and the boundary would be ornament.
   *
   * RED-ON-REVERT: delete the `authorizedDraws + 1` increment in
   * `projectSessionSignaled` and the count stays at 1 — this test goes red, and so
   * does the over-slice test above once a second resume is free.
   */
  it('grants a resume within the slice and SPENDS one draw for it', async () => {
    const { planId, sessionId } = await openSession(2);
    const alice = await connect(ownerId, 'human');

    const granted = await alice.command({
      name: 'resume_session',
      roomId: room.roomId,
      sessionId,
      body: 'carry on',
    });
    expect(granted.type).toBe('ack');
    if (granted.type === 'ack') {
      expect(granted.draw).toEqual({ outcome: 'granted', sessionId });
    }
    expect((await planRow(planId))?.authorizedDraws).toBe(2);
    const rows = await signalRows(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'resume', subscriptionId: null });

    // The slice of 2 is now spent, so the SECOND continuation is refused.
    const refused = await alice.command({
      name: 'resume_session',
      roomId: room.roomId,
      sessionId,
      body: 'again',
    });
    expect(refused.type).toBe('ack');
    if (refused.type === 'ack') expect(refused.draw?.outcome).toBe('refused');
    expect(await signalRows(sessionId)).toHaveLength(1);
  });

  /**
   * A continuation is control over a process, so it is the agent's or its owner's
   * — a bystander cannot spend somebody else's plan's slice.
   *
   * RED-ON-REVERT: delete the `requireSessionControl` call in `resume_session` and
   * bob's resume acks as a grant — this test goes red on the nack and on the
   * unchanged draw count.
   */
  it('refuses a bystander’s resume — a continuation spends somebody else’s slice', async () => {
    const { planId, sessionId } = await openSession(5);
    const bob = await connect(bystanderId, 'human');

    const ack = await bob.command({
      name: 'resume_session',
      roomId: room.roomId,
      sessionId,
      body: 'carry on',
    });
    expect(ack.type).toBe('nack');
    if (ack.type === 'nack') {
      expect(ack.message).toContain('agent principal or the human who owns that agent');
    }
    expect((await planRow(planId))?.authorizedDraws).toBe(1);
    expect(await signalRows(sessionId)).toHaveLength(0);
  });
});

describe('a subscription always ends', () => {
  /** Register a wait, returning its row id. */
  async function subscribe(
    client: TestClient,
    sessionId: string,
    expiresAt: string,
    matcher = 'the migration lands',
  ) {
    const ack = await client.command({
      name: 'subscribe_session',
      roomId: room.roomId,
      sessionId,
      source: 'channel',
      matcher,
      expiresAt,
    });
    return ack;
  }

  function inFuture(ms: number): string {
    return new Date(Date.now() + ms).toISOString();
  }

  /**
   * A wait BORN past its horizon is refused (#123 resolution 6). `expiresAt` is
   * mandatory in the event so a wait without a horizon has no spelling at all;
   * this is the other half — a horizon already behind us owes attention
   * immediately and is not a wait.
   *
   * RED-ON-REVERT: delete the `subscriptionHorizonRefusal` throw in
   * `subscribe_session` and the past-dated wait acks and rows up as `waiting` —
   * this test goes red on the nack and on the zero-row assertion.
   */
  it('refuses a subscription whose horizon has already passed', async () => {
    const { sessionId } = await openSession();
    const alice = await connect(ownerId, 'human');

    const ack = await subscribe(alice, sessionId, new Date(Date.now() - 60_000).toISOString());
    expect(ack.type).toBe('nack');
    if (ack.type === 'nack') {
      expect(ack.message).toContain('is not in the future');
    }
    const rows = await handle.db.select().from(sessionSubscriptions);
    expect(rows).toHaveLength(0);
  });

  /**
   * FLIP THE INPUT — an unmatched subscription PAST its horizon escalates to the
   * agent's OWNER as `signal_raised`, and one still inside its horizon does not
   * (#123 resolution 6). The wait becomes owed ATTENTION rather than a
   * forever-open session silently blocking #119's plan-settle.
   *
   * The escalation names the SESSION as its subject — the fourth attention subject
   * — because that is what is owed: an item pointing at a message standing in for
   * a stalled process would misname it.
   *
   * RED-ON-REVERT: delete the `expires_at <= now` predicate in
   * `sweepExpiredSubscriptions` and the live wait escalates too (the second half
   * goes red); delete the `ledger.append` and nothing escalates at all (the first
   * half goes red).
   */
  it('escalates an expired wait to the agent’s owner, and leaves a live one alone', async () => {
    const { sessionId } = await openSession();
    const alice = await connect(ownerId, 'human');

    const expiring = await subscribe(alice, sessionId, inFuture(50), 'the thing that never comes');
    expect(expiring.type).toBe('ack');
    const live = await subscribe(alice, sessionId, inFuture(3_600_000), 'a patient wait');
    expect(live.type).toBe('ack');

    // Nothing is due yet: the sweep finds nothing and nobody is bothered.
    const early = await sweepExpiredSubscriptions({
      db: handle.db,
      ledger: server.ledger,
      logger: createLogger('error'),
      now: new Date(Date.now() - 1_000),
    });
    expect(early).toMatchObject({ found: 0, escalated: 0 });
    expect(await handle.db.select().from(attentionItems)).toHaveLength(0);

    // Past the first horizon, and only the first.
    const swept = await sweepExpiredSubscriptions({
      db: handle.db,
      ledger: server.ledger,
      logger: createLogger('error'),
      now: new Date(Date.now() + 60_000),
    });
    expect(swept).toMatchObject({ found: 1, escalated: 1, skipped: 0 });

    const items = await handle.db.select().from(attentionItems);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      // The AGENT'S OWNER, not the agent: escalation is UP, into a person.
      userId: ownerId,
      subjectKind: 'session',
      subjectId: sessionId,
      class: 'blocking_question',
      status: 'pending',
    });
    expect(items[0]?.reason).toMatchObject({
      kind: 'subscription_expired',
      matcher: 'the thing that never comes',
    });

    const subscriptions = await handle.db
      .select()
      .from(sessionSubscriptions)
      .orderBy(asc(sessionSubscriptions.expiresAt));
    expect(subscriptions.map((row) => row.status)).toEqual(['expired', 'waiting']);
    expect(subscriptions[0]?.escalatedAt).toBeTruthy();

    // Idempotent: a second sweep at the same instant finds the row no longer
    // `waiting` and escalates nothing twice.
    const again = await sweepExpiredSubscriptions({
      db: handle.db,
      ledger: server.ledger,
      logger: createLogger('error'),
      now: new Date(Date.now() + 60_000),
    });
    expect(again).toMatchObject({ found: 0, escalated: 0 });
    expect(await handle.db.select().from(attentionItems)).toHaveLength(1);
  });

  /**
   * A matching resume PAYS OUT the wait: the subscription flips to `matched` and
   * names the event that did it, and the same wait cannot be paid out twice.
   *
   * RED-ON-REVERT: delete the `status='matched'` UPDATE in
   * `projectSessionSignaled` and the wait stays `waiting` (so the sweep would
   * later escalate a wait that was already answered) — this test goes red.
   */
  it('matches a waiting subscription with a resume, once', async () => {
    const { sessionId } = await openSession(5);
    const alice = await connect(ownerId, 'human');
    expect((await subscribe(alice, sessionId, inFuture(3_600_000))).type).toBe('ack');
    const [wait] = await handle.db.select().from(sessionSubscriptions);
    const subscriptionId = wait?.id as string;

    const resumed = await alice.command({
      name: 'resume_session',
      roomId: room.roomId,
      sessionId,
      subscriptionId,
      body: 'it arrived',
    });
    expect(resumed.type).toBe('ack');
    const [matched] = await handle.db
      .select()
      .from(sessionSubscriptions)
      .where(eq(sessionSubscriptions.id, subscriptionId));
    expect(matched?.status).toBe('matched');
    expect(matched?.matchedByEventId).toBeTruthy();

    // A second resume naming the same wait is refused: it has had its disposition.
    const twice = await alice.command({
      name: 'resume_session',
      roomId: room.roomId,
      sessionId,
      subscriptionId,
      body: 'it arrived again',
    });
    expect(twice.type).toBe('nack');
    if (twice.type === 'nack') {
      expect(twice.message).toContain('is not a waiting subscription');
    }
    expect(await signalRows(sessionId)).toHaveLength(1);
  });

  /**
   * A SESSION'S EXIT DISPOSES ITS WAITS (#123 resolution 6). Once the process has
   * published its receipt there is nothing left to wake, so its waits stop being
   * `waiting` in the exit's own transaction — and the expiry sweep therefore never
   * escalates a wait about a session nobody can do anything with.
   *
   * RED-ON-REVERT: delete the disposal UPDATE in `projectSessionExit` and the wait
   * stays `waiting` after the settle — this test goes red on the status and on the
   * sweep finding it.
   */
  it('disposes a session’s waits when the session exits', async () => {
    const { sessionId } = await openSession();
    const alice = await connect(ownerId, 'human');
    expect((await subscribe(alice, sessionId, inFuture(50))).type).toBe('ack');

    await settle(sessionId);

    const [wait] = await handle.db.select().from(sessionSubscriptions);
    expect(wait?.status).toBe('disposed');

    const swept = await sweepExpiredSubscriptions({
      db: handle.db,
      ledger: server.ledger,
      logger: createLogger('error'),
      now: new Date(Date.now() + 60_000),
    });
    expect(swept).toMatchObject({ found: 0, escalated: 0 });
    expect(await handle.db.select().from(attentionItems)).toHaveLength(0);
  });
});

describe('the signal projections write their own tables and nothing else', () => {
  /**
   * THE PINNED WRITE-SET (#123 resolution 1, grok r1.9). A burst of steers and
   * interrupts and subscriptions folds through the real boundary, and the three
   * tables/columns the covenant and the purse live in are byte-stable across it:
   *
   *   * `accepted_objects` — every column of every row, including the two halves
   *     of the certification predicate. A steer cannot flip a `~` to a `✓`,
   *     because there is no statement in these projections that could.
   *   * `plans.rlimit_slice` — the human-set ceiling has exactly one writer
   *     (`projectPlanRlimitSet`, from the human-only `set_plan_rlimit`).
   *   * `plans.authorized_draws` — a steer and an interrupt are NOT draws. (A
   *     granted RESUME is, by design, and moves it by exactly one; that is the
   *     boundary tested above, and no resume appears in this burst.)
   *
   * RED-ON-REVERT: add any write to `accepted_objects`, `rlimit_slice` or
   * `authorized_draws` to `projectSessionSignaled` or `projectSessionSubscribed`
   * and one of the three snapshots below stops matching — this test goes red.
   */
  it('leaves accepted_objects, rlimit_slice and authorized_draws byte-stable under a signal burst', async () => {
    const { planId, sessionId } = await openSession(50);
    const alice = await connect(ownerId, 'human');
    const bob = await connect(bystanderId, 'human');

    // A machine reading, staged straight into the read model: a `~`, no human
    // touch. This is the row a covenant leak would show up in.
    const objectId = randomUUID();
    await handle.db.execute(sql`
      INSERT INTO accepted_objects (id, room_id, type, payload, revision, accepted_by_kind, human_touched_at)
      VALUES (${objectId}, ${room.roomId}::uuid, 'claim',
              ${JSON.stringify({ statement: 'a machine read this', verification: 'unverified' })}::jsonb,
              0, 'model', NULL)
    `);

    const before = {
      objects: await handle.db.select().from(acceptedObjects),
      plan: await planRow(planId),
    };

    for (let i = 0; i < 6; i += 1) {
      expect(
        (
          await bob.command({
            name: 'signal_session',
            roomId: room.roomId,
            sessionId,
            kind: 'steer',
            body: `steer ${i}`,
          })
        ).type,
      ).toBe('ack');
      expect(
        (
          await alice.command({
            name: 'signal_session',
            roomId: room.roomId,
            sessionId,
            kind: 'interrupt',
            body: `interrupt ${i}`,
          })
        ).type,
      ).toBe('ack');
      expect(
        (
          await alice.command({
            name: 'subscribe_session',
            roomId: room.roomId,
            sessionId,
            source: 'channel',
            matcher: `wait ${i}`,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          })
        ).type,
      ).toBe('ack');
    }

    // The burst really happened — 12 signals and 6 waits, all projected.
    expect(await signalRows(sessionId)).toHaveLength(12);
    expect(await handle.db.select().from(sessionSubscriptions)).toHaveLength(6);

    const after = {
      objects: await handle.db.select().from(acceptedObjects),
      plan: await planRow(planId),
    };
    expect(after.objects).toEqual(before.objects);
    expect(after.plan?.rlimitSlice).toBe(before.plan?.rlimitSlice);
    expect(after.plan?.authorizedDraws).toBe(before.plan?.authorizedDraws);
    // And the session itself is untouched by being signaled: a steer is not an exit.
    const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row?.status).toBe('open');
    expect(row?.exitSummary).toBeNull();
  });
});

/**
 * THE TABLE FACTS (drizzle/0045). Every guard above binds the command path and
 * the projection; these bind the TABLE, which is what stops a repair script, a
 * future projection, or a hand-written INSERT from writing the shape the command
 * refuses. Each is its own clause with its own constraint name, asserted through
 * `violatesConstraint` — a bare `rejects.toThrow` matches drizzle's wrapper and
 * would pass for the wrong reason.
 */
describe('the signal rules are facts about the tables, not only about the writers', () => {
  /**
   * RED-ON-REVERT: drop `session_signals_target_is_open` (or its trigger) and the
   * INSERT succeeds — a signal rows up against a process that has already
   * published its exit receipt.
   */
  it('refuses a hand-written signal at a session that has exited', async () => {
    const { sessionId } = await openSession();
    await settle(sessionId);
    await violatesConstraint('session_signals_target_is_open', () =>
      handle.db.execute(sql`
        INSERT INTO session_signals (room_id, session_id, kind, raised_by_user_id)
        VALUES (${room.roomId}::uuid, ${sessionId}::uuid, 'steer', ${ownerId}::uuid)
      `),
    );
  });

  /**
   * RED-ON-REVERT: drop `session_subscriptions_target_is_open` and a wait rows up
   * against an exited session — one that can never be matched, only escalated.
   */
  it('refuses a hand-written wait against a session that has exited', async () => {
    const { sessionId } = await openSession();
    await settle(sessionId);
    await violatesConstraint('session_subscriptions_target_is_open', () =>
      handle.db.execute(sql`
        INSERT INTO session_subscriptions (room_id, session_id, source, matcher, expires_at)
        VALUES (${room.roomId}::uuid, ${sessionId}::uuid, 'channel', 'anything', now() + interval '1 hour')
      `),
    );
  });

  /**
   * Only a resume pays out a wait. RED-ON-REVERT: drop
   * `session_signals_subscription_is_a_resume` and a steer can claim a
   * subscription it has no way to satisfy.
   */
  it('refuses a steer that claims to pay out a wait', async () => {
    const { sessionId } = await openSession();
    const alice = await connect(ownerId, 'human');
    expect(
      (
        await alice.command({
          name: 'subscribe_session',
          roomId: room.roomId,
          sessionId,
          source: 'channel',
          matcher: 'the migration lands',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        })
      ).type,
    ).toBe('ack');
    const [wait] = await handle.db.select().from(sessionSubscriptions);
    await violatesConstraint('session_signals_subscription_is_a_resume', () =>
      handle.db.execute(sql`
        INSERT INTO session_signals (room_id, session_id, kind, raised_by_user_id, subscription_id)
        VALUES (${room.roomId}::uuid, ${sessionId}::uuid, 'steer', ${ownerId}::uuid, ${wait?.id}::uuid)
      `),
    );
  });

  /**
   * The same-room provenance edge, as DDL. RED-ON-REVERT: drop
   * `session_signals_cause_same_room_fk` and a signal can cite a message from a
   * room this one cannot see — the command's refusal would then be the only thing
   * standing between the ledger and an unshowable citation.
   */
  it('refuses a hand-written signal citing another room’s message', async () => {
    const { sessionId } = await openSession();
    const elsewhereAuthor = await connect(otherRoom.people.alice as string, 'human');
    const elsewhere = await postMessage(elsewhereAuthor, otherRoom.roomId, 'over here');
    await violatesConstraint('session_signals_cause_same_room_fk', () =>
      handle.db.execute(sql`
        INSERT INTO session_signals (room_id, session_id, kind, raised_by_user_id, cause_message_id)
        VALUES (${room.roomId}::uuid, ${sessionId}::uuid, 'steer', ${ownerId}::uuid, ${elsewhere}::uuid)
      `),
    );
  });
});
