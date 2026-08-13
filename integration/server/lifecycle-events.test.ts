import { randomUUID } from 'node:crypto';
import { epistemicStateOf } from '@atrium/core';
import type { DatabaseHandle } from '@atrium/db';
import {
  acceptedObjects,
  attentionItems,
  coreEvents,
  messages,
  plans,
  sessions,
} from '@atrium/db/schema';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
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
 * The agent/plan/session lifecycle, end to end (#116): the five verbs append
 * their six ledger-only events through the REAL boundary and project into
 * `plans` / `sessions`, and — the load-bearing claim — none of it moves the
 * covenant.
 *
 * The covenant-untouched proof is the flip-the-input the ticket asks for: a
 * settled `~` object is read before and after a full plan/session lifecycle runs
 * over the same room, and it is byte-identical. A `session_settled` / `_failed`
 * writes only `sessions`; it cannot reach an `accepted_objects` judgement column,
 * so `~` stays `~`.
 */

let handle: DatabaseHandle;
let server: TestServer;
let room: SeededRoom;
let agentId: string;
let humanId: string;
const open: TestClient[] = [];

async function connect(userId: string, principalKind: 'human' | 'agent'): Promise<TestClient> {
  const client = await TestClient.connect(server.url, userId, { principalKind });
  open.push(client);
  return client;
}

beforeEach(async () => {
  handle ??= openDatabase(10);
  await resetDatabase(handle);
  // alice is the human owner; hexi is an agent member whose channel is this room.
  room = await seedRoom(handle, ['alice', 'hexi'], { agents: ['hexi'] });
  humanId = room.people.alice as string;
  agentId = room.people.hexi as string;
  // Claim the channel before the sidecar: 0024's composite FK reads it.
  await handle.db.execute(sql`
    UPDATE rooms SET agent_user_id = ${agentId} WHERE id = ${room.roomId}
  `);
  await handle.db.execute(sql`
    INSERT INTO agents (user_id, owner_user_id, channel_room_id, host, harness, model)
    VALUES (${agentId}, ${humanId}, ${room.roomId}, 'localhost', 'claude', 'opus')
  `);
  server = await startTestServer(handle);
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()));
  await server?.close();
});

afterAll(async () => {
  await handle?.close();
});

/** Seed a machine reading directly into the read model: a `~`, no human touch. */
async function seedMachineReading(): Promise<string> {
  const id = randomUUID();
  await handle.db.execute(sql`
    INSERT INTO accepted_objects (id, room_id, type, payload, revision, accepted_by_kind, human_touched_at)
    VALUES (${id}, ${room.roomId}, 'claim',
            ${JSON.stringify({ statement: 'a machine read this', verification: 'unverified' })}::jsonb,
            0, 'model', NULL)
  `);
  return id;
}

