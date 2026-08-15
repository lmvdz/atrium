import { randomUUID } from 'node:crypto';
import type { DatabaseHandle } from '@atrium/db';
import { coreEvents, fundedArms, messages, plans, sessions } from '@atrium/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
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
 * THE CHANNEL LOOP'S ATRIUM-SIDE CONTRACT (#128, from #124's binding
 * resolution).
 *
 * The loop itself is NOT here and never will be: Atrium runs no daemon
 * (`init.md`). What is here is the half Atrium owns — which appends are LEGAL
 * for an agent principal driving a channel loop, enforced server-side, through
 * the real boundary (`TestClient` → ws → commands → ledger → projections)
 * against the real migrations.
 *
 * Four obligations, in order:
 *
 *   1. `causeMessageId` on the three newly-routed appends (`plan_opened`,
 *      `session_opened`, `message_posted`), same-room enforced at THREE layers
 *      that bind three different writers.
 *   2. At most one FUNDED arm per cause message, across both draw-taking
 *      appends — and `plan_opened` exempt from THAT claim, because a plan never
 *      draws. It carries its own board-level claim instead (#148 FIX 1: at most
 *      one plan per routed cause), a different mechanism, not an arm.
 *   3. The nack list, verified with the LOOP PRINCIPAL (an agent) as the actor.
 *   4. The doctrine brief is documentation; nothing here or anywhere claims it
 *      as enforcement. `docs/agent-loop-doctrine.md`.
 *
 * ## One clause, one witness, disjoint sentences
 *
 * #122's standing lesson, which has now fired four times in this campaign: a
 * shared refusal string makes every red-on-revert test assert the DISJUNCTION —
 * "something refused this" — so a guard can be deleted while its own test stays
 * green because a neighbour caught the same input. Every test below names the
 * one revert that reddens it, and the assertions are on sentences and constraint
 * names that no other layer produces.
 */

let handle: DatabaseHandle;
let server: TestServer;
let room: SeededRoom;
/** A second room the agent is legitimately a member of — the cross-room flip. */
let otherRoom: SeededRoom;
let agentId: string;
let ownerId: string;
const open: TestClient[] = [];

async function connect(userId: string, principalKind: 'human' | 'agent'): Promise<TestClient> {
  const client = await TestClient.connect(server.url, userId, { principalKind });
  open.push(client);
  return client;
}

beforeEach(async () => {
  handle ??= openDatabase(10);
  await resetDatabase(handle);
  // alice OWNS the agent hexi. hexi is the LOOP PRINCIPAL throughout: every
  // "the loop cannot" below is asserted with hexi's own authenticated session,
  // because #124 resolution 1 is explicit that the loop authenticates as the
  // agent principal and holds nothing else.
  room = await seedRoom(handle, ['alice', 'hexi'], { agents: ['hexi'] });
  ownerId = room.people.alice as string;
  agentId = room.people.hexi as string;
  await handle.db.execute(sql`
    UPDATE rooms SET agent_user_id = ${agentId} WHERE id = ${room.roomId}
  `);
  await handle.db.execute(sql`
    INSERT INTO agents (user_id, owner_user_id, channel_room_id, host, harness, model)
    VALUES (${agentId}, ${ownerId}, ${room.roomId}, 'localhost', 'claude', 'opus')
  `);
  // THE AGENT IS A MEMBER OF BOTH. #124's gauntlet found cross-room routing is
  // representable precisely because the agent is legitimately in many rooms, so
  // the flip must use a room the router can actually reach — otherwise the
  // membership check would refuse it and the room-match rule would go untested.
  //
  // `seedRoom` mints fresh identities per room, so THIS agent is admitted to the
  // second room by hand. Both the workspace row and the room membership: every
  // authorization read joins `workspace_members`, so a `memberships` row alone
  // grants nothing and the fixture would silently test the membership refusal
  // instead of the room-match rule.
  otherRoom = await seedRoom(handle, ['bob'], { slug: 'elsewhere' });
  for (const userId of [agentId, ownerId]) {
    await handle.db.execute(sql`
      INSERT INTO workspace_members (organization_id, user_id, role)
      VALUES (${otherRoom.workspaceId}::uuid, ${userId}::uuid, 'member')
    `);
    await handle.db.execute(sql`
      INSERT INTO memberships (room_id, user_id, role)
      VALUES (${otherRoom.roomId}::uuid, ${userId}::uuid, 'member')
    `);
  }
  server = await startTestServer(handle);
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()));
  await server?.close();
});

afterAll(async () => {
  await handle?.close();
});

/* ── fixtures ─────────────────────────────────────────────────────────────── */

/** Post a message and return its id — a cause a routing append can cite. */
async function postMessage(client: TestClient, roomId: string, body: string): Promise<string> {
  const ack = await client.command({ name: 'send_message', roomId, body });
  expect(ack.type).toBe('ack');
  const [row] = await handle.db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.roomId, roomId), eq(messages.body, body)));
  return row?.id as string;
}

/**
 * A plan, funded to `slice` draws.
 *
 * The slice is set with a raw UPDATE rather than a human `set_plan_rlimit`, the
 * shortcut `signal-events.test.ts` and `lifecycle-events.test.ts` both take: it
 * adds no `plan_rlimit_set` ledger row, so the event-count assertions below stay
 * about routing.
 */
