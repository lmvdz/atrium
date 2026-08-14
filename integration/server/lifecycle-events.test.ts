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
  startSecondInstance,
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

/**
 * Fund a plan so its sessions authorize. Since #118 fix r2 (CS-1) an unfunded
 * plan (NULL slice) authorizes ZERO draws — every `open_session` under it is
 * refused. These lifecycle tests are not about the budget gate (that is
 * budget-enforcement.test.ts), so they set the slice DIRECTLY rather than through
 * a human `set_plan_rlimit` — a raw UPDATE adds no `plan_rlimit_set` ledger event
 * and so leaves the exact event-sequence assertions below undisturbed.
 */
async function fundPlan(planId: string, slice = 1_000): Promise<void> {
  await handle.db.execute(sql`UPDATE plans SET rlimit_slice = ${slice} WHERE id = ${planId}`);
}

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
    await fundPlan(plan?.id as string);

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
    await fundPlan(planId);
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

    // The plan must be funded before it can draw (#118 CS-1). Raw, so no
    // plan_rlimit_set joins the six lifecycle kinds this test enumerates below.
    await fundPlan(planId);

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
    await fundPlan(planId);
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
   * A PLAN MAY NOT SETTLE WHILE A CHILD SESSION IS STILL OPEN (#119, the mirror
   * of #116 F-A). The map #113 destination is "the plan settles to a receipt
   * INDEXING ITS SESSIONS' RECEIPTS" — a receipt cannot index a child receipt
   * that does not exist yet. `projectPlanSettled` reads the children `FOR SHARE`
   * under the append lock; an open child aborts the projection, so `settle_plan`
   * nacks and leaves no `plan_settled` ledger row. After the child settles, the
   * plan settles and its receipt genuinely indexes a settled child.
   *
   * RED without the app fix: revert the open-child read in `projectPlanSettled`
   * and the first `settle_plan` below acks, a `plan_settled` rows up over the
   * open child, and the nack assertion fails.
   *
   * F3 (#119 fix round 2, false-green): a bare `refused.type === 'nack'` check
   * stays green even with the app guard reverted, because 0031's `BEFORE
   * UPDATE` trigger backstops it — the settle still nacks, just for the
   * trigger's reason instead of the app's. That makes the app guard's own
   * contribution untested: this test could not tell "the app guard works" from
   * "the app guard is gone and the trigger alone is carrying it." So this also
   * asserts the SPECIFIC app-layer message `projectPlanSettled` throws
   * (`... open child session(s) and may not settle ... so the plan's receipt
   * can index its children's receipts`, apps/server/src/projections.ts) — a
   * message the trigger's own SQLSTATE 23514 exception, wired with different
   * text, never produces. Revert only the app guard and this assertion reds
   * even though the outer nack still happens; restore it and it goes green.
   */
  it('refuses settling a plan while a child session is open, then settles once it exits', async () => {
    const hexi = await connect(agentId, 'agent');
    await hexi.command({
      name: 'open_plan',
      roomId: room.roomId,
      agentUserId: agentId,
      title: 'a plan with a live child',
      budgetLimitMicros: null,
    });
    const [{ id: planId } = { id: '' }] = await handle.db
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.roomId, room.roomId));
    await fundPlan(planId);
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

    // Settle the plan while the session is still open — refused, no ledger row.
    const refused = await hexi.command({ name: 'settle_plan', roomId: room.roomId, planId });
    expect(refused.type).toBe('nack');
    // The message is the APP GUARD's, not the DB trigger's — proves this test
    // is exercising `projectPlanSettled`'s own read, not merely riding on 0031's
    // backstop. The trigger's text ("a child session is still open") never
    // appears here.
    expect((refused as { message: string }).message).toContain(
      'open child session(s) and may not settle',
    );
    expect((refused as { message: string }).message).toContain(
      "so the plan's receipt can index its children's receipts",
    );
    let [{ n } = { n: 0 }] = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(coreEvents)
      .where(and(eq(coreEvents.roomId, room.roomId), eq(coreEvents.type, 'plan_settled')));
    expect(n).toBe(0);
    const [stillOpen] = await handle.db.select().from(plans).where(eq(plans.id, planId));
    expect(stillOpen?.status).toBe('open'); // the plan did not close

    // Exit the child, then settle the plan — now it succeeds.
    const settleSession = await hexi.command({
      name: 'settle_session',
      roomId: room.roomId,
      sessionId,
      outcome: 'settled',
      exitSummary: 'child done',
      spendMicros: null,
      contextPct: null,
    });
    expect(settleSession.type).toBe('ack');
    const settlePlan = await hexi.command({ name: 'settle_plan', roomId: room.roomId, planId });
    expect(settlePlan.type).toBe('ack');

    // The plan closed exactly once, and its receipt indexes the settled child:
    // both the plan's and the child's settle events are on the spine.
    const [settledPlan] = await handle.db.select().from(plans).where(eq(plans.id, planId));
    expect(settledPlan?.status).toBe('settled');
    expect(settledPlan?.settledByEventId).toBeTruthy();
    [{ n } = { n: 0 }] = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(coreEvents)
      .where(and(eq(coreEvents.roomId, room.roomId), eq(coreEvents.type, 'plan_settled')));
    expect(n).toBe(1);
    const [settledChild] = await handle.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(settledChild?.status).toBe('settled');
    expect(settledChild?.settledByEventId).toBeTruthy();
  });

  /**
   * A HUMAN MAY SETTLE A PLAN — the run-book's settle path (#146). `settle_plan`
   * is an OPEN-class command, not human-only like certify or set_plan_rlimit: the
   * pre-append gate refuses only `certifies`/`authorizes-spend`, and settle is
   * neither. #140's resolution homes the steady-state settle in the daemon (#139,
   * unbuilt), but the run-book's first, daemon-less runs need a human to close a
   * plan — and the same open-class command serves both. This is the witness that a
   * human's `settle_plan` is honoured (once children have exited), so the plan pane
   * offering it is legal, not a control the server would only nack.
   *
   * RED ON REVERT: add `settle_plan` to the `authorizes-spend`/`certifies` class in
   * `certificationClassOf`, and this human settle nacks `invalid` (human = init /
   * not_human) — the run-book's human settle path would be gone.
   */
  it("a HUMAN settles a plan once its children have exited — the run-book's settle path", async () => {
    const hexi = await connect(agentId, 'agent');
    const alice = await connect(humanId, 'human');
    await hexi.command({
      name: 'open_plan',
      roomId: room.roomId,
      agentUserId: agentId,
      title: 'a plan a human will settle',
      budgetLimitMicros: null,
    });
    const [{ id: planId } = { id: '' }] = await handle.db
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.roomId, room.roomId));
    await fundPlan(planId);
    const opened = await hexi.command({
      name: 'open_session',
      roomId: room.roomId,
      planId,
      harness: 'omp',
      model: 'haiku',
    });
    expect(opened.type).toBe('ack');
    const [{ id: sessionId } = { id: '' }] = await handle.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.roomId, room.roomId));
    const settledSession = await hexi.command({
      name: 'settle_session',
      roomId: room.roomId,
      sessionId,
      outcome: 'settled',
      exitSummary: 'done',
      spendMicros: null,
      contextPct: null,
    });
    expect(settledSession.type).toBe('ack');

    // The HUMAN settles the plan — accepted, not refused as a human-only violation.
    const humanSettle = await alice.command({ name: 'settle_plan', roomId: room.roomId, planId });
    expect(humanSettle.type).toBe('ack');
    const [settledPlan] = await handle.db.select().from(plans).where(eq(plans.id, planId));
    expect(settledPlan?.status).toBe('settled');
    expect(settledPlan?.settledByEventId).toBeTruthy();
  });

  /**
   * The no-child and all-children-exited cases still settle fine through the real
   * boundary — the guard refuses only an OPEN child, nothing else.
   *
   * F4 (#119 fix round 2, vacuous test): part (b) used to look up the "open"
   * child by `status = 'open'` AFTER firing `open_session` without checking
   * that command's own result — if `open_session` had NACK'd (budget, a typo'd
   * planId, whatever), that query would find zero rows, `childId` would be
   * `undefined`, the follow-up `settle_session` would itself NACK on a
   * nonexistent session, and `settle_plan` would then ack because the plan
   * was — by accident, not by the scenario it claims to cover — still
   * childless. The "failed-child" control would pass having never created,
   * let alone failed, a child. Every step below now asserts its OWN precondition
   * really happened (a real open child exists; it really reached `failed`)
   * before trusting the final `settle_plan` ack means what the test name says.
   */
  it('settles a plan with no sessions, and one whose only child has failed', async () => {
    const hexi = await connect(agentId, 'agent');
    // (a) a plan with no sessions at all settles cleanly.
    await hexi.command({
      name: 'open_plan',
      roomId: room.roomId,
      agentUserId: agentId,
      title: 'childless',
      budgetLimitMicros: null,
    });
    const [{ id: childlessId } = { id: '' }] = await handle.db
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.roomId, room.roomId));
    expect(
      (await hexi.command({ name: 'settle_plan', roomId: room.roomId, planId: childlessId })).type,
    ).toBe('ack');

    // (b) a plan whose only child FAILED settles cleanly — an exited child, even a
    // failed one, does not block the parent's exit.
    await hexi.command({
      name: 'open_plan',
      roomId: room.roomId,
      agentUserId: agentId,
      title: 'all children exited',
      budgetLimitMicros: null,
    });
    const [{ id: parentId } = { id: '' }] = await handle.db
      .select({ id: plans.id })
      .from(plans)
      .where(and(eq(plans.roomId, room.roomId), eq(plans.status, 'open')));
    await fundPlan(parentId);
    // The session really opened — assert the command's own ack, not just a
    // later row lookup that could quietly find nothing.
    const opened = await hexi.command({
      name: 'open_session',
      roomId: room.roomId,
      planId: parentId,
      harness: 'omp',
      model: 'haiku',
    });
    expect(opened.type).toBe('ack');
    const [{ id: childId } = { id: '' }] = await handle.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.roomId, room.roomId), eq(sessions.status, 'open')));
    // A real open child exists under this plan — the scenario this test claims
    // to cover ("only child has failed") requires there to BE a child first.
    expect(childId).toBeTruthy();
    const [openChild] = await handle.db.select().from(sessions).where(eq(sessions.id, childId));
    expect(openChild?.planId).toBe(parentId);
    expect(openChild?.status).toBe('open');

    // It really failed — assert the settle_session ack, then the durable row.
    const failed = await hexi.command({
      name: 'settle_session',
      roomId: room.roomId,
      sessionId: childId,
      outcome: 'failed',
      exitSummary: 'child failed',
      spendMicros: null,
      contextPct: null,
    });
    expect(failed.type).toBe('ack');
    const [failedChild] = await handle.db.select().from(sessions).where(eq(sessions.id, childId));
    // The child's row itself, directly — status is `failed`, not merely "not
    // open" (which `undefined` would also satisfy), and it carries the exit
    // receipt pointer a real terminal transition writes.
    expect(failedChild?.status).toBe('failed');
    expect(failedChild?.settledByEventId).toBeTruthy();

    // ONLY NOW — a real child that really opened and really failed — does the
    // parent's settle get to mean what this test's name claims.
    expect(
      (await hexi.command({ name: 'settle_plan', roomId: room.roomId, planId: parentId })).type,
    ).toBe('ack');
    const [settled] = await handle.db.select().from(plans).where(eq(plans.id, parentId));
    expect(settled?.status).toBe('settled');
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