describe('the agent/plan/session lifecycle appends, projects, and touches no covenant', () => {
  it('opens a plan and a session under it, and settles the session', async () => {
    const hexi = await connect(agentId, 'agent');

    const openPlan = await hexi.command({
      name: 'open_plan',
      roomId: room.roomId,
      agentUserId: agentId,
      title: 'users migration',
      budgetLimitMicros: 5_000_000,
    });
    expect(openPlan.type).toBe('ack');

    const [plan] = await handle.db.select().from(plans).where(eq(plans.roomId, room.roomId));
    expect(plan).toMatchObject({ status: 'open', agentUserId: agentId, title: 'users migration' });
    expect(plan?.openedByEventId).toBeTruthy();

    const openSession = await hexi.command({
      name: 'open_session',
      roomId: room.roomId,
      planId: plan?.id as string,
      harness: 'omp',
      model: 'haiku',
    });
    expect(openSession.type).toBe('ack');

    const [session] = await handle.db
      .select()
      .from(sessions)
      .where(eq(sessions.roomId, room.roomId));
    expect(session).toMatchObject({ status: 'open', planId: plan?.id, harness: 'omp' });

    const settle = await hexi.command({
      name: 'settle_session',
      roomId: room.roomId,
      sessionId: session?.id as string,
      outcome: 'settled',
      exitSummary: '4.1M rows migrated',
      spendMicros: 1_800_000,
      contextPct: 0.41,
    });
    expect(settle.type).toBe('ack');

    const [settled] = await handle.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, session?.id as string));
    expect(settled).toMatchObject({
      status: 'settled',
      exitSummary: '4.1M rows migrated',
      spendMicros: 1_800_000,
    });
    expect(settled?.settledByEventId).toBeTruthy();

    // All three landed on the spine as ledger-only rows, in order.
    const rows = await handle.db
      .select({ type: coreEvents.type })
      .from(coreEvents)
      .where(eq(coreEvents.roomId, room.roomId))
      .orderBy(asc(coreEvents.roomSeq));
    expect(rows.map((r) => r.type)).toEqual(['plan_opened', 'session_opened', 'session_settled']);
  });

  it('settles a session as FAILED, a distinct exit', async () => {
    const hexi = await connect(agentId, 'agent');
    const plan = await hexi.command({
      name: 'open_plan',
      roomId: room.roomId,
      agentUserId: agentId,
      title: 'flaky-test hunt',
      budgetLimitMicros: null,
    });
    expect(plan.type).toBe('ack');
    const [{ id: planId } = { id: '' }] = await handle.db
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.roomId, room.roomId));
    await hexi.command({
      name: 'open_session',
      roomId: room.roomId,
      planId,
      harness: 'claude',
      model: 'opus',
    });
    const [{ id: sessionId } = { id: '' }] = await handle.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.roomId, room.roomId));
    const failed = await hexi.command({
      name: 'settle_session',
      roomId: room.roomId,
      sessionId,
      outcome: 'failed',
      exitSummary: 'harness died mid-run',
      spendMicros: null,
      contextPct: null,
    });
    expect(failed.type).toBe('ack');
    const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row?.status).toBe('failed');
    // A failed exit is a ledger row of its own kind, not a settled one.
    const [event] = await handle.db
      .select({ type: coreEvents.type })
      .from(coreEvents)
      .where(eq(coreEvents.id, row?.settledByEventId as string));
    expect(event?.type).toBe('session_failed');
  });

  /**
   * THE FLIP (#114 T3). A `~` is read, then a full lifecycle runs over the same
   * room — and, per the round-1 gauntlet finding 6, ALL SIX lifecycle events, not
   * three: plan opened, a session opened+settled, a second session opened+FAILED,
   * a signal raised, and the plan settled. The `~` is read again: byte-identical,
   * still `~`. If any of the six could reach a judgement column, this is where it
   * would show; none can, so none does.
   */
  it('runs ALL SIX lifecycle events without moving a ~ to a ✓ (the covenant is untouched)', async () => {
    const claimId = await seedMachineReading();

    /**
     * The whole-table, GLOBAL census, not just the one seeded row nor just this
     * room (#116 fix r3, F-D; strengthened again r3.1 per the round-3 gauntlet
     * finding F-D — the census was still an incomplete proxy for the `✓`
     * predicate on two axes).
     *
     * Axis 1 — scope: a room filter (`WHERE room_id = ...`) makes a projection
     * that certifies an object in a DIFFERENT room invisible. The covenant binds
     * every lifecycle projection everywhere, not just in this test's room, so
     * the census counts across ALL rooms.
     *
     * Axis 2 — predicate: `certified` must mirror `epistemicStateOf`
     * (packages/core/src/epistemic.ts) exactly — `isHuman(acceptedBy) ||
     * humanTouchedAt !== null` — not just the second half. A projection that set
     * `accepted_by_kind = 'human'` without ever touching `human_touched_at`
     * would earn a `✓` under the real predicate (`isHuman` alone confirms it)
     * while leaving a `humanTouchedAt IS NOT NULL`-only census unmoved.
     *
     * Asserting the seeded `~` is byte-unchanged catches a projection that
     * REWRITES it — but not one that CERTIFIES a *different* or *new* object
     * anywhere in the database. So the covenant claim is measured globally: how
     * many objects exist, and how many are certified by the full predicate. If
     * no lifecycle projection may reach a judgement column, BOTH numbers are
     * invariant across the six events, and "byte-unchanged seeded row" becomes
     * one corollary of the stronger "the certified census does not move".
     */
    const census = async () => {
      const [row] = await handle.db
        .select({
          total: sql<number>`count(*)::int`,
          certified: sql<number>`count(*) FILTER (WHERE ${acceptedObjects.acceptedByKind} = 'human' OR ${acceptedObjects.humanTouchedAt} IS NOT NULL)::int`,
        })
        .from(acceptedObjects);
      return row ?? { total: 0, certified: 0 };
    };
    const censusBefore = await census();
    // The harness resets the whole database before each test (see beforeEach),
    // so the global census equals the single-room census here: the seeded
    // reading is the only object in the database, a `~`, so zero certified.
    expect(censusBefore).toEqual({ total: 1, certified: 0 });

    const before = await handle.db
      .select()
      .from(acceptedObjects)
      .where(eq(acceptedObjects.id, claimId));
    const b = before[0];
    expect(b).toBeTruthy();
    // The read model's covenant verdict for this row: a machine reading, no human
    // touch — a `~`. Computed the same way the product computes it.
    expect(
      epistemicStateOf({
        acceptedBy: { kind: b?.acceptedByKind ?? 'model' },
        humanTouchedAt: b?.humanTouchedAt?.toISOString() ?? null,
      }),
    ).toBe('unconfirmed');

    const alice = await connect(humanId, 'human');
    const hexi = await connect(agentId, 'agent');

    // (1) plan_opened
    await hexi.command({
      name: 'open_plan',
      roomId: room.roomId,
      agentUserId: agentId,
      title: 'work beside a claim',
      budgetLimitMicros: null,
    });
    const [{ id: planId } = { id: '' }] = await handle.db
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.roomId, room.roomId));

    // (2) session_opened, (3) session_settled
    await hexi.command({
      name: 'open_session',
      roomId: room.roomId,
      planId,
      harness: 'omp',
      model: 'haiku',
    });
    const [{ id: sessionId } = { id: '' }] = await handle.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.roomId, room.roomId));
    await hexi.command({
      name: 'settle_session',
      roomId: room.roomId,
      sessionId,
      outcome: 'settled',
      exitSummary: 'done',
      spendMicros: 100,
      contextPct: 0.5,
    });

    // (4) session_failed — a second session under the same plan, this one fails.
    await hexi.command({
      name: 'open_session',
      roomId: room.roomId,
      planId,
      harness: 'omp',
      model: 'haiku',
    });
    const [{ id: failedSessionId } = { id: '' }] = await handle.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.roomId, room.roomId), eq(sessions.status, 'open')));
    await hexi.command({
      name: 'settle_session',
      roomId: room.roomId,
      sessionId: failedSessionId,
      outcome: 'failed',
      exitSummary: 'harness died',
      spendMicros: null,
      contextPct: null,
    });

    // (5) signal_raised — an escalation about a real message, to the human.
    const post = await alice.command({
      name: 'send_message',
      roomId: room.roomId,
      body: 'a message to escalate about',
      clientMessageId: null,
      replyToId: null,
      attachments: [],
      references: [],
    });
    expect(post.type).toBe('ack');
    const [msg] = await handle.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.roomId, room.roomId));
    await hexi.command({
      name: 'raise_signal',
      roomId: room.roomId,
      targetUserId: humanId,
      subjectKind: 'message',
      subjectId: msg?.id as string,
      class: 'blocking_question',
      reason: { kind: 'question_names_you', question: 'sign off?' },
    });

    // (6) plan_settled — close the board last.
    await hexi.command({ name: 'settle_plan', roomId: room.roomId, planId });

    // All six kinds rode the spine.
    const kinds = await handle.db
      .select({ type: coreEvents.type })
      .from(coreEvents)
      .where(eq(coreEvents.roomId, room.roomId))
      .orderBy(asc(coreEvents.roomSeq));
    expect(new Set(kinds.map((k) => k.type))).toEqual(
      new Set([
        'plan_opened',
        'session_opened',
        'session_settled',
        'session_failed',
        'message_posted',
        'signal_raised',
        'plan_settled',
      ]),
    );

    // The GLOBAL census, under the FULL `✓` predicate, has not moved: no
    // lifecycle arm inserted a certified row anywhere, none flipped an existing
    // one's `human_touched_at`, and none set `accepted_by_kind = 'human'`
    // without a human touch either. This is the assertion the single-row check
    // could not make — a projection certifying some OTHER object, in this room
    // or any other, would pass byte-equality on `claimId` and fail here.
    expect(await census()).toEqual(censusBefore);

    const after = await handle.db
      .select()
      .from(acceptedObjects)
      .where(eq(acceptedObjects.id, claimId));
    const a = after[0];
    // Byte-for-byte: not one of the six moved anything on the object. Same kind,
    // same (absent) human touch, same payload, same revision.
    expect(a).toEqual(b);
    expect(
      epistemicStateOf({
        acceptedBy: { kind: a?.acceptedByKind ?? 'model' },
        humanTouchedAt: a?.humanTouchedAt?.toISOString() ?? null,
      }),
    ).toBe('unconfirmed');
  });

  /**
   * ONE EXIT PER SESSION, ONCE (#116 fix r2, finding 4). A settle of a session
   * that does not exist in this room, and a re-settle of one that already exited,
   * must both `nack` and write NO ledger row — a zero-row projection UPDATE aborts
   * the append, the same shape `projectAttentionResolved` uses.
   */
  it('refuses settling a session that does not exist, and writes nothing', async () => {
    const hexi = await connect(agentId, 'agent');
    await hexi.command({
      name: 'open_plan',
      roomId: room.roomId,
      agentUserId: agentId,
      title: 'p',
      budgetLimitMicros: null,
    });
    const refused = await hexi.command({
      name: 'settle_session',
      roomId: room.roomId,
      sessionId: randomUUID(), // a ghost
      outcome: 'settled',
      exitSummary: 'never happened',
      spendMicros: null,
      contextPct: null,
    });
    expect(refused.type).toBe('nack');
    const [{ n } = { n: 0 }] = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(coreEvents)
      .where(and(eq(coreEvents.roomId, room.roomId), eq(coreEvents.type, 'session_settled')));
    expect(n).toBe(0);
  });

  it('refuses a SECOND exit for a session, so settled cannot flip to failed', async () => {
    const hexi = await connect(agentId, 'agent');
    await hexi.command({
      name: 'open_plan',
      roomId: room.roomId,
      agentUserId: agentId,
      title: 'p',
      budgetLimitMicros: null,
    });
    const [{ id: planId } = { id: '' }] = await handle.db
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.roomId, room.roomId));
    await hexi.command({
      name: 'open_session',
      roomId: room.roomId,
      planId,
      harness: 'claude',
      model: 'opus',
    });
    const [{ id: sessionId } = { id: '' }] = await handle.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.roomId, room.roomId));
    const first = await hexi.command({
      name: 'settle_session',
      roomId: room.roomId,
      sessionId,
      outcome: 'settled',
      exitSummary: 'clean',
      spendMicros: null,
      contextPct: null,
    });
    expect(first.type).toBe('ack');
    // The re-settle as a FAILURE: without the `status = 'open'` predicate this
    // would rewrite the receipt settled→failed. It must nack instead.
    const second = await hexi.command({
      name: 'settle_session',
      roomId: room.roomId,
      sessionId,
      outcome: 'failed',
      exitSummary: 'contradiction',
      spendMicros: null,
      contextPct: null,
    });
    expect(second.type).toBe('nack');
    const [row] = await handle.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row?.status).toBe('settled'); // still settled — the flip was refused
    // And exactly one exit event landed, not two.
    const [{ n } = { n: 0 }] = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(coreEvents)
      .where(
        and(
          eq(coreEvents.roomId, room.roomId),
          inArray(coreEvents.type, ['session_settled', 'session_failed']),
        ),
      );
    expect(n).toBe(1);
  });

  it('refuses re-settling a plan, and settling a ghost plan (one exit per plan)', async () => {
    const hexi = await connect(agentId, 'agent');
    await hexi.command({
      name: 'open_plan',
      roomId: room.roomId,
      agentUserId: agentId,
      title: 'p',
      budgetLimitMicros: null,
    });
    const [{ id: planId } = { id: '' }] = await handle.db
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.roomId, room.roomId));
    expect((await hexi.command({ name: 'settle_plan', roomId: room.roomId, planId })).type).toBe(
      'ack',
    );
    // Re-settle: refused.
    expect((await hexi.command({ name: 'settle_plan', roomId: room.roomId, planId })).type).toBe(
      'nack',
    );
    // A ghost plan: refused.
    expect(
      (await hexi.command({ name: 'settle_plan', roomId: room.roomId, planId: randomUUID() })).type,
    ).toBe('nack');
    const [{ n } = { n: 0 }] = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(coreEvents)
      .where(and(eq(coreEvents.roomId, room.roomId), eq(coreEvents.type, 'plan_settled')));
    expect(n).toBe(1);
  });

  /**
   * The pstree invariant refuses a cross-plan session through the REAL append
   * path too, not only a raw SQL insert: a command naming a plan from another
   * room is refused, the projection's composite FK aborting the transaction so
   * the `session_opened` leaves no ledger row.
   */
  it('refuses opening a session under a plan from another room, and leaves no row', async () => {
    // A second agent channel with a plan of its own.
    const other = await seedRoom(handle, ['carol', 'nova'], { slug: 'ops', agents: ['nova'] });
    const novaId = other.people.nova as string;
    await handle.db.execute(sql`
      UPDATE rooms SET agent_user_id = ${novaId} WHERE id = ${other.roomId}
    `);
    await handle.db.execute(sql`
      INSERT INTO agents (user_id, owner_user_id, channel_room_id, host, harness, model)
      VALUES (${novaId}, ${other.people.carol}, ${other.roomId}, 'h', 'claude', 'opus')
    `);
    const nova = await connect(novaId, 'agent');
    await nova.command({
      name: 'open_plan',
      roomId: other.roomId,
      agentUserId: novaId,
      title: 'ops plan',
      budgetLimitMicros: null,
    });
    const [{ id: otherPlanId } = { id: '' }] = await handle.db
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.roomId, other.roomId));

    // hexi, in ITS room, tries to open a session under ops' plan.
    const hexi = await connect(agentId, 'agent');
    const refused = await hexi.command({
      name: 'open_session',
      roomId: room.roomId,
      planId: otherPlanId,
      harness: 'omp',
      model: 'haiku',
    });
    expect(refused.type).toBe('nack');

    const [{ n } = { n: 0 }] = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(coreEvents)
      .where(and(eq(coreEvents.roomId, room.roomId), eq(coreEvents.type, 'session_opened')));
    expect(n).toBe(0);
  });

  /**
   * A SESSION MAY OPEN ONLY UNDER AN OPEN PLAN (#116 fix r3, F-A). The composite
   * FK checks the parent EXISTS, not that it is still open, so round 2 let
   * `open_plan → settle_plan → open_session{planId}` all ack — grafting a fresh
   * open session onto a settled plan whose receipt had already closed.
   * `projectSessionOpened` now reads `plans.status` under the append lock; a
   * settled parent aborts the projection, so the `session_opened` nacks and
   * leaves no ledger row and no session.
   *
   * RED without the fix: revert the status check in `projectSessionOpened` and
   * the open-session below acks, a session rows up under the settled plan, and
   * the `session_opened` count is 1.
   */
  it('refuses opening a session under a SETTLED plan, and writes nothing', async () => {
    const hexi = await connect(agentId, 'agent');
    await hexi.command({
      name: 'open_plan',
      roomId: room.roomId,
      agentUserId: agentId,
      title: 'a plan that will close',
      budgetLimitMicros: null,
    });
    const [{ id: planId } = { id: '' }] = await handle.db
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.roomId, room.roomId));

    // Close the board.
    expect((await hexi.command({ name: 'settle_plan', roomId: room.roomId, planId })).type).toBe(
      'ack',
    );

    // Now try to graft a new session onto the settled plan.
    const refused = await hexi.command({
      name: 'open_session',
      roomId: room.roomId,
      planId,
      harness: 'omp',
      model: 'haiku',
    });
    expect(refused.type).toBe('nack');

    // No session rowed up…
    const sessionRows = await handle.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.roomId, room.roomId));
    expect(sessionRows).toHaveLength(0);
    // …and no `session_opened` landed on the spine: the projection aborted the
    // append, so there is nothing durable to replay.
    const [{ n } = { n: 0 }] = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(coreEvents)
      .where(and(eq(coreEvents.roomId, room.roomId), eq(coreEvents.type, 'session_opened')));
    expect(n).toBe(0);
  });

  /**
   * A signal escalates to a participant's attention (#112 reuse). It names an
   * existing room subject and a target, and projects one `attention_items` row —
   * the escalation mechanism, without the full signal semantics (#115). Here the
   * agent raises a blocking question about a message, to the human owner.
   */
  it('raises a signal into the human’s attention register', async () => {
    // A real message to point the signal at (the subject FK must resolve).
    const alice = await connect(humanId, 'human');
    const post = await alice.command({
      name: 'send_message',
      roomId: room.roomId,
      body: 'the cutover message',
      clientMessageId: null,
      replyToId: null,
      attachments: [],
      references: [],
    });
    expect(post.type).toBe('ack');
    const [msg] = await handle.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.roomId, room.roomId));

    const hexi = await connect(agentId, 'agent');
    const raised = await hexi.command({
      name: 'raise_signal',
      roomId: room.roomId,
      targetUserId: humanId,
      subjectKind: 'message',
      subjectId: msg?.id as string,
      class: 'blocking_question',
      reason: { kind: 'question_names_you', question: 'hold the cutover until you sign off?' },
    });
    expect(raised.type).toBe('ack');

    const items = await handle.db
      .select()
      .from(attentionItems)
      .where(and(eq(attentionItems.roomId, room.roomId), eq(attentionItems.userId, humanId)));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      subjectKind: 'message',
      subjectId: msg?.id,
      class: 'blocking_question',
      status: 'pending',
    });
    // It rode the spine as a ledger-only kind, not a covenant event.
    const [signalRow] = await handle.db
      .select({ type: coreEvents.type })
      .from(coreEvents)
      .where(and(eq(coreEvents.roomId, room.roomId), eq(coreEvents.type, 'signal_raised')));
    expect(signalRow?.type).toBe('signal_raised');
  });
});
