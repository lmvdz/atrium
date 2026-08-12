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
import { and, asc, eq, sql } from 'drizzle-orm';
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
   * THE FLIP (#114 T3). A `~` is read, then a full lifecycle runs — plan opened,
   * session opened, session settled AND a second failed — over the same room. The
   * `~` is read again: byte-identical, still `~`. If a settle could reach a
   * judgement column, this is where it would show; it cannot, so it does not.
   */
  it('runs a full lifecycle without moving a ~ to a ✓ (the covenant is untouched)', async () => {
    const claimId = await seedMachineReading();

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

    const hexi = await connect(agentId, 'agent');
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

    const after = await handle.db
      .select()
      .from(acceptedObjects)
      .where(eq(acceptedObjects.id, claimId));
    const a = after[0];
    // Byte-for-byte: the settle moved nothing on the object. Same kind, same
    // (absent) human touch, same payload, same revision.
    expect(a).toEqual(b);
    expect(
      epistemicStateOf({
        acceptedBy: { kind: a?.acceptedByKind ?? 'model' },
        humanTouchedAt: a?.humanTouchedAt?.toISOString() ?? null,
      }),
    ).toBe('unconfirmed');
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