async function fundedPlan(slice: number, causeMessageId: string | null = null): Promise<string> {
  const hexi = await connect(agentId, 'agent');
  const opened = await hexi.command({
    name: 'open_plan',
    roomId: room.roomId,
    agentUserId: agentId,
    title: 'the channel lane',
    budgetLimitMicros: null,
    causeMessageId,
  });
  expect(opened.type).toBe('ack');
  const [plan] = await handle.db
    .select({ id: plans.id })
    .from(plans)
    .where(eq(plans.roomId, room.roomId))
    .orderBy(sql`created_at DESC`)
    .limit(1);
  const planId = plan?.id as string;
  await handle.db.execute(sql`UPDATE plans SET rlimit_slice = ${slice} WHERE id = ${planId}`);
  return planId;
}

async function spawn(
  client: TestClient,
  planId: string,
  causeMessageId: string | null,
): Promise<Awaited<ReturnType<TestClient['command']>>> {
  return client.command({
    name: 'open_session',
    roomId: room.roomId,
    planId,
    harness: 'omp',
    model: 'haiku',
    causeMessageId,
  });
}

/** The granted draw's session id, or a loud failure — narrowing that survives a closure. */
function grantedSessionId(result: Awaited<ReturnType<TestClient['command']>>): string {
  if (result.type !== 'ack' || result.draw?.outcome !== 'granted') {
    throw new Error('the fixture failed to draw a session');
  }
  return result.draw.sessionId;
}

async function sessionRows() {
  return handle.db.select().from(sessions).where(eq(sessions.roomId, room.roomId));
}

async function armRows() {
  return handle.db.select().from(fundedArms).where(eq(fundedArms.roomId, room.roomId));
}

async function authorizedDraws(planId: string): Promise<number> {
  const [row] = await handle.db
    .select({ n: plans.authorizedDraws })
    .from(plans)
    .where(eq(plans.id, planId));
  return Number(row?.n ?? -1);
}

async function eventCount(type: string): Promise<number> {
  const [{ n } = { n: 0 }] = await handle.db
    .select({ n: sql<number>`count(*)::int` })
    .from(coreEvents)
    .where(and(eq(coreEvents.roomId, room.roomId), sql`type::text = ${type}`));
  return n;
}

/**
 * Append a ledger row through the REAL boundary function, bypassing the command
 * layer entirely — the writer #124 resolution 3 says the composite FKs do not
 * bind, because they bind the projection and this writes the JSON.
 *
 * The monotonic clock is the `max(now, last + 1ms)` shape the real ledger uses,
 * so two appends never tie on `(at, id)` and trip the canonical-order gate.
 */