/**
 * F5 (#119 fix round 2, deterministic race). F1 (above, 0031's rewritten
 * comments) is honest that the DB trigger is a SEQUENTIAL-write backstop, not
 * a concurrency guarantee — this test proves what IS the concurrency
 * guarantee, by forcing `settle_plan` and `open_session` to race on the same
 * plan across two independent server processes and asserting the invariant
 * #119 exists for holds no matter which one wins: never an open child under a
 * settled plan.
 *
 * ## The barrier: `FOR SHARE` on the contested plan row, not `FOR UPDATE`
 *
 * Both commands touch the `plans` row twice, in the SAME relative order —
 * once with a read (`open_session`'s `authorize` reads `status` `FOR SHARE`;
 * `settle_plan` has no early plan read) and once with a write at the very end
 * of `project` (`open_session` increments `authorizedDraws`; `settle_plan`
 * sets `status = 'settled'`) — and in between, both insert their event into
 * `core_events` via `atrium_append_core_event`. A THIRD connection holding
 * `FOR UPDATE` on the plan row (the shape HIGH-5 uses) blocks `open_session`
 * at its EARLY read but not `settle_plan` until its LATE write — reversing
 * the two commands' relative lock order into a classic AB–BA deadlock, which
 * Postgres's own detector resolves with a `40P01` abort before either the
 * real race or the real serialization is ever exercised (confirmed
 * empirically: an earlier `FOR UPDATE` draft of this test stayed green even
 * with `ledger.ts:975` deleted, for exactly this wrong reason). `FOR SHARE`
 * is compatible with both commands' early `FOR SHARE` reads and conflicts
 * only with the late writes, so no order reversal and no deadlock — both
 * racers queue on the plan row at the same relative step, and whichever is
 * granted first commits first; the other, unblocked next, still finds its
 * own `WHERE` clause satisfied (`open_session`'s final UPDATE has no status
 * guard at all; `settle_plan`'s `WHERE status = 'open'` is still true, since
 * the other side never touches `status`) UNLESS something upstream already
 * serialized the two transactions before either reached this row.
 *
 * ## What actually closes this race — and the one thing that does NOT (read this)
 *
 * `projectPlanSettled`'s comment (apps/server/src/projections.ts) and this
 * fix round's own brief both name `ledger.ts:975`'s
 * `pg_advisory_xact_lock(LEDGER_ADVISORY_LOCK_KEY)` as THE guarantee. That is
 * true for reads taken BEFORE an event is appended — HIGH-5
 * (budget-enforcement.test.ts) proves it for exactly that shape, racing two
 * `open_session`s on their `authorize` read, which runs before anything is
 * appended. It does NOT hold for THIS race, and that is a real, verified
 * finding, not a gap in this test: both commands' decisive reads here
 * (`projectPlanSettled`'s open-child `sessions` read, `projectSessionOpened`'s
 * `plans.status` read) run inside `project`, which is called strictly AFTER
 * `atrium_append_core_event` has already run for that command — and
 * `atrium_append_core_event` (packages/db/drizzle/0008, unchanged since) TAKES
 * THE SAME ADVISORY LOCK ITSELF, unconditionally, as its very first statement
 * (`PERFORM pg_advisory_xact_lock(1096045106::bigint)` — `1096045106` is
 * `LEDGER_ADVISORY_LOCK_KEY` in decimal, the same key `ledger.ts:975` takes).
 * A trigger (`atrium_core_events_append_guard`, 0004/0008/0009) additionally
 * REFUSES any `core_events` insert made without that lock already held, from
 * any caller. So by the time either racer's `project` step runs, the ledger
 * has independently guaranteed only one of them can be "past the append"
 * at once — `ledger.ts:975` is genuine defense-in-depth for THIS race, not
 * its sole guarantee, and deleting only that one line does not expose the
 * violation this test checks for.
 *
 * Verified, not asserted: `ledger.ts:975` was deleted and this test run 5
 * times — green every time (`Duration` about 2.6s each, one racer nack'ing
 * `40P01`/`retry` where the two `atrium_append_core_event` calls' own,
 * still-present advisory-lock acquisitions contend, the other acking clean;
 * never both acking with an open child left under a settled plan). The
 * deeper, always-present lock inside `atrium_append_core_event`, PLUS the
 * append-guard trigger that refuses an unlocked insert outright, is what
 * makes the command path unconditionally safe here — and reverting THAT one
 * (diagnostic only, never shipped) does not expose the violation either: it
 * makes `atrium_core_events_append_guard` refuse the append outright with a
 * loud `ERROR`, not a silent race, because the trigger checks lock
 * possession, not who is supposed to have taken it. There is no single
 * revertible line whose removal turns this race into a silent violation —
 * that is the fix round's honest conclusion, not a shortfall of this test.
 * This test still earns its place: it is real, reproducible coverage that the
 * INVARIANT holds under a genuine forced concurrent race through the command
 * path, which nothing else in the suite exercises.
 */
