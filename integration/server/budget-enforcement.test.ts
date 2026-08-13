import type { DatabaseHandle } from '@atrium/db';
import { coreEvents, plans, sessions } from '@atrium/db/schema';
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
 * BUDGET/RLIMIT ENFORCEMENT AT THE SPAWN AUTHORIZATION BOUNDARY (#118, from
 * #115's binding resolution).
 *
 * A plan carries a human-set **rlimit slice** — a ceiling on the number of
 * AUTHORIZED DRAWS (spawns) it may be granted. Each `open_session` is a draw,
 * checked under the append lock against `plans.authorized_draws` (the count
 * Atrium itself granted, which a session cannot lie to it about). When the slice
 * is spent, the draw is REFUSED and RECEIPTED — a durable `draw_refused` ledger
 * row with `reason=budget`, not a silent stop. And the slice is human-only: a
 * machine may not raise its own (or any) budget, refused exactly as a machine
 * trying to certify is.
 *
 * These run through the REAL command boundary (`TestClient` → ws → commands →
 * ledger → projections), against the real migrations. Every enforcement claim
 * here is red-on-revert; see the `#118` receipt for the reverted-guard output.
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
  // alice is the human owner (init); hexi is an agent whose channel is this room.
  room = await seedRoom(handle, ['alice', 'hexi'], { agents: ['hexi'] });
  humanId = room.people.alice as string;
  agentId = room.people.hexi as string;
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

/** Open a plan (unfunded) as the agent and return its id. */
async function openPlan(hexi: TestClient, title: string): Promise<string> {
  const ack = await hexi.command({
    name: 'open_plan',
    roomId: room.roomId,
    agentUserId: agentId,
    title,
    budgetLimitMicros: null,
  });
  expect(ack.type).toBe('ack');
  const [{ id } = { id: '' }] = await handle.db
    .select({ id: plans.id })
    .from(plans)
    .where(eq(plans.roomId, room.roomId))
    .orderBy(asc(plans.createdAt));
  return id;
}

/** A human funds a plan's slice — the explicit-act spend-authorization. */
async function fundPlan(alice: TestClient, planId: string, slice: number) {
  return alice.command({ name: 'set_plan_rlimit', roomId: room.roomId, planId, slice });
}

/** Open one session (a draw) under the plan. */
async function draw(hexi: TestClient, planId: string) {
  return hexi.command({
    name: 'open_session',
    roomId: room.roomId,
    planId,
    harness: 'omp',
    model: 'haiku',
  });
}

/** The `draw_refused` rows in the room, newest first, with their payloads. */
async function refusals(planId: string) {
  return handle.db
    .select({ id: coreEvents.id, payload: coreEvents.payload })
    .from(coreEvents)
    .where(and(eq(coreEvents.roomId, room.roomId), eq(coreEvents.type, 'draw_refused')))
    .orderBy(asc(coreEvents.roomSeq))
    .then((rows) => rows.filter((r) => (r.payload as { planId?: string }).planId === planId));
}

async function sessionCount(planId: string): Promise<number> {
  const [{ n } = { n: 0 }] = await handle.db
    .select({ n: sql<number>`count(*)::int` })
    .from(sessions)
    .where(eq(sessions.planId, planId));
  return n;
}

async function planRow(planId: string) {
  const [row] = await handle.db.select().from(plans).where(eq(plans.id, planId));
  return row;
}

describe('the plan rlimit is enforced on authorized draws at the spawn boundary', () => {
  /**
   * ACCEPTANCE 1. A slice that funds 3 draws: draws 1–3 authorize, the 4th is
   * REFUSED with a durable `reason=budget` receipt — a row, not a silent stop.
   *
   * RED-ON-REVERT: delete the `if (plan.authorizedDraws + 1 > plan.slice)` refusal
   * in `commands.ts` `open_session` and the 4th draw acks as a `session_opened`,
   * a 4th session rows up, and `refusals(plan)` is empty — this test goes red.
   */
  it('authorizes 3 draws against a slice of 3 and REFUSES the 4th with a durable reason=budget row', async () => {
    const alice = await connect(humanId, 'human');
    const hexi = await connect(agentId, 'agent');
    const plan = await openPlan(hexi, 'a funded plan');

    expect((await fundPlan(alice, plan, 3)).type).toBe('ack');
    expect((await planRow(plan))?.rlimitSlice).toBe(3);

    // Draws 1–3 authorize — each is a session_opened, and authorized_draws climbs.
    for (let i = 1; i <= 3; i += 1) {
      const ack = await draw(hexi, plan);
      expect(ack.type).toBe('ack');
      expect((await planRow(plan))?.authorizedDraws).toBe(i);
      expect(await sessionCount(plan)).toBe(i);
    }

    // The 4th draw is REFUSED. The append still succeeds — the refusal is a
    // durable row, not a dropped command — so it acks, but the event it appended
    // is a `draw_refused`, not a `session_opened`.
    const fourth = await draw(hexi, plan);
    expect(fourth.type).toBe('ack');

    const refused = await refusals(plan);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.payload).toMatchObject({
      type: 'draw_refused',
      reason: 'budget',
      slice: 3,
      authorizedDraws: 3,
    });

    // No 4th session rowed up, and the committed accounting did not move: the
    // draw was refused, not granted.
    expect(await sessionCount(plan)).toBe(3);
    expect((await planRow(plan))?.authorizedDraws).toBe(3);
  });

  /**
   * ACCEPTANCE 2. FLIP THE INPUT. Enforcement is on AUTHORIZED DRAWS, not on
   * adapter-reported spend: three sessions that each report spend=0 (the plan's
   * `spent_micros` rollup stays 0 — the inert `~` slot) still cannot get a 4th
   * draw. If the enforcement variable were the reported number, spend=0 would
   * leave the whole budget unspent and the 4th draw would authorize. It does not.
   *
   * RED-ON-REVERT: point the gate at reported spend instead of `authorizedDraws`
   * (e.g. compare `spent_micros` to the slice) and this 4th draw authorizes,
   * because nothing was reported spent — this test goes red.
   */
  it('refuses the 4th draw even when every session reports spend=0 (the flip)', async () => {
    const alice = await connect(humanId, 'human');
    const hexi = await connect(agentId, 'agent');
    const plan = await openPlan(hexi, 'an under-reporting plan');
    await fundPlan(alice, plan, 3);

    // Three draws, each settling with a REPORTED spend of exactly zero.
    for (let i = 0; i < 3; i += 1) {
      const ack = await draw(hexi, plan);
      expect(ack.type).toBe('ack');
      const [{ id: sessionId } = { id: '' }] = await handle.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.planId, plan), eq(sessions.status, 'open')))
        .orderBy(asc(sessions.createdAt));
      await hexi.command({
        name: 'settle_session',
        roomId: room.roomId,
        sessionId,
        outcome: 'settled',
        exitSummary: 'reported nothing',
        spendMicros: 0,
        contextPct: 0,
      });
    }

    // The reconciliation layer says zero was spent…
    const row = await planRow(plan);
    expect(row?.spentMicros).toBe(0);
    // …and yet the enforcement layer — the count of draws GRANTED — is full.
    expect(row?.authorizedDraws).toBe(3);

    // So the 4th draw is refused, on the authorized-draw count, not on the (zero)
    // reported spend.
    const fourth = await draw(hexi, plan);
    expect(fourth.type).toBe('ack');
    expect(await refusals(plan)).toHaveLength(1);
    expect(await sessionCount(plan)).toBe(3);
  });

  /**
   * ACCEPTANCE 3. human = init sets the ceiling; a machine NEVER raises its own.
   * A machine-authored `set_plan_rlimit` is refused BEFORE the append, exactly as
   * a machine trying to certify is — nothing durable, a nack, the slice unchanged.
   * The same act by a human succeeds through the explicit-act gate and lifts the
   * ceiling.
   *
   * RED-ON-REVERT: drop `set_plan_rlimit` from the `authorizes-spend` class in
   * `certificationClassOf` (or the gate arm in `execute`) and hexi's raise acks,
   * the slice jumps to 100, and the machine has raised its own budget — this test
   * goes red on the nack assertion and on the unchanged-slice assertion.
   */
  it('refuses a machine raising its own slice, and lets a human raise it', async () => {
    const alice = await connect(humanId, 'human');
    const hexi = await connect(agentId, 'agent');
    const plan = await openPlan(hexi, 'whose budget is whose');
    await fundPlan(alice, plan, 1);

    // The machine tries to raise its own ceiling. Refused before the append.
    const machineRaise = await hexi.command({
      name: 'set_plan_rlimit',
      roomId: room.roomId,
      planId: plan,
      slice: 100,
    });
    expect(machineRaise.type).toBe('nack');
    if (machineRaise.type === 'nack') {
      expect(machineRaise.code).toBe('invalid');
      expect(machineRaise.message).toContain('human = init');
    }
    // Nothing durable, and the slice is exactly where the human left it.
    expect((await planRow(plan))?.rlimitSlice).toBe(1);
    const [{ n } = { n: 0 }] = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(coreEvents)
      .where(and(eq(coreEvents.roomId, room.roomId), eq(coreEvents.type, 'plan_rlimit_set')));
    expect(n).toBe(1); // only the human's funding, not the machine's raise

    // The slice of 1 bites: draw 1 authorizes, draw 2 is refused.
    expect((await draw(hexi, plan)).type).toBe('ack');
    await draw(hexi, plan);
    expect(await refusals(plan)).toHaveLength(1);
    expect(await sessionCount(plan)).toBe(1);

    // The HUMAN raises the ceiling through the explicit-act gate. Now more draws
    // authorize — the ceiling moved because a person moved it.
    const humanRaise = await fundPlan(alice, plan, 3);
    expect(humanRaise.type).toBe('ack');
    expect((await planRow(plan))?.rlimitSlice).toBe(3);

    expect((await draw(hexi, plan)).type).toBe('ack'); // draw 2
    expect((await draw(hexi, plan)).type).toBe('ack'); // draw 3
    await draw(hexi, plan); // draw 4 — refused again at the new ceiling
    expect(await refusals(plan)).toHaveLength(2);
    expect(await sessionCount(plan)).toBe(3);
  });

  /**
   * An UNFUNDED plan (NULL slice) draws freely — the pre-#118 behaviour a
   * machine-opened plan keeps. Enforcement is opt-in per plan via a human act; a
   * plan nobody funded has no ceiling to exceed. (The machine still cannot GIVE
   * itself a ceiling to raise — that is acceptance 3.)
   */
  it('lets an unfunded plan draw without a ceiling', async () => {
    const hexi = await connect(agentId, 'agent');
    const plan = await openPlan(hexi, 'an unfunded plan');
    expect((await planRow(plan))?.rlimitSlice).toBeNull();
    for (let i = 1; i <= 4; i += 1) {
      expect((await draw(hexi, plan)).type).toBe('ack');
    }
    expect(await sessionCount(plan)).toBe(4);
    expect(await refusals(plan)).toHaveLength(0);
    expect((await planRow(plan))?.authorizedDraws).toBe(4);
  });
});
