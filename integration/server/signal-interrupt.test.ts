import { randomUUID } from 'node:crypto';
import type { DatabaseHandle } from '@atrium/db';
import {
  attentionItems,
  coreEvents,
  messages,
  plans,
  sessionSignals,
  sessionSubscriptions,
} from '@atrium/db/schema';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
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
 * THE SIGNAL/INTERRUPT BOUNDARY (#127, from #123's resolution).
 *
 * Two ledger-only events on the #12 spine: `session_signaled {steer|interrupt|
 * resume}` and `session_subscribed`. These run through the REAL command boundary
 * (`TestClient` → ws → commands → ledger → projections) against the real
 * migrations. Every guard here is flip-the-input and red-on-revert:
 *
 *   1. A steered open session gets a receipted signal row with causeMessageId.
 *   2. A resume on a spent slice is REFUSED as a draw_refused, and no signal lands.
 *   3. A signal at a settled session is refused.
 *   4. An unmatched subscription past expiresAt raises attention to the owner.
 *   5. FLIP: a non-owner interrupt is refused; the agent and owner may interrupt.
 *   6. FLIP: a cross-room causeMessageId is refused.
 *
 * Plus: a granted resume is a draw (authorized_draws climbs, the wait matches), and
 * a session exit disposes its still-pending waits.
 */

let handle: DatabaseHandle;
let server: TestServer;
let room: SeededRoom;
let otherRoom: SeededRoom;
let ownerId: string; // alice — the agent's owner (init)
let agentId: string; // hexi — the agent principal whose channel this room is
let bystanderId: string; // bob — a room member who is neither agent nor owner
const open: TestClient[] = [];

async function connect(userId: string, principalKind: 'human' | 'agent'): Promise<TestClient> {
  const client = await TestClient.connect(server.url, userId, { principalKind });
  open.push(client);
  return client;
}

beforeEach(async () => {
  handle ??= openDatabase(10);
  await resetDatabase(handle);
  room = await seedRoom(handle, ['alice', 'hexi', 'bob'], { agents: ['hexi'] });
  ownerId = room.people.alice as string;
  agentId = room.people.hexi as string;
  bystanderId = room.people.bob as string;
  await handle.db.execute(
    sql`UPDATE rooms SET agent_user_id = ${agentId} WHERE id = ${room.roomId}`,
  );
  await handle.db.execute(sql`
    INSERT INTO agents (user_id, owner_user_id, channel_room_id, host, harness, model)
    VALUES (${agentId}, ${ownerId}, ${room.roomId}, 'localhost', 'claude', 'opus')
  `);
  // A second room, for the cross-room provenance flip. It gets its own message.
  otherRoom = await seedRoom(handle, ['alice'], { slug: 'other' });
  server = await startTestServer(handle);
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()));
  await server?.close();
});

afterAll(async () => {
  await handle?.close();
});

/** Fund a plan's slice directly — no `plan_rlimit_set` event, so signal counts stay clean. */
async function fundPlan(planId: string, slice: number): Promise<void> {
  await handle.db.execute(sql`UPDATE plans SET rlimit_slice = ${slice} WHERE id = ${planId}`);
}

/** Open a plan as the agent, fund it, and return its id. */
async function openFundedPlan(hexi: TestClient, slice: number, title = 'a plan'): Promise<string> {
  expect(
    (
      await hexi.command({
        name: 'open_plan',
        roomId: room.roomId,
        agentUserId: agentId,
        title,
        budgetLimitMicros: null,
      })
    ).type,
  ).toBe('ack');
  const [{ id } = { id: '' }] = await handle.db
    .select({ id: plans.id })
    .from(plans)
    .where(eq(plans.roomId, room.roomId))
    .orderBy(desc(plans.createdAt));
  await fundPlan(id, slice);
  return id;
}

/** Open one session (a draw) under the plan and return its id. */
async function openSession(hexi: TestClient, planId: string): Promise<string> {
  const ack = await hexi.command({
    name: 'open_session',
    roomId: room.roomId,
    planId,
    harness: 'omp',
    model: 'haiku',
  });
  expect(ack.type).toBe('ack');
  if (ack.type === 'ack' && ack.draw?.outcome === 'granted') return ack.draw.sessionId;
  throw new Error('expected a granted draw');
}

/** Post a message and return its id — an anchor for `causeMessageId`. */
async function postMessage(client: TestClient, roomId: string, body: string): Promise<string> {
  expect((await client.command({ name: 'send_message', roomId, body })).type).toBe('ack');
  const [{ id } = { id: '' }] = await handle.db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.roomId, roomId))
    .orderBy(desc(messages.seq));
  return id;
}

async function signalRows(sessionId: string) {
  return handle.db
    .select()
    .from(sessionSignals)
    .where(eq(sessionSignals.sessionId, sessionId))
    .orderBy(asc(sessionSignals.createdAt));
}

async function refusalCount(planId: string): Promise<number> {
  const rows = await handle.db
    .select({ payload: coreEvents.payload })
    .from(coreEvents)
    .where(and(eq(coreEvents.roomId, room.roomId), eq(coreEvents.type, 'draw_refused')));
  return rows.filter((r) => (r.payload as { planId?: string }).planId === planId).length;
}

async function planRow(planId: string) {
  const [row] = await handle.db.select().from(plans).where(eq(plans.id, planId));
  return row;
}

describe('the signal/interrupt boundary appends, projects, and guards', () => {
  /**
   * ACCEPTANCE 1. A steer against an open session lands a receipted `session_signals`
   * row carrying its `causeMessageId` provenance.
   *
   * RED-ON-REVERT: delete the `session_signals` insert in `projectSessionSignaled`
   * and the row is absent — this test goes red on `toHaveLength(1)`.
   */
  it('lands a steer with causeMessageId provenance against an open session', async () => {
    const alice = await connect(ownerId, 'human');
    const hexi = await connect(agentId, 'agent');
    const plan = await openFundedPlan(hexi, 1);
    const sessionId = await openSession(hexi, plan);
    const cause = await postMessage(
      alice,
      room.roomId,
      'wait for the CI run to finish, then continue',
    );

    const ack = await alice.command({
      name: 'signal_session',
      roomId: room.roomId,
      sessionId,
      kind: 'steer',
      causeMessageId: cause,
    });
    expect(ack.type).toBe('ack');

    const rows = await signalRows(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'steer',
      causeMessageId: cause,
      signaledByUserId: ownerId,
      signaledByKind: 'human',
      supersedesEventId: null,
      subscriptionId: null,
    });
    // Its id is the session_signaled event's own core_events.id — the supersede target.
    const [{ id: eventId } = { id: '' }] = await handle.db
      .select({ id: coreEvents.id })
      .from(coreEvents)
      .where(and(eq(coreEvents.roomId, room.roomId), eq(coreEvents.type, 'session_signaled')));
    expect(rows[0]?.id).toBe(eventId);
  });

  /**
   * ACCEPTANCE 2. A resume is a DRAW. On a spent slice it is REFUSED as a durable
   * `draw_refused` row, and NO `session_signals` row lands — no free wake.
   *
   * RED-ON-REVERT: drop the `authorized_draws + 1 > slice` refusal in
   * `resume_session` and the resume acks as a `session_signaled`, a signal row
   * lands, and `refusalCount` stays 0 — this test goes red.
   */
  it('REFUSES a resume on a spent slice as a draw_refused, and lands no signal', async () => {
    const hexi = await connect(agentId, 'agent');
    const plan = await openFundedPlan(hexi, 1); // funds exactly one draw
    const sessionId = await openSession(hexi, plan); // draw 1 spends the slice
    expect((await planRow(plan))?.authorizedDraws).toBe(1);

    const ack = await hexi.command({
      name: 'resume_session',
      roomId: room.roomId,
      sessionId,
    });
    // The refusal is a durable row, so it acks — but the draw outcome is 'refused'.
    expect(ack.type).toBe('ack');
    if (ack.type === 'ack') {
      expect(ack.draw).toEqual({
        outcome: 'refused',
        reason: 'budget',
        slice: 1,
        authorizedDraws: 1,
      });
    }
    expect(await refusalCount(plan)).toBe(1);
    // NO signal landed, and the committed accounting did not move.
    expect(await signalRows(sessionId)).toHaveLength(0);
    expect((await planRow(plan))?.authorizedDraws).toBe(1);
  });

  /**
   * A granted resume IS a draw: `authorized_draws` climbs by one and the wait it
   * consumed is `matched`.
   *
   * RED-ON-REVERT: remove the `authorized_draws + 1` increment in
   * `projectSessionSignaled`'s resume branch and the count stays at 1 — red.
   */
  it('grants a resume against a funded slice, drawing and matching its subscription', async () => {
    const alice = await connect(ownerId, 'human');
    const hexi = await connect(agentId, 'agent');
    const plan = await openFundedPlan(hexi, 2); // one draw for the open, one for the resume
    const sessionId = await openSession(hexi, plan);
    const cause = await postMessage(alice, room.roomId, 'subscribe to the deploy webhook');

    const subAck = await hexi.command({
      name: 'subscribe_session',
      roomId: room.roomId,
      sessionId,
      source: 'deploy-webhook',
      matcher: 'status==success',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      causeMessageId: cause,
    });
    expect(subAck.type).toBe('ack');
    const [{ id: subscriptionId } = { id: '' }] = await handle.db
      .select({ id: sessionSubscriptions.id })
      .from(sessionSubscriptions)
      .where(eq(sessionSubscriptions.sessionId, sessionId));

    const ack = await hexi.command({
      name: 'resume_session',
      roomId: room.roomId,
      sessionId,
      subscriptionId,
    });
    expect(ack.type).toBe('ack');
    if (ack.type === 'ack') expect(ack.draw?.outcome).toBe('granted');
    expect((await planRow(plan))?.authorizedDraws).toBe(2);

    const [sub] = await handle.db
      .select({ status: sessionSubscriptions.status })
      .from(sessionSubscriptions)
      .where(eq(sessionSubscriptions.id, subscriptionId));
    expect(sub?.status).toBe('matched');

    const resumeRows = (await signalRows(sessionId)).filter((r) => r.kind === 'resume');
    expect(resumeRows).toHaveLength(1);
    expect(resumeRows[0]?.subscriptionId).toBe(subscriptionId);
  });

  /**
   * ACCEPTANCE 3. A signal at a SETTLED session is refused — signals target open
   * sessions only, enforced by the projection nack (the 0025 trigger cannot, since
   * a signal is a fresh append, not a row edit).
   *
   * RED-ON-REVERT: remove the `status !== 'open'` throw in `projectSessionSignaled`
   * and the steer acks and a signal row lands against a concluded session — red.
   */
  it('REFUSES a signal at a settled session', async () => {
    const hexi = await connect(agentId, 'agent');
    const plan = await openFundedPlan(hexi, 1);
    const sessionId = await openSession(hexi, plan);
    expect(
      (
        await hexi.command({
          name: 'settle_session',
          roomId: room.roomId,
          sessionId,
          outcome: 'settled',
          exitSummary: 'done',
          spendMicros: 0,
          contextPct: 0,
        })
      ).type,
    ).toBe('ack');

    const ack = await hexi.command({
      name: 'signal_session',
      roomId: room.roomId,
      sessionId,
      kind: 'steer',
    });
    expect(ack.type).toBe('nack');
    if (ack.type === 'nack') expect(ack.message).toContain('not open');
    expect(await signalRows(sessionId)).toHaveLength(0);
  });

  /**
   * ACCEPTANCE 4. A subscription that reaches `expiresAt` unmatched becomes owed
   * attention: `expire_subscription` raises a `signal_raised` to the agent's OWNER
   * and disposes the wait to `expired`. A second sweep is a nack (idempotent).
   *
   * RED-ON-REVERT: remove the `attentionItems` insert in `projectSignalRaised` and
   * the owner has no attention row — red on `toHaveLength(1)`.
   */
  it('raises attention to the owner when a subscription expires unmatched', async () => {
    const alice = await connect(ownerId, 'human');
    const hexi = await connect(agentId, 'agent');
    const plan = await openFundedPlan(hexi, 1);
    const sessionId = await openSession(hexi, plan);
    const cause = await postMessage(alice, room.roomId, 'awaiting the external approval');

    // A wait whose horizon is already in the past — nothing matched it.
    expect(
      (
        await hexi.command({
          name: 'subscribe_session',
          roomId: room.roomId,
          sessionId,
          source: 'external-approval',
          matcher: 'approved==true',
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
          causeMessageId: cause,
        })
      ).type,
    ).toBe('ack');
    const [{ id: subscriptionId } = { id: '' }] = await handle.db
      .select({ id: sessionSubscriptions.id })
      .from(sessionSubscriptions)
      .where(eq(sessionSubscriptions.sessionId, sessionId));

    // The sweep escalates it to the owner (any member may trigger the sweep).
    expect(
      (await hexi.command({ name: 'expire_subscription', roomId: room.roomId, subscriptionId }))
        .type,
    ).toBe('ack');

    const attention = await handle.db
      .select()
      .from(attentionItems)
      .where(and(eq(attentionItems.roomId, room.roomId), eq(attentionItems.userId, ownerId)));
    expect(attention).toHaveLength(1);
    expect(attention[0]).toMatchObject({
      subjectKind: 'message',
      subjectId: cause,
      userId: ownerId,
    });

    const [sub] = await handle.db
      .select({ status: sessionSubscriptions.status })
      .from(sessionSubscriptions)
      .where(eq(sessionSubscriptions.id, subscriptionId));
    expect(sub?.status).toBe('expired');

    // A second sweep of the now-expired wait is a nack — no duplicate escalation.
    const again = await hexi.command({
      name: 'expire_subscription',
      roomId: room.roomId,
      subscriptionId,
    });
    expect(again.type).toBe('nack');
  });

  /**
   * A session exit DISPOSES its still-pending waits, so a wait cannot outlive its
   * session and block #119's plan-settle.
   *
   * RED-ON-REVERT: remove the disposing UPDATE in `projectSessionExit` and the wait
   * stays `pending` after the session settles — red.
   */
  it('disposes a pending subscription when its session exits', async () => {
    const alice = await connect(ownerId, 'human');
    const hexi = await connect(agentId, 'agent');
    const plan = await openFundedPlan(hexi, 1);
    const sessionId = await openSession(hexi, plan);
    const cause = await postMessage(alice, room.roomId, 'waiting on nothing in particular');
    await hexi.command({
      name: 'subscribe_session',
      roomId: room.roomId,
      sessionId,
      source: 's',
      matcher: 'm',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      causeMessageId: cause,
    });

    await hexi.command({
      name: 'settle_session',
      roomId: room.roomId,
      sessionId,
      outcome: 'settled',
      exitSummary: 'done',
      spendMicros: 0,
      contextPct: 0,
    });

    const [sub] = await handle.db
      .select({ status: sessionSubscriptions.status })
      .from(sessionSubscriptions)
      .where(eq(sessionSubscriptions.sessionId, sessionId));
    expect(sub?.status).toBe('disposed');
  });

  /**
   * ACCEPTANCE 5 — FLIP. An interrupt is the session's plan's agent principal or
   * that agent's owner ONLY. A bystanding room member's interrupt is refused; the
   * agent and the owner may each interrupt.
   *
   * RED-ON-REVERT: remove the interrupt authorization guard in `signal_session` and
   * bob's interrupt acks — red on the nack assertion.
   */
  it('REFUSES a non-owner interrupt; the agent and the owner may interrupt', async () => {
    const alice = await connect(ownerId, 'human');
    const hexi = await connect(agentId, 'agent');
    const bob = await connect(bystanderId, 'human');
    const plan = await openFundedPlan(hexi, 1);
    const sessionId = await openSession(hexi, plan);

    // Bob is a member but neither the agent nor its owner — refused before the append.
    const bobTry = await bob.command({
      name: 'signal_session',
      roomId: room.roomId,
      sessionId,
      kind: 'interrupt',
    });
    expect(bobTry.type).toBe('nack');
    if (bobTry.type === 'nack') expect(bobTry.message).toContain('interrupt');
    expect(await signalRows(sessionId)).toHaveLength(0);

    // The agent principal may interrupt its own session.
    expect(
      (
        await hexi.command({
          name: 'signal_session',
          roomId: room.roomId,
          sessionId,
          kind: 'interrupt',
        })
      ).type,
    ).toBe('ack');
    // The owner may interrupt.
    expect(
      (
        await alice.command({
          name: 'signal_session',
          roomId: room.roomId,
          sessionId,
          kind: 'interrupt',
        })
      ).type,
    ).toBe('ack');

    const interrupts = (await signalRows(sessionId)).filter((r) => r.kind === 'interrupt');
    expect(interrupts).toHaveLength(2);
    expect(interrupts.map((r) => r.signaledByUserId).sort()).toEqual([agentId, ownerId].sort());
  });

  /**
   * ACCEPTANCE 6 — FLIP. A cross-room `causeMessageId` is refused: the composite
   * same-room FK on `session_signals` will not let a signal cite a message from
   * another room.
   *
   * RED-ON-REVERT: drop `session_signals_cause_message_same_room_fk` and the steer
   * acks with a cross-room provenance pointer — red on the nack assertion.
   */
  it('REFUSES a cross-room causeMessageId', async () => {
    const alice = await connect(ownerId, 'human');
    const hexi = await connect(agentId, 'agent');
    const plan = await openFundedPlan(hexi, 1);
    const sessionId = await openSession(hexi, plan);
    // A message that lives in the OTHER room — inserted directly, since the client
    // is not a member there (`seedRoom` mints a distinct roster per room).
    const foreignCause = randomUUID();
    await handle.db.insert(messages).values({
      id: foreignCause,
      roomId: otherRoom.roomId,
      authorId: null,
      body: 'a message in another room',
    });

    const ack = await alice.command({
      name: 'signal_session',
      roomId: room.roomId,
      sessionId,
      kind: 'steer',
      causeMessageId: foreignCause,
    });
    expect(ack.type).toBe('nack');
    expect(await signalRows(sessionId)).toHaveLength(0);
  });
});