describe('settle_plan races open_session on the same plan, across processes, on the DB advisory lock (#119 F5)', () => {
  let planId: string;

  beforeEach(async () => {
    const opener = await connect(agentId, 'agent');
    await opener.command({
      name: 'open_plan',
      roomId: room.roomId,
      agentUserId: agentId,
      title: 'a plan racing settle against open',
      budgetLimitMicros: null,
    });
    const [{ id } = { id: '' }] = await handle.db
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.roomId, room.roomId));
    planId = id;
    await fundPlan(planId, 10);
  });

  it('never leaves an open child under a settled plan, no matter which racer wins', async () => {
    // Two independent server processes on the same database, each with its own
    // pool and its own in-process mutex — the ONLY thing that can still
    // serialize them is the DB-level advisory lock under test.
    const a = await startSecondInstance();
    const b = await startSecondInstance();
    const settler = await TestClient.connect(a.server.url, agentId, { principalKind: 'agent' });
    const openerB = await TestClient.connect(b.server.url, agentId, { principalKind: 'agent' });

    // A third, independent connection holds a SHARE lock on the contested
    // plan — compatible with both commands' own early FOR SHARE reads (so it
    // does not reverse either command's natural resource order, see the
    // docblock above), but not with either command's final write, which is
    // where both are forced to queue.
    let releaseBarrier!: () => void;
    const barrierReleased = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let barrierAcquired!: () => void;
    const barrierReady = new Promise<void>((resolve) => {
      barrierAcquired = resolve;
    });
    const barrier = handle.db.transaction(async (tx) => {
      await tx.select({ id: plans.id }).from(plans).where(eq(plans.id, planId)).for('share');
      barrierAcquired();
      await barrierReleased;
    });

    try {
      await barrierReady;

      const racePromise = Promise.all([
        settler.command({ name: 'settle_plan', roomId: room.roomId, planId }),
        openerB.command({
          name: 'open_session',
          roomId: room.roomId,
          planId,
          harness: 'omp',
          model: 'haiku',
        }),
      ]);

      // Let both commands reach Postgres and queue on the barriered plan row —
      // this only needs to outlast the network + parse hop, not any real work.
      await new Promise((resolve) => setTimeout(resolve, 400));
      releaseBarrier();
      await barrier;

      const [settleAck, openAck] = await racePromise;

      // The invariant #119 exists for, checked directly against the durable
      // rows rather than inferred from the command results: a settled plan
      // never has an open child underneath it.
      const [finalPlan] = await handle.db.select().from(plans).where(eq(plans.id, planId));
      const openChildren = await handle.db
        .select()
        .from(sessions)
        .where(and(eq(sessions.planId, planId), eq(sessions.status, 'open')));
      const violated = finalPlan?.status === 'settled' && openChildren.length > 0;
      expect(violated).toBe(false);

      // And exactly one racer got its positive outcome — the DB lock let the
      // boundary be crossed exactly once, never both and never neither.
      const settledCleanly = settleAck.type === 'ack' && finalPlan?.status === 'settled';
      const sessionOpened = openAck.type === 'ack' && openAck.draw?.outcome === 'granted';
      expect(settledCleanly).not.toBe(sessionOpened);
      expect(settledCleanly || sessionOpened).toBe(true);
    } finally {
      releaseBarrier();
      await barrier.catch(() => {});
      await settler.close();
      await openerB.close();
      await a.close();
      await b.close();
    }
  });
});
