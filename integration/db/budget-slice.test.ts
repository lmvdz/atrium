import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { violatesConstraint } from '../support/constraints.js';
import { openDatabase, resetDatabase, seedRoom } from '../support/harness.js';

/**
 * THE SLICE AND THE AUTHORIZED-DRAW ACCOUNTING, AS DB FACTS (#118).
 *
 * The storage half of the budget-enforcement gate: `plans.rlimit_slice` (the
 * human-set ceiling, denominated in draws, nullable = unfunded) and
 * `plans.authorized_draws` (the committed count Atrium granted), each with its
 * non-negativity CHECK; and the `core_events` room CHECK, extended to the two new
 * ledger-only kinds `plan_rlimit_set` / `draw_refused` so an append of either
 * with a matching roomId is accepted and one with a mismatched roomId is refused
 * by the same fail-closed constraint every other kind rides.
 *
 * Raw SQL throughout, so a refusal names the constraint (see `violatesConstraint`)
 * and the mutation ledger can drop exactly one and watch exactly one go red.
 */

const handle = openDatabase();

beforeEach(async () => resetDatabase(handle));
afterAll(async () => handle.close());

async function seedAgentChannel(slug: string) {
  const seeded = await seedRoom(handle, [`${slug}-owner`, `${slug}-agent`], {
    slug,
    agents: [`${slug}-agent`],
  });
  const ownerId = seeded.people[`${slug}-owner`] as string;
  const agentId = seeded.people[`${slug}-agent`] as string;
  await handle.db.execute(sql`
    UPDATE rooms SET agent_user_id = ${agentId} WHERE id = ${seeded.roomId}
  `);
  await handle.db.execute(sql`
    INSERT INTO agents (user_id, owner_user_id, channel_room_id, host, harness, model)
    VALUES (${agentId}, ${ownerId}, ${seeded.roomId}, 'localhost', 'claude', 'opus')
  `);
  return { roomId: seeded.roomId, agentId, ownerId };
}

async function insertPlan(
  roomId: string,
  agentId: string,
  cols: { slice?: number | null; draws?: number } = {},
): Promise<string> {
  const planId = randomUUID();
  await handle.db.execute(sql`
    INSERT INTO plans (id, room_id, agent_user_id, title, rlimit_slice, authorized_draws)
    VALUES (${planId}, ${roomId}, ${agentId}, 'a plan',
            ${cols.slice ?? null}, ${cols.draws ?? 0})
  `);
  return planId;
}

/** Row a session directly under a plan — bypassing the projection, for backfill. */
async function insertSession(roomId: string, planId: string): Promise<string> {
  const sessionId = randomUUID();
  await handle.db.execute(sql`
    INSERT INTO sessions (id, room_id, plan_id, harness, model)
    VALUES (${sessionId}, ${roomId}, ${planId}, 'omp', 'haiku')
  `);
  return sessionId;
}

async function planColumns(planId: string) {
  const [row] = await handle.db.execute<{
    status: string;
    rlimit_slice: string | null;
    authorized_draws: string;
    spent_micros: string;
  }>(sql`SELECT status, rlimit_slice, authorized_draws, spent_micros
         FROM plans WHERE id = ${planId}`);
  return row;
}

describe('the plan slice and authorized-draw accounting are DB facts', () => {
  it('defaults a fresh plan to an unfunded slice (NULL) and zero authorized draws', async () => {
    const ch = await seedAgentChannel('fleet');
    const planId = await insertPlan(ch.roomId, ch.agentId);
    const [row] = await handle.db.execute<{
      rlimit_slice: string | null;
      authorized_draws: string;
    }>(sql`SELECT rlimit_slice, authorized_draws FROM plans WHERE id = ${planId}`);
    expect(row?.rlimit_slice).toBeNull();
    expect(Number(row?.authorized_draws)).toBe(0);
  });

  it('accepts a funded slice and a positive draw count', async () => {
    const ch = await seedAgentChannel('fleet');
    const planId = await insertPlan(ch.roomId, ch.agentId, { slice: 3, draws: 2 });
    const [row] = await handle.db.execute<{ rlimit_slice: string; authorized_draws: string }>(
      sql`SELECT rlimit_slice, authorized_draws FROM plans WHERE id = ${planId}`,
    );
    expect(Number(row?.rlimit_slice)).toBe(3);
    expect(Number(row?.authorized_draws)).toBe(2);
  });

  it('REFUSES a negative slice', async () => {
    const ch = await seedAgentChannel('fleet');
    await violatesConstraint('plans_rlimit_slice_nonnegative', () =>
      insertPlan(ch.roomId, ch.agentId, { slice: -1 }),
    );
  });

  it('REFUSES a negative authorized-draw count', async () => {
    const ch = await seedAgentChannel('fleet');
    await violatesConstraint('plans_authorized_draws_nonnegative', () =>
      insertPlan(ch.roomId, ch.agentId, { draws: -1 }),
    );
  });
});

