import type { DatabaseHandle } from '@atrium/db';
import { coreEvents, plans, sessions } from '@atrium/db/schema';
import { and, asc, eq, sql } from 'drizzle-orm';
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
   * ACCEPTANCE 4 (#118 fix r2, CS-1). An UNFUNDED plan (NULL slice) authorizes
   * ZERO draws — fail CLOSED. The covenant is that only a HUMAN may authorize
   * spend; a machine drawing against a budget no person set is the
   * campaign-stopping default this closes. `open_plan` is `open`-class, so hexi
   * (an agent) can open a plan — but it cannot fund it, and every draw against it
   * is REFUSED with the same durable `reason=budget` receipt an over-slice draw
   * takes, until a HUMAN sets a finite slice via `set_plan_rlimit`. Then draws
   * authorize up to that slice.
   *
   * RED-ON-REVERT: restore the `plan.slice !== null` guard (so a NULL slice skips
   * enforcement and draws freely) and the first draw acks as a `session_opened`,
   * a session rows up, and `refusals(plan)` is empty — this test goes red.
   */
  it('REFUSES every draw under an unfunded plan (NULL slice = zero draws), then authorizes up to a human-set slice', async () => {
    const alice = await connect(humanId, 'human');
    const hexi = await connect(agentId, 'agent');
    const plan = await openPlan(hexi, 'an unfunded plan');
    expect((await planRow(plan))?.rlimitSlice).toBeNull();

    // Unfunded: every draw is refused, and NO session rows up. The machine cannot
    // spend against a budget no human set.
    for (let i = 1; i <= 3; i += 1) {
      const refusedDraw = await draw(hexi, plan);
      expect(refusedDraw.type).toBe('ack'); // the refusal is a durable row, so it acks
      if (refusedDraw.type === 'ack') {
        expect(refusedDraw.draw).toEqual({
          outcome: 'refused',
          reason: 'budget',
          slice: 0,
          authorizedDraws: 0,
        });
      }
    }
    expect(await sessionCount(plan)).toBe(0);
    expect(await refusals(plan)).toHaveLength(3);
    expect((await planRow(plan))?.authorizedDraws).toBe(0);
    // The unfunded refusal is receipted with an effective ceiling of zero.
    expect((await refusals(plan))[0]?.payload).toMatchObject({
      type: 'draw_refused',
      reason: 'budget',
      slice: 0,
      authorizedDraws: 0,
    });

    // A HUMAN funds the plan. Now draws authorize up to the slice, and the (N+1)th
    // is refused — the ordinary funded behaviour.
    expect((await fundPlan(alice, plan, 2)).type).toBe('ack');
    expect((await draw(hexi, plan)).type).toBe('ack'); // draw 1
    expect((await draw(hexi, plan)).type).toBe('ack'); // draw 2
    await draw(hexi, plan); // draw 3 — refused at the funded ceiling
    expect(await sessionCount(plan)).toBe(2);
    expect((await planRow(plan))?.authorizedDraws).toBe(2);
    expect(await refusals(plan)).toHaveLength(4); // 3 unfunded + 1 over-slice
  });

  /**
   * HIGH-3 (#118 fix r2). A refused draw must be distinguishable from a grant IN
   * THE COMMAND RESULT — not only by reading back the ledger. Both a
   * `session_opened` and a `draw_refused` APPEND and so both ack with empty
   * `issues`; an adapter that only watched the ack shape could proceed as if a
   * refused session opened. The ack carries a `draw` outcome so it cannot.
   *
   * RED-ON-REVERT: stop populating `draw` in `open_session`'s result (or drop it
   * from the ack frame) and the `granted` / `refused` assertions below go
   * undefined — this test goes red.
   */
  it('carries the draw outcome in the ack so a caller tells a granted session from a refused draw', async () => {
    const alice = await connect(humanId, 'human');
    const hexi = await connect(agentId, 'agent');
    const plan = await openPlan(hexi, 'a plan whose result speaks');
    await fundPlan(alice, plan, 1);

    // The granted draw names the session it opened.
    const granted = await draw(hexi, plan);
    expect(granted.type).toBe('ack');
    if (granted.type === 'ack') {
      expect(granted.draw?.outcome).toBe('granted');
      if (granted.draw?.outcome === 'granted') {
        const [row] = await handle.db
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.planId, plan));
        expect(granted.draw.sessionId).toBe(row?.id);
      }
    }

    // The refused draw names the budget it was checked against — and NO session id.
    const refused = await draw(hexi, plan);
    expect(refused.type).toBe('ack');
    if (refused.type === 'ack') {
      expect(refused.draw).toEqual({
        outcome: 'refused',
        reason: 'budget',
        slice: 1,
        authorizedDraws: 1,
      });
    }
  });
});