let lastAtMs = 0;
async function rawAppend(roomId: string, payload: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  lastAtMs = Math.max(Date.now(), lastAtMs + 1);
  const at = new Date(lastAtMs).toISOString();
  await handle.db.execute(sql`
    SELECT atrium_append_core_event(
      ${roomId}::uuid,
      ${id}::text,
      ${payload.type as string}::event_type,
      'agent'::actor_kind,
      ${agentId}::text,
      ${JSON.stringify({ id, at, ...payload })}::jsonb,
      ${at}::timestamptz,
      NULL::text
    )
  `);
  return id;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * OBLIGATION 1 — the routing receipt on all three newly-routed appends
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('a routed append carries the message it came from', () => {
  /**
   * ACCEPTANCE 1. One channel message, routed all three ways Glance §9.3 allows
   * — a board, a process, and an answer — each append carrying the SAME cause on
   * its own projection row. (Three arms from one message is doctrine-violating
   * and deliberately not refused: #124 resolution 4 enforces one FUNDED arm, and
   * only the session half draws. Doing all three here is the flip-the-input
   * proof that the doctrine is NOT enforced, exactly as the brief says.)
   *
   * RED-ON-REVERT: stop writing `causeMessageId` in any one of
   * `projectPlanOpened` / `projectSessionOpened` / `projectMessagePosted` and
   * that row's assertion goes red — three separate writes, three assertions.
   */
  it('lands the cause on the plan, the session and the answer', async () => {
    const alice = await connect(ownerId, 'human');
    const hexi = await connect(agentId, 'agent');
    const cause = await postMessage(alice, room.roomId, 'please look at the migration order');

    const planId = await fundedPlan(1, cause);
    const draw = await spawn(hexi, planId, cause);
    expect(draw.type).toBe('ack');
    const answer = await hexi.command({
      name: 'send_message',
      roomId: room.roomId,
      body: 'on it — opened a session',
      causeMessageId: cause,
    });
    expect(answer.type).toBe('ack');

    const [plan] = await handle.db.select().from(plans).where(eq(plans.id, planId));
    expect(plan?.causeMessageId).toBe(cause);

    const [session] = await sessionRows();
    expect(session?.causeMessageId).toBe(cause);

    const [reply] = await handle.db
      .select()
      .from(messages)
      .where(and(eq(messages.roomId, room.roomId), eq(messages.body, 'on it — opened a session')));
    expect(reply?.causeMessageId).toBe(cause);
  });

  /**
   * The ORDINARY case stays ordinary: an append that cites nothing is not a
   * violation. #124 resolution 3 names it outright — "a human opening a plan by
   * hand has no cause message" — and a rule that refused an uncaused append
   * would have broken every existing caller.
   *
   * RED-ON-REVERT: make any of the three fields non-nullable, or drop its
   * `.default(null)`, and these three acks become nacks.
   */
  it('leaves an uncaused append uncaused, and claims no arm for it', async () => {
    const hexi = await connect(agentId, 'agent');
    const planId = await fundedPlan(1, null);
    expect((await spawn(hexi, planId, null)).type).toBe('ack');
    expect(
      (await hexi.command({ name: 'send_message', roomId: room.roomId, body: 'unprompted' })).type,
    ).toBe('ack');

    const [plan] = await handle.db.select().from(plans).where(eq(plans.id, planId));
    expect(plan?.causeMessageId).toBe(null);
    expect((await sessionRows())[0]?.causeMessageId).toBe(null);
    // A null cause claims nothing — there is no arm row to collide with later.
    expect(await armRows()).toHaveLength(0);
  });
});

describe('a routing append naming another room’s cause is refused, at three layers', () => {
  /** A real message, in a room the agent really is a member of. */
  async function elsewhereCause(): Promise<string> {
    const hexi = await connect(agentId, 'agent');
    return postMessage(hexi, otherRoom.roomId, 'a sentence in the other channel');
  }

  /**
   * LAYER 1 (command), arm A — `open_plan`.
   *
   * RED-ON-REVERT: delete the `requireSameRoomCause` call from `open_plan`'s
   * prepare and the append reaches the ledger trigger, which refuses it as a raw
   * `core_events_routing_cause_same_room` error rather than as THIS sentence —
   * red on the message assertion, and only this test's.
   */
  it('refuses a cross-room cause on open_plan, at the command', async () => {
    const cause = await elsewhereCause();
    const hexi = await connect(agentId, 'agent');
    const nack = await hexi.command({
      name: 'open_plan',
      roomId: room.roomId,
      agentUserId: agentId,
      title: 'routed from the wrong room',
      budgetLimitMicros: null,
      causeMessageId: cause,
    });
    expect(nack.type).toBe('nack');
    if (nack.type === 'nack') {
      expect(nack.message).toContain('names no message in room');
      expect(nack.message).toContain('routing receipt');
    }
    expect(await eventCount('plan_opened')).toBe(0);
  });

  /**
   * LAYER 1 (command), arm B — `open_session`. A separate test from the plan
   * arm because they are separate call sites: deleting one leaves the other
   * green, which is the whole point of splitting them.
   *
   * The plan's draw count is asserted UNMOVED, which is the part that matters:
   * a cross-room routing append must not be a `draw_refused` either. It is
   * refused BEFORE the draw decision, so nothing is appended at all.
   *
   * RED-ON-REVERT: delete `requireSameRoomCause` from `open_session`'s
   * `authorize` and the append reaches the projection, whose
   * `sessions_cause_same_room_fk` refuses it as a raw constraint error.
   */
  it('refuses a cross-room cause on open_session, before the draw decision', async () => {
    const cause = await elsewhereCause();
    const hexi = await connect(agentId, 'agent');
    const planId = await fundedPlan(5, null);

    const nack = await spawn(hexi, planId, cause);
    expect(nack.type).toBe('nack');
    if (nack.type === 'nack') expect(nack.message).toContain('names no message in room');

    expect(await sessionRows()).toHaveLength(0);
    expect(await eventCount('session_opened')).toBe(0);
    // NOT a draw_refused: the purse was full, the citation was wrong.
    expect(await eventCount('draw_refused')).toBe(0);
    expect(await authorizedDraws(planId)).toBe(0);
  });

  /**
   * LAYER 1 (command), arm C — `send_message`, the answer arm.
   *
   * RED-ON-REVERT: delete `requireSameRoomCause` from `send_message`'s
   * `prepare` and the ledger trigger refuses it instead, with its own sentence.
   */
  it('refuses a cross-room cause on send_message, at the command', async () => {
    const cause = await elsewhereCause();
    const hexi = await connect(agentId, 'agent');
    const nack = await hexi.command({
      name: 'send_message',
      roomId: room.roomId,
      body: 'answering across a wall',
      causeMessageId: cause,
    });
    expect(nack.type).toBe('nack');
    if (nack.type === 'nack') expect(nack.message).toContain('names no message in room');
    expect(
      await handle.db
        .select()
        .from(messages)
        .where(and(eq(messages.roomId, room.roomId), eq(messages.body, 'answering across a wall'))),
    ).toHaveLength(0);
  });

  /**
   * LAYER 2 (the LEDGER), and the reason #124 made it a build obligation.
   *
   * "The composite FKs bind plans/sessions, not JSON on the ledger." This writes
   * the ledger row DIRECTLY through `atrium_append_core_event` — the real
   * boundary function, past the whole command layer — with a payload whose
   * `roomId` is correct (so `core_events_payload_room_matches` is satisfied) and
   * whose `causeMessageId` points into the other room. Before #128 nothing in
   * the ledger asked the second question.
   *
   * RED-ON-REVERT: drop the `core_events_routing_cause_same_room` trigger (or
   * narrow its allowlist to exclude `session_opened`) and this append lands.
   */
  it('refuses a raw ledger append whose payload cites another room', async () => {
    const cause = await elsewhereCause();
    const planId = await fundedPlan(5, null);
    await violatesConstraint('core_events_routing_cause_same_room', () =>
      rawAppend(room.roomId, {
        type: 'session_opened',
        roomId: room.roomId,
        sessionId: randomUUID(),
        planId,
        harness: 'omp',
        model: 'haiku',
        causeMessageId: cause,
      }),
    );
    expect(await eventCount('session_opened')).toBe(0);
  });

  /**
   * LAYER 2, the ANSWER arm — a separate kind in the trigger's allowlist, so a
   * separate witness. Narrowing the allowlist to three kinds would leave the
   * test above green and this one red, which is what an allowlist is for.
   *
   * RED-ON-REVERT: remove `'message_posted'` from the trigger's IN-list.
   */
  it('refuses a raw ledger append of a message_posted citing another room', async () => {
    const cause = await elsewhereCause();
    await violatesConstraint('core_events_routing_cause_same_room', () =>
      rawAppend(room.roomId, {
        type: 'message_posted',
        roomId: room.roomId,
        messageId: randomUUID(),
        body: 'raw and wrong',
        replyToId: null,
        clientMessageId: null,
        causeMessageId: cause,
        attachments: [],
        references: [],
      }),
    );
  });

  /**
   * LAYER 2 does NOT refuse the legal case — the check is checked by mutation.
   * A raw append citing a cause in the SAME room lands, so the trigger is a
   * room-match rule and not a blanket "no causes on the ledger" rule (which
   * would pass every refusal test above while breaking the feature).
   */
  it('accepts a raw ledger append whose cause is in its own room', async () => {
    const alice = await connect(ownerId, 'human');
    const cause = await postMessage(alice, room.roomId, 'same room, real cause');
    const planId = await fundedPlan(5, null);
    await rawAppend(room.roomId, {
      type: 'session_opened',
      roomId: room.roomId,
      sessionId: randomUUID(),
      planId,
      harness: 'omp',
      model: 'haiku',
      causeMessageId: cause,
    });
    expect(await eventCount('session_opened')).toBe(1);
  });

  /**
   * LAYER 3 (the projection tables), one composite FK per arm. A writer with a
   * connection and no interest in the ledger at all.
   *
   * RED-ON-REVERT: drop the named FK and the INSERT lands, leaving a projection
   * row citing a message its room cannot show.
   */
  it('refuses a hand-written PLAN citing another room’s message', async () => {
    const cause = await elsewhereCause();
    await violatesConstraint('plans_cause_same_room_fk', () =>
      handle.db.execute(sql`
        INSERT INTO plans (room_id, agent_user_id, title, cause_message_id)
        VALUES (${room.roomId}::uuid, ${agentId}::uuid, 'hand-written', ${cause}::uuid)
      `),
    );
  });

  /** …the SESSION arm's FK, its own test so dropping one FK reddens one test. */
  it('refuses a hand-written SESSION citing another room’s message', async () => {
    const cause = await elsewhereCause();
    const planId = await fundedPlan(5, null);
    await violatesConstraint('sessions_cause_same_room_fk', () =>
      handle.db.execute(sql`
        INSERT INTO sessions (room_id, plan_id, harness, model, cause_message_id)
        VALUES (${room.roomId}::uuid, ${planId}::uuid, 'omp', 'haiku', ${cause}::uuid)
      `),
    );
  });

  /** …and the ANSWER arm's, which is a self-FK on `messages`. */
  it('refuses a hand-written MESSAGE citing another room’s message', async () => {
    const cause = await elsewhereCause();
    await violatesConstraint('messages_cause_same_room_fk', () =>
      handle.db.execute(sql`
        INSERT INTO messages (room_id, author_id, body, cause_message_id)
        VALUES (${room.roomId}::uuid, ${agentId}::uuid, 'hand-written', ${cause}::uuid)
      `),
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * OBLIGATION 2 — at most one FUNDED arm per cause message
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('one channel message funds at most one arm', () => {
  /**
   * ACCEPTANCE 2. THE DAEMON RETRY. The loop routes a message into a session,
   * loses the ack (or crashes, or a second instance races it), and routes the
   * same message again. The second draw is refused — durably and legibly — and
   * the plan's committed draw count does not move.
   *
   * The slice is 5, so the refusal cannot be the budget gate wearing a different
   * hat: there was plenty of purse and the append was still refused.
   *
   * RED-ON-REVERT: delete the `requireUnfundedCause` call from `open_session`'s
   * `authorize` and the second spawn reaches the projection, whose own claim
   * read refuses it with a DIFFERENT sentence — red on the message assertion.
   */
  it('refuses a second spawn from the same cause message', async () => {
    const alice = await connect(ownerId, 'human');
    const hexi = await connect(agentId, 'agent');
    const cause = await postMessage(alice, room.roomId, 'do the thing');
    const planId = await fundedPlan(5, null);

    const first = await spawn(hexi, planId, cause);
    expect(first.type).toBe('ack');
    expect(await authorizedDraws(planId)).toBe(1);

    const retry = await spawn(hexi, planId, cause);
    expect(retry.type).toBe('nack');
    if (retry.type === 'nack') {
      expect(retry.code).toBe('invalid');
      expect(retry.message).toContain('has already funded a draw');
      expect(retry.message).toContain('at most ONE arm');
    }

    // Nothing moved: one session, one arm, one draw. And no `draw_refused` —
    // this is not an empty purse, it is a message that was already paid for.
    expect(await sessionRows()).toHaveLength(1);
    expect(await armRows()).toHaveLength(1);
    expect(await authorizedDraws(planId)).toBe(1);
    expect(await eventCount('draw_refused')).toBe(0);
    expect(await eventCount('session_opened')).toBe(1);
  });

  /**
   * ACROSS DRAW-TAKING APPENDS — the resolution's own phrase, and the half a
   * partial unique index on `sessions` would have silently missed. The spawn and
   * the continue are two different verbs projecting into two different tables,
   * and one message may fund neither twice nor one of each.
   *
   * RED-ON-REVERT: delete `requireUnfundedCause` from `resume_session`'s
   * `authorize` and the resume reaches `claimFundedArm`, which refuses it with
   * the projection's sentence instead of this one.
   */
  it('refuses a resume from a cause message that already funded a spawn', async () => {
    const alice = await connect(ownerId, 'human');
    const hexi = await connect(agentId, 'agent');
    const cause = await postMessage(alice, room.roomId, 'start, then keep going');
    const planId = await fundedPlan(5, null);

    const sessionId = grantedSessionId(await spawn(hexi, planId, cause));

    const resume = await hexi.command({
      name: 'resume_session',
      roomId: room.roomId,
      sessionId,
      body: 'keep going',
      causeMessageId: cause,
      supersedesEventId: null,
      subscriptionId: null,
    });
    expect(resume.type).toBe('nack');
    if (resume.type === 'nack') expect(resume.message).toContain('has already funded a draw');
    expect(await authorizedDraws(planId)).toBe(1);
    expect(await armRows()).toHaveLength(1);
  });

  /**
   * …and the same message cannot fund two CONTINUES either. The `arm` recorded
   * is `continue`, which is what makes the refusal legible in the row rather
   * than only in the error.
   */
  it('refuses a second resume from one cause message', async () => {
    const alice = await connect(ownerId, 'human');
    const hexi = await connect(agentId, 'agent');
    const planId = await fundedPlan(5, null);
    const sessionId = grantedSessionId(await spawn(hexi, planId, null));
    const cause = await postMessage(alice, room.roomId, 'and again');

    const resume = (body: string) =>
      hexi.command({
        name: 'resume_session',
        roomId: room.roomId,
        sessionId,
        body,
        causeMessageId: cause,
        supersedesEventId: null,
        subscriptionId: null,
      });

    expect((await resume('once')).type).toBe('ack');
    const [arm] = await armRows();
    expect(arm?.arm).toBe('continue');
    expect(arm?.sessionId).toBe(sessionId);

    const again = await resume('twice');
    expect(again.type).toBe('nack');
    if (again.type === 'nack') expect(again.message).toContain('has already funded a draw');
    expect(await authorizedDraws(planId)).toBe(2); // the spawn and the ONE continue
    expect(await armRows()).toHaveLength(1);
  });

  /**
   * A PLAN NEVER DRAWS, so it takes NO funded-arm claim — the SPEND exemption
   * (#124 resolution 2), checked by MUTATION: a routed plan claims zero arms, and
   * a later SESSION from that same message still draws. That exemption stands.
   *
   * But a routed plan now carries a BOARD-level idempotency of its OWN (#148
   * FIX 1, `plans_room_cause_routed_key`): at most one plan per (room, non-null
   * cause). The channel daemon opens a plan by sending `open_plan` then journaling
   * the request, and a crash between them re-sends `open_plan`; without this claim
   * that re-send opens a permanently-orphaned second board (it never draws — the
   * cause has advanced — and never settles). The earlier "two free boards" was
   * spend-scoped and true for spend; the orphan board is what the durable daemon
   * surfaced. A HAND-opened plan (null cause) stays free — the index is partial.
   *
   * RED-ON-REVERT (spend exemption): add a `claimFundedArm(..., 'spawn', ...)` to
   * `projectPlanOpened` and `armRows` goes non-empty / the spawn nacks.
   * RED-ON-REVERT (board idempotency): drop `requirePlanCauseUnclaimed` from
   * `open_plan` and the second routed plan acks (two boards from one message).
   */
  it('opens at most one plan per routed cause, claims no arm, and the session still draws', async () => {
    const alice = await connect(ownerId, 'human');
    const hexi = await connect(agentId, 'agent');
    const cause = await postMessage(alice, room.roomId, 'one ask, one board');

    // A routed plan opens and claims NO arm — a plan is not a draw.
    const planA = await fundedPlan(5, cause);
    expect(await eventCount('plan_opened')).toBe(1);
    expect(await armRows()).toHaveLength(0);

    // A SECOND routed plan from the SAME cause is REFUSED — the board's own
    // idempotency, distinct from the funded-arm claim (this took no arm).
    const second = await hexi.command({
      name: 'open_plan',
      roomId: room.roomId,
      agentUserId: agentId,
      title: 'a second board from one ask',
      budgetLimitMicros: null,
      causeMessageId: cause,
    });
    expect(second.type).toBe('nack');
    if (second.type === 'nack') expect(second.message).toContain('has already opened a plan');
    expect(await eventCount('plan_opened')).toBe(1); // no second board appended

    // The purse-touching arm from that SAME message still draws, exactly once —
    // the plan took no arm, so the session is free to.
    expect((await spawn(hexi, planA, cause)).type).toBe('ack');
    expect(await armRows()).toHaveLength(1);

    // A HAND-opened plan cites nothing and stays FREE: two null-cause boards land.
    const free = (title: string) =>
      hexi.command({
        name: 'open_plan',
        roomId: room.roomId,
        agentUserId: agentId,
        title,
        budgetLimitMicros: null,
        causeMessageId: null,
      });
    expect((await free('free board a')).type).toBe('ack');
    expect((await free('free board b')).type).toBe('ack');
  });

  /**
   * A REFUSED DRAW LEAVES THE CAUSE UNCLAIMED. `draw_refused` grants nothing and
   * funds nothing, so the message is still available to a later, funded retry.
   * The alternative — claiming an arm for a refusal — would have made an empty
   * purse permanently poison the message that asked, which is a wedge with a
   * receipt in front of it.
   *
   * RED-ON-REVERT: move the `claimFundedArm` call out of `projectSessionOpened`
   * and into a place that also runs for `draw_refused`, and the second (funded)
   * spawn goes red.
   */
  it('leaves the cause claimable after a draw was REFUSED for budget', async () => {
    const alice = await connect(ownerId, 'human');
    const hexi = await connect(agentId, 'agent');
    const cause = await postMessage(alice, room.roomId, 'ask against an empty purse');
    const planId = await fundedPlan(0, null); // UNFUNDED: a ceiling of zero.

    const refused = await spawn(hexi, planId, cause);
    expect(refused.type).toBe('ack'); // a refusal is a durable, receipted APPEND
    if (refused.type === 'ack') expect(refused.draw?.outcome).toBe('refused');
    expect(await eventCount('draw_refused')).toBe(1);
    expect(await armRows()).toHaveLength(0);

    // A human funds the plan, and the SAME message now funds one arm.
    await handle.db.execute(sql`UPDATE plans SET rlimit_slice = 3 WHERE id = ${planId}`);
    const granted = await spawn(hexi, planId, cause);
    expect(granted.type).toBe('ack');
    if (granted.type === 'ack') expect(granted.draw?.outcome).toBe('granted');
    expect(await armRows()).toHaveLength(1);
  });

  /**
   * A STEER IS NOT A DRAW, so it claims nothing and may be repeated. The
   * uniqueness is about the PURSE, and a channel that steers one session five
   * times from one message has spent nothing.
   *
   * RED-ON-REVERT: move `claimFundedArm` above the `if (event.kind !== 'resume')`
   * return in `projectSessionSignaled` and the second steer nacks.
   */
  it('lets one message steer the same session repeatedly', async () => {
    const alice = await connect(ownerId, 'human');
    const hexi = await connect(agentId, 'agent');
    const planId = await fundedPlan(5, null);
    const sessionId = grantedSessionId(await spawn(hexi, planId, null));
    const cause = await postMessage(alice, room.roomId, 'a bit to the left');

    for (const body of ['left', 'more left', 'stop']) {
      const steer = await alice.command({
        name: 'signal_session',
        roomId: room.roomId,
        sessionId,
        kind: 'steer',
        body,
        causeMessageId: cause,
        supersedesEventId: null,
      });
      expect(steer.type, body).toBe('ack');
    }
    expect(await armRows()).toHaveLength(0);
    expect(await authorizedDraws(planId)).toBe(1);
  });

  /**
   * THE PROJECTION LAYER's own claim — the guard that binds a writer appending a
   * draw without passing `open_session`. The first spawn goes through the real
   * command; the second is a RAW ledger append, which never runs
   * `requireUnfundedCause` and would otherwise have landed a second funded
   * session from one message straight past the command's check.
   *
   * Its sentence is deliberately unlike the command's, so this test and the
   * command's test cannot cover for each other.
   *
   * RED-ON-REVERT: delete the guarded read from `claimFundedArm` (leaving the
   * INSERT) and this append is refused by `funded_arms_room_cause_pk` as a raw
   * constraint error rather than by this sentence — red on the message match.
   */
  it('refuses a raw ledger append that would fund a second arm, at the projection', async () => {
    const alice = await connect(ownerId, 'human');
    const hexi = await connect(agentId, 'agent');
    const cause = await postMessage(alice, room.roomId, 'once is enough');
    const planId = await fundedPlan(5, null);
    expect((await spawn(hexi, planId, cause)).type).toBe('ack');

    await expect(
      server.ledger.append({
        roomId: room.roomId,
        actor: { kind: 'agent', userId: agentId },
        build: ({ id, at }) => ({
          id,
          at,
          type: 'session_opened' as const,
          roomId: room.roomId,
          sessionId: randomUUID(),
          planId,
          harness: 'omp',
          model: 'haiku',
          executionMode: 'external' as const,
          executionOwner: null,
          causeMessageId: cause,
        }),
        project: async (context) => {
          const { projectRoomEvent } = await import('../../apps/server/src/projections.js');
          await projectRoomEvent(context, {});
        },
      }),
    ).rejects.toThrow(/refused at the PROJECTION's funded-arm claim/);

    expect(await sessionRows()).toHaveLength(1);
    expect(await authorizedDraws(planId)).toBe(1);
  });

  /**
   * THE TABLE is the authority the other two layers describe — a writer with a
   * connection and nothing else.
   *
   * RED-ON-REVERT: drop `funded_arms_room_cause_pk` and this INSERT lands.
   * (Making `cause_message_id` nullable would NOT turn this test red — its
   * insert carries a non-null cause, so the PK still bites. The uncaused case
   * is safe for a different reason: null-cause draws never write a claim at
   * all, which the two-null-cause test below checks by mutation.)
   */
  it('refuses a hand-written second claim on one cause message', async () => {
    const alice = await connect(ownerId, 'human');
    const hexi = await connect(agentId, 'agent');
    const cause = await postMessage(alice, room.roomId, 'the table decides');
    const planId = await fundedPlan(5, null);
    const sessionId = grantedSessionId(await spawn(hexi, planId, cause));

    await violatesConstraint('funded_arms_room_cause_pk', () =>
      handle.db.execute(sql`
        INSERT INTO funded_arms (room_id, cause_message_id, arm, session_id)
        VALUES (${room.roomId}::uuid, ${cause}::uuid, 'continue', ${sessionId}::uuid)
      `),
    );
    expect(await armRows()).toHaveLength(1);
  });

  /**
   * Two uncaused draws must BOTH land — a human opening sessions by hand has no
   * cause message, and refusing the second would break every non-loop workflow.
   * The safety is that neither writes a claim (`cause_message_id` is NOT NULL
   * in `funded_arms`, and the projection returns before claiming on a null
   * cause), so there is no NULL-distinctness to fail open.
   *
   * RED-ON-REVERT: make `claimFundedArm` claim on a null cause (or make the
   * column nullable and claim anyway) and the second spawn is wrongly refused —
   * or, with NULLs-distinct semantics, two phantom claims appear below.
   */
  it('funds two uncaused draws and writes no claim for either', async () => {
    const hexi = await connect(agentId, 'agent');
    const planId = await fundedPlan(5, null);
    grantedSessionId(await spawn(hexi, planId, null));
    grantedSessionId(await spawn(hexi, planId, null));
    expect(await armRows()).toHaveLength(0);
  });

  /** Only a draw may claim an arm — the closed vocabulary, as a table fact. */
  it('refuses a claim whose arm is neither a spawn nor a continue', async () => {
    const alice = await connect(ownerId, 'human');
    const hexi = await connect(agentId, 'agent');
    const cause = await postMessage(alice, room.roomId, 'not an arm');
    const planId = await fundedPlan(5, null);
    const sessionId = grantedSessionId(await spawn(hexi, planId, null));
    await violatesConstraint('funded_arms_arm_is_a_draw', () =>
      handle.db.execute(sql`
        INSERT INTO funded_arms (room_id, cause_message_id, arm, session_id)
        VALUES (${room.roomId}::uuid, ${cause}::uuid, 'steer', ${sessionId}::uuid)
      `),
    );
    expect(planId).toBeTruthy();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * OBLIGATION 3 — the nack list, with the LOOP PRINCIPAL as the actor
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('the loop principal cannot certify, fund, settle another’s, or route across rooms', () => {
  /**
   * NACK 1 — THE LOOP CANNOT CERTIFY (#124 resolution 4; #102/#110).
   *
   * Already enforced on the tree by `certificationClassOf` + the pre-append gate;
   * `agent-principal.test.ts` witnesses the class as a whole. THIS witness is
   * the loop's own: hexi, mid-route, tries to promote a `~` to a `✓` on the
   * decision a person staged, and is refused before anything is appended.
   *
   * RED-ON-REVERT: move `accept_proposal` from `certifies` to `open` in
   * `certificationClassOf` and the nack becomes an ack — red on the nack
   * assertion and on the unchanged-ledger assertion.
   */
  it('refuses the loop’s certification of a person’s staged reading', async () => {
    const alice = await connect(ownerId, 'human');
    const hexi = await connect(agentId, 'agent');
    const staged = await alice.command({
      name: 'record_proposal',
      roomId: room.roomId,
      proposal: {
        type: 'decision',
        confidence: 0.9,
        payload: { statement: 'we ship the routing receipt', status: 'active' },
        provenance: [],
        quote: null,
        interpretationId: null,
      },
      sessionId: null,
    });
    expect(staged.type).toBe('ack');
    const [proposal] = await handle.db.execute<{ id: string }>(
      sql`SELECT id::text AS id FROM proposals WHERE room_id = ${room.roomId}::uuid`,
    );

    const before = await eventCount('object_accepted');
    const nack = await hexi.command({
      name: 'accept_proposal',
      roomId: room.roomId,
      proposalId: proposal?.id as string,
      objectiveId: null,
    });
    expect(nack.type).toBe('nack');
    if (nack.type === 'nack') {
      expect(nack.message).toContain('may never certify');
    }
    expect(await eventCount('object_accepted')).toBe(before);
  });

  /**
   * NACK 2 — THE LOOP CANNOT RAISE A SLICE (#124 resolution 4; #115 decision 4).
   *
   * `budget-enforcement.test.ts` witnesses the rule for an agent generally; this
   * is the loop's spelling of it and asserts the OTHER half — that the ceiling
   * did not move — because a nack with a moved ceiling would be the worst
   * outcome and a message-only assertion cannot see it.
   *
   * RED-ON-REVERT: move `set_plan_rlimit` from `authorizes-spend` to `open` and
   * hexi's raise acks, the slice jumps to 999, and both assertions go red.
   */
  it('refuses the loop raising its own plan’s ceiling, and the ceiling does not move', async () => {
    const hexi = await connect(agentId, 'agent');
    const planId = await fundedPlan(2, null);

    const nack = await hexi.command({
      name: 'set_plan_rlimit',
      roomId: room.roomId,
      planId,
      slice: 999,
    });
    expect(nack.type).toBe('nack');
    if (nack.type === 'nack') expect(nack.message).toContain('human = init');

    const [plan] = await handle.db
      .select({ slice: plans.rlimitSlice })
      .from(plans)
      .where(eq(plans.id, planId));
    expect(Number(plan?.slice)).toBe(2);
    expect(await eventCount('plan_rlimit_set')).toBe(0);
  });

  /**
   * NACK 3 — THE LOOP CANNOT SETTLE OUTSIDE THE SETTLEMENT AUTHORITY (#124
   * resolution 4, inherited from #120's lane).
   *
   * #120's rule is that a session's exit is written by the party that OPENED it,
   * and for a provider-owned session only on the capability token. Here a person
   * opens the session and the loop principal — a full member of the room, with
   * every ordinary permission — tries to write its receipt. Refused, and the
   * session is still open afterwards, which is the assertion that matters: a
   * fabricated exit that nacks but leaves the session terminal would be the same
   * defect with better manners.
   *
   * (The PROVIDER-token half of the same authority is witnessed in
   * `execution-provider.test.ts`, which is where the provider harness lives; it
   * is not rebuilt here.)
   *
   * RED-ON-REVERT: delete the opener check in `settle_session`'s guard and the
   * loop's settle acks — red on the nack and on the still-open assertion.
   */
  it('refuses the loop settling a session it did not open', async () => {
    const alice = await connect(ownerId, 'human');
    const hexi = await connect(agentId, 'agent');
    const planId = await fundedPlan(5, null);
    // The PERSON opens this one.
    const sessionId = grantedSessionId(
      await alice.command({
        name: 'open_session',
        roomId: room.roomId,
        planId,
        harness: 'omp',
        model: 'haiku',
        causeMessageId: null,
      }),
    );

    const nack = await hexi.command({
      name: 'settle_session',
      roomId: room.roomId,
      sessionId,
      outcome: 'settled',
      exitSummary: 'I decided this was done',
      spendMicros: 0,
      contextPct: 0,
      artifact: null,
    });
    expect(nack.type).toBe('nack');
    if (nack.type === 'nack') {
      expect(nack.message).toContain('only the party that OPENED that session');
    }
    const [session] = await sessionRows();
    expect(session?.status).toBe('open');
    expect(session?.exitSummary).toBe(null);
    expect(await eventCount('session_settled')).toBe(0);
  });

  /**
   * NACK 4 — THE LOOP CANNOT ROUTE-APPEND CROSS-ROOM, stated as the loop's own
   * act rather than as a constraint test.
   *
   * The agent is a member of BOTH rooms, so nothing about membership refuses
   * this: hexi may post in `elsewhere` and may open sessions in its channel. What
   * is refused is stitching the two together — a session in its channel claiming
   * to have been routed from a message in the other room. The three constraint
   * tests above prove the three layers; this one proves the ACT is refused
   * end-to-end while both halves of it remain individually legal.
   *
   * RED-ON-REVERT: delete `requireSameRoomCause` from `open_session` and the
   * cross-room stitch acks at the command, leaving the raw FK error as the only
   * thing between the loop and an unshowable citation.
   */
  it('refuses the loop stitching two rooms it is legitimately in', async () => {
    const hexi = await connect(agentId, 'agent');
    // Both halves are legal on their own.
    const elsewhere = await postMessage(hexi, otherRoom.roomId, 'asked in the other channel');
    const planId = await fundedPlan(5, null);
    expect((await spawn(hexi, planId, null)).type).toBe('ack');

    // The stitch is not.
    const nack = await spawn(hexi, planId, elsewhere);
    expect(nack.type).toBe('nack');
    if (nack.type === 'nack') expect(nack.message).toContain('names no message in room');
    expect(await sessionRows()).toHaveLength(1);
  });
});