describe('the payload-room CHECK enumerates the two new budget kinds', () => {
  /**
   * The two new ledger-only kinds each declare a top-level `roomId`; the extended
   * `core_events_payload_room_matches` CHECK accepts a matching one. These insert
   * through `atrium_append_core_event` so the row rides the real boundary, not a
   * naked INSERT the trigger would refuse for other reasons.
   */
  // A monotonic clock so two appends never tie on `(at, id)` and trip the
  // boundary's canonical-order gate — the same `max(now, last + 1ms)` shape the
  // real ledger uses.
  let lastAtMs = 0;
  async function appendKind(roomId: string, agentId: string, payload: Record<string, unknown>) {
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

  it('accepts plan_rlimit_set and draw_refused whose roomId matches the row', async () => {
    const ch = await seedAgentChannel('fleet');
    const planId = await insertPlan(ch.roomId, ch.agentId, { slice: 1 });
    await appendKind(ch.roomId, ch.agentId, {
      type: 'plan_rlimit_set',
      roomId: ch.roomId,
      planId,
      slice: 3,
    });
    await appendKind(ch.roomId, ch.agentId, {
      type: 'draw_refused',
      roomId: ch.roomId,
      planId,
      reason: 'budget',
      slice: 1,
      authorizedDraws: 1,
      harness: 'omp',
      model: 'haiku',
    });
    const [row] = await handle.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM core_events
          WHERE room_id = ${ch.roomId} AND type IN ('plan_rlimit_set', 'draw_refused')`,
    );
    expect(Number(row?.count)).toBe(2);
  });

  it('REFUSES a draw_refused whose payload roomId disagrees with the row (fail closed)', async () => {
    const a = await seedAgentChannel('fleet');
    const b = await seedAgentChannel('ops');
    const planId = await insertPlan(a.roomId, a.agentId, { slice: 1 });
    // The row is filed into room A, but the payload names room B: the same
    // discriminated CHECK that pins every other kind's roomId refuses it.
    await violatesConstraint('core_events_payload_room_matches', () =>
      appendKind(a.roomId, a.agentId, {
        type: 'draw_refused',
        roomId: b.roomId,
        planId,
        reason: 'budget',
        slice: 1,
        authorizedDraws: 1,
        harness: 'omp',
        model: 'haiku',
      }),
    );
  });
});

/**
 * CS-2 (#118 fix r2). The 0028 migration backfills `authorized_draws` from
 * reality — `count(sessions)` over the composite parent key `(plan_id, room_id)`
 * — because sessions already exist (since 0022) and `ADD COLUMN … DEFAULT 0`
 * would otherwise stamp every plan with existing sessions to 0 and undercount, so
 * a plan that already drew N sessions would re-authorize draws it already took.
 *
 * The fresh-volume gate cannot exercise the backfill (no sessions predate 0028
 * there), so this asserts the STATEMENT's logic directly: the correlated count is
 * keyed on `(plan_id, room_id)`, so sessions under one plan never bleed into a
 * sibling plan's count in the same room. A backfill keyed on room alone would
 * merge them; this catches that.
 */
describe('the authorized-draw backfill counts sessions per (plan, room)', () => {
  // The exact expression 0028 runs, applied here to the constructed rows below.
  async function runBackfill() {
    await handle.db.execute(sql`
      UPDATE "plans" SET "authorized_draws" = (
        SELECT count(*) FROM "sessions" s
        WHERE s."plan_id" = "plans"."id" AND s."room_id" = "plans"."room_id"
      )
    `);
  }

  it('backfills each plan to its own session count, not the room-wide total', async () => {
    const ch = await seedAgentChannel('fleet');
    // Two sibling plans in ONE room, migrated with the wrong 0 the ADD COLUMN
    // default would leave them.
    const planA = await insertPlan(ch.roomId, ch.agentId, { slice: 5, draws: 0 });
    const planB = await insertPlan(ch.roomId, ch.agentId, { slice: 5, draws: 0 });
    await insertSession(ch.roomId, planA);
    await insertSession(ch.roomId, planA);
    await insertSession(ch.roomId, planA);
    await insertSession(ch.roomId, planB);

    await runBackfill();

    // planA gets 3 and planB gets 1 — each its own count. Keyed on room alone,
    // both would read 4.
    expect(Number((await planColumns(planA))?.authorized_draws)).toBe(3);
    expect(Number((await planColumns(planB))?.authorized_draws)).toBe(1);
  });

  it('leaves a plan with no sessions at zero', async () => {
    const ch = await seedAgentChannel('fleet');
    const planId = await insertPlan(ch.roomId, ch.agentId, { slice: 2, draws: 0 });
    await runBackfill();
    expect(Number((await planColumns(planId))?.authorized_draws)).toBe(0);
  });
});

/**
 * MED-7 (#118 fix r2). 0030 extends the 0025 terminal-immutability trigger so a
 * SETTLED plan's budget receipt — `rlimit_slice` and `authorized_draws` — is
 * frozen with the rest of its closed contract. `spent_micros` (the reconciliation
 * layer) stays mutable, and an OPEN plan's budget is untouched.
 *
 * RED-ON-REVERT: drop the new `rlimit_slice`/`authorized_draws` arm from
 * `atrium_plans_terminal_immutable` (revert 0030) and the two raw UPDATEs below
 * succeed instead of raising `plans_terminal_immutable` — these go red.
 */
describe('a settled plan freezes its budget receipt', () => {
  async function settle(planId: string) {
    await handle.db.execute(sql`UPDATE plans SET status = 'settled' WHERE id = ${planId}`);
  }

  it('REFUSES raising the slice on a settled plan', async () => {
    const ch = await seedAgentChannel('fleet');
    const planId = await insertPlan(ch.roomId, ch.agentId, { slice: 3, draws: 2 });
    await settle(planId);
    await violatesConstraint('plans_terminal_immutable', () =>
      handle.db.execute(sql`UPDATE plans SET rlimit_slice = 999 WHERE id = ${planId}`),
    );
  });

  it('REFUSES moving authorized_draws on a settled plan', async () => {
    const ch = await seedAgentChannel('fleet');
    const planId = await insertPlan(ch.roomId, ch.agentId, { slice: 3, draws: 2 });
    await settle(planId);
    await violatesConstraint('plans_terminal_immutable', () =>
      handle.db.execute(sql`UPDATE plans SET authorized_draws = 0 WHERE id = ${planId}`),
    );
  });

  it('still lets a settled plan roll up spend, and leaves an open plan budget mutable', async () => {
    const ch = await seedAgentChannel('fleet');
    const settled = await insertPlan(ch.roomId, ch.agentId, { slice: 3, draws: 2 });
    await settle(settled);
    // The reconciliation layer is not frozen — the freeze is on the receipt.
    await handle.db.execute(sql`UPDATE plans SET spent_micros = 500 WHERE id = ${settled}`);
    expect(Number((await planColumns(settled))?.spent_micros)).toBe(500);

    // An OPEN plan's budget is fully mutable — the freeze is terminal-only.
    const openPlan = await insertPlan(ch.roomId, ch.agentId, { slice: 1, draws: 0 });
    await handle.db.execute(
      sql`UPDATE plans SET rlimit_slice = 9, authorized_draws = 4 WHERE id = ${openPlan}`,
    );
    const row = await planColumns(openPlan);
    expect(Number(row?.rlimit_slice)).toBe(9);
    expect(Number(row?.authorized_draws)).toBe(4);
  });
});