/**
 * HIGH-5 (#118 fix r2.1 — deterministic race, replacing a flaky r2 guard). The
 * draw check runs in `authorize`, under the append lock. WITHIN one server
 * process the in-process `runExclusive` mutex already serializes every
 * append, so a test that draws sequentially through ONE server never
 * exercises the DB-level guard — the `pg_advisory_xact_lock` the append
 * takes (`ledger.ts:975`) is the ONLY thing standing between two SEPARATE
 * processes both reading the same `authorized_draws` and both granting the
 * Nth draw (a classic TOCTOU). Remove that advisory lock and a
 * single-process test stays green while the real multi-process race
 * silently double-draws.
 *
 * A bare `Promise.all` on two `open_session`s is NOT a reliable guard for
 * this: with no barrier, whichever racer's connection happens to finish its
 * *entire* transaction (lock + read + insert + commit) before the other even
 * issues its authorize-read wins "by luck" — the test can PASS even with the
 * advisory lock deleted, because ordinary scheduling can serialize the two
 * racers all on its own. That false-negative is what a gauntlet caught.
 *
 * So this test builds its OWN barrier, independent of the lock under test: a
 * THIRD connection takes `SELECT ... FOR UPDATE` on the contested plan row
 * before either racer's command is even sent. `authorize`'s own read
 * (commands.ts, `open_session`) is a `SELECT ... FOR SHARE` on that same
 * row, and FOR SHARE conflicts with FOR UPDATE — so both racers'
 * authorize-reads are forced to queue behind the barrier NO MATTER what
 * `ledger.ts` does with the advisory lock:
 *
 *  - WITH the advisory lock present: only one racer can even reach the FOR
 *    SHARE read at a time (the other is still queued on the advisory lock,
 *    which the first holds until its whole transaction commits). So when the
 *    barrier releases, at most one racer is waiting on the row — it reads
 *    authorized_draws=0 and commits; the second then acquires the advisory
 *    lock, reads 1, and refuses. Deterministic grant/refuse split, every run.
 *  - WITHOUT it (reverted): nothing serializes the two racers before the row
 *    read, so BOTH pile up on the barrier at once. Releasing it lets Postgres
 *    grant FOR SHARE to both simultaneously (share locks are mutually
 *    compatible) — both read authorized_draws=0 and both grant. Two sessions
 *    row up against a slice of one, every run.
 *
 * RED-ON-REVERT: delete the `pg_advisory_xact_lock` line in `ledger.ts`'s
 * `appendBatch` and this test reliably — not just occasionally — sees both
 * racers granted (`outcomes` is `['granted','granted']`, not
 * `['granted','refused']`), and goes red on every run, because the barrier
 * forces the race window open regardless of what the app-level lock does.
 * See the #118 fix-round-2.1 receipt for the repeated-run (5x with the lock,
 * 5x without) evidence.
 */
describe('the draw check serializes across processes on the DB advisory lock', () => {
  it('grants exactly one of two draws forced to race the slice boundary on separate server instances', async () => {
    // Fund a slice of exactly 1 through the primary server, with zero prior draws:
    // the very next draw is the contested Nth (N=1). No draws have happened yet, so
    // both racers read authorized_draws = 0 in their authorize step once unblocked.
    const alice = await connect(humanId, 'human');
    const opener = await connect(agentId, 'agent');
    const plan = await openPlan(opener, 'a contested plan');
    expect((await fundPlan(alice, plan, 1)).type).toBe('ack');

    // Two independent server processes on the same database. Each is a real handle
    // with its own pool and its own in-process mutex.
    const a = await startSecondInstance();
    const b = await startSecondInstance();
    const clientA = await TestClient.connect(a.server.url, agentId, { principalKind: 'agent' });
    const clientB = await TestClient.connect(b.server.url, agentId, { principalKind: 'agent' });

    // A third, independent connection holds an exclusive row lock on the
    // contested plan — the barrier `authorize`'s own FOR SHARE read must queue
    // behind, regardless of whether ledger.ts's advisory lock exists at all.
    let releaseBarrier!: () => void;
    const barrierReleased = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let barrierAcquired!: () => void;
    const barrierReady = new Promise<void>((resolve) => {
      barrierAcquired = resolve;
    });
    const barrier = handle.db.transaction(async (tx) => {
      await tx.select({ id: plans.id }).from(plans).where(eq(plans.id, plan)).for('update');
      barrierAcquired();
      await barrierReleased;
    });

    try {
      await barrierReady;

      // Fire both draws while the barrier is held. Neither racer's authorize-read
      // can complete yet, no matter which lock is or isn't in play — with the
      // advisory lock, the loser is stuck behind the winner instead of behind the
      // barrier, but it is stuck all the same.
      const racePromise = Promise.all([
        clientA.command({
          name: 'open_session',
          roomId: room.roomId,
          planId: plan,
          harness: 'omp',
          model: 'haiku',
        }),
        clientB.command({
          name: 'open_session',
          roomId: room.roomId,
          planId: plan,
          harness: 'omp',
          model: 'haiku',
        }),
      ]);

      // Let both commands reach Postgres and queue — on the barrier directly
      // (no advisory lock), or behind whichever racer won the advisory lock (which
      // is itself queued on the barrier). Either way both are provably blocked for
      // as long as the barrier is held; this only needs to outlast the network +
      // parse hop, not any actual work.
      await new Promise((resolve) => setTimeout(resolve, 400));
      releaseBarrier();
      await barrier;

      const [ackA, ackB] = await racePromise;

      // Both commands succeed (a refusal is a durable row, so it acks too), but the
      // outcomes must be complementary: exactly one granted, exactly one refused.
      expect(ackA.type).toBe('ack');
      expect(ackB.type).toBe('ack');
      const outcomes = [ackA, ackB]
        .map((ack) => (ack.type === 'ack' ? ack.draw?.outcome : undefined))
        .sort();
      expect(outcomes).toEqual(['granted', 'refused']);

      // And the durable state agrees: one session, one draw_refused, the committed
      // count exactly at the slice — the DB lock let the boundary be crossed once.
      expect(await sessionCount(plan)).toBe(1);
      expect(await refusals(plan)).toHaveLength(1);
      expect((await planRow(plan))?.authorizedDraws).toBe(1);
    } finally {
      releaseBarrier();
      await barrier.catch(() => {});
      await clientA.close();
      await clientB.close();
      await a.close();
      await b.close();
    }
  });
});
