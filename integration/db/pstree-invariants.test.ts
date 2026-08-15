import { randomUUID } from 'node:crypto';
import { provisionAgentConfig } from '@atrium/auth';
import { agents } from '@atrium/db/schema';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { describeError, violatesConstraint } from '../support/constraints.js';
import { openDatabase, resetDatabase, seedRoom } from '../support/harness.js';

/**
 * The pstree invariant, enforced IN THE DATABASE (#116, from #114's resolution).
 *
 * The claim these tests defend: agent → plan → session is fixed depth, one
 * parent, one room; a session cannot be a parent; and the ownership chain
 * terminates at a human — none of it by application convention, all of it by
 * DDL, four ways:
 *
 *   1. `sessions.plan_id` NOT NULL + the `sessions_plan_same_room_fk` composite
 *      FK → exactly one parent, in the same room.
 *   2. no `parent_session_id` column exists → a session cannot be a parent.
 *   3. `plans_room_matches_agent_channel` → a plan's room is its agent's channel.
 *   4. `agents_owner_is_human` ∧ `agents_user_is_agent` → the chain ends at a
 *      human, and agent config is never a person's.
 *
 * Raw SQL throughout, so a refusal surfaces the *named* constraint or trigger
 * (see `violatesConstraint`) rather than "a statement threw", and the mutation
 * ledger can drop each trigger and watch exactly one of these go red.
 */

const handle = openDatabase();

beforeEach(async () => resetDatabase(handle));
afterAll(async () => handle.close());

/**
 * A room that is an agent's channel: an owner (human), an agent principal, and
 * the `agents` config row binding them. The room is the agent's `channel_room_id`.
 */
async function seedAgentChannel(slug: string) {
  const seeded = await seedRoom(handle, [`${slug}-owner`, `${slug}-agent`], {
    slug,
    agents: [`${slug}-agent`],
  });
  const ownerId = seeded.people[`${slug}-owner`] as string;
  const agentId = seeded.people[`${slug}-agent`] as string;
  // The channel must name the agent BEFORE the config lands: the composite FK
  // `agents_channel_owned_fk` (0024) reads this back-reference. Claim it, then
  // write the sidecar — the same order `provisionAgentConfig` uses.
  await handle.db.execute(sql`
    UPDATE rooms SET agent_user_id = ${agentId} WHERE id = ${seeded.roomId}
  `);
  await handle.db.execute(sql`
    INSERT INTO agents (user_id, owner_user_id, channel_room_id, host, harness, model)
    VALUES (${agentId}, ${ownerId}, ${seeded.roomId}, 'localhost', 'claude', 'opus')
  `);
  return { roomId: seeded.roomId, agentId, ownerId };
}

async function insertPlan(roomId: string, agentId: string): Promise<string> {
  const planId = randomUUID();
  await handle.db.execute(sql`
    INSERT INTO plans (id, room_id, agent_user_id, title)
    VALUES (${planId}, ${roomId}, ${agentId}, 'a plan')
  `);
  return planId;
}

async function insertSession(roomId: string, planId: string): Promise<void> {
  await handle.db.execute(sql`
    INSERT INTO sessions (room_id, plan_id, harness, model)
    VALUES (${roomId}, ${planId}, 'claude', 'opus')
  `);
}

describe('the pstree invariant is a DB fact, not a convention', () => {
  it('accepts the depth it is meant to: agent → plan → session', async () => {
    const ch = await seedAgentChannel('fleet');
    const planId = await insertPlan(ch.roomId, ch.agentId);
    await insertSession(ch.roomId, planId); // no throw — the one legal shape.
    const [countRow] = await handle.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM sessions WHERE plan_id = ${planId}`,
    );
    expect(Number(countRow?.count)).toBe(1);
  });

  // ── way 1: exactly one parent, in the same room ─────────────────────────────

  it('REFUSES a session whose plan does not exist', async () => {
    const ch = await seedAgentChannel('fleet');
    await violatesConstraint('sessions_plan_same_room_fk', () =>
      insertSession(ch.roomId, randomUUID()),
    );
  });

  it('REFUSES a session whose plan lives in another room', async () => {
    const a = await seedAgentChannel('fleet');
    const b = await seedAgentChannel('ops');
    const planInA = await insertPlan(a.roomId, a.agentId);
    // A session filed into room B, pointing at room A's plan: the composite FK
    // (room_id, plan_id) → plans(room_id, id) has no (B, planInA) row. One parent,
    // same room — the cross-room parent cannot be spelled.
    await violatesConstraint('sessions_plan_same_room_fk', () => insertSession(b.roomId, planInA));
  });

  it('REFUSES a session with no plan at all — plan_id is NOT NULL', async () => {
    const ch = await seedAgentChannel('fleet');
    // NOT NULL is not a *named* constraint, so this reads the error rather than a
    // constraint name: a session without a parent is refused by the column being
    // NOT NULL, the "exactly one" half that the composite FK does not state.
    let refused = '';
    try {
      await handle.db.execute(sql`
        INSERT INTO sessions (room_id, plan_id, harness, model)
        VALUES (${ch.roomId}, NULL, 'claude', 'opus')
      `);
    } catch (error) {
      refused = describeError(error);
    }
    expect(refused).toContain('plan_id');
    expect(refused.toLowerCase()).toContain('not-null');
  });

  // ── way 2: a session cannot be a parent, BY CONSTRUCTION ─────────────────────

  it("has NO column by which a session could be another session's parent", async () => {
    // The strongest form (#111): you cannot violate an FK that does not exist.
    // Read the live table's columns and assert none is a self-referential parent
    // pointer — not `parent_session_id`, not `parent_id`, nothing that names a
    // session as a session's parent. A grep over the source would prove the same,
    // but this proves it of the DEPLOYED table the migrations actually built.
    const columns = await handle.db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sessions'
    `);
    const names = columns.map((c) => c.column_name);
    expect(names).toContain('plan_id'); // the one upward edge that DOES exist.
    for (const name of names) {
      expect(name).not.toMatch(/parent/i);
      // The only *_id columns are room_id and plan_id; no session self-reference.
      expect(name).not.toBe('parent_session_id');
      expect(name).not.toBe('session_id');
    }
    // And no foreign key on `sessions` targets `sessions` — no self-parent edge.
    const selfFks = await handle.db.execute<{ conname: string }>(sql`
      SELECT c.conname
      FROM pg_constraint c
      WHERE c.contype = 'f'
        AND c.conrelid = 'public.sessions'::regclass
        AND c.confrelid = 'public.sessions'::regclass
    `);
    expect(selfFks).toHaveLength(0);
  });

  // ── way 3: a plan's room is its agent's channel ─────────────────────────────

  it("REFUSES a plan whose room is not its agent's channel", async () => {
    const a = await seedAgentChannel('fleet');
    const b = await seedAgentChannel('ops');
    // Agent A opening a plan in room B — a room it does not own as its channel.
    await violatesConstraint('plans_room_matches_agent_channel', () =>
      handle.db.execute(sql`
        INSERT INTO plans (id, room_id, agent_user_id, title)
        VALUES (${randomUUID()}, ${b.roomId}, ${a.agentId}, 'wrong channel')
      `),
    );
  });

  // ── way 4: the chain terminates at a human ──────────────────────────────────

  it('REFUSES an agents row whose owner is not a human', async () => {
    const a = await seedAgentChannel('fleet');
    const b = await seedAgentChannel('ops');
    // Configure a fresh agent principal owned by agent A (a machine), not a person.
    const orphan = await seedRoom(handle, ['orphan-agent'], {
      slug: 'orphan',
      agents: ['orphan-agent'],
    });
    const orphanAgent = orphan.people['orphan-agent'] as string;
    await violatesConstraint('agents_owner_is_human', () =>
      handle.db.execute(sql`
        INSERT INTO agents (user_id, owner_user_id, channel_room_id, host, harness, model)
        VALUES (${orphanAgent}, ${a.agentId}, ${orphan.roomId}, 'h', 'claude', 'opus')
      `),
    );
    expect(b.agentId).toBeTruthy(); // (ops seeded so the two suites do not collide)
  });

  it('REFUSES an agents row whose user is not an agent', async () => {
    // A human's uuid dressed as agent config.
    const seeded = await seedRoom(handle, ['carol'], { slug: 'carol-room' });
    const carol = seeded.people.carol as string;
    await violatesConstraint('agents_user_is_agent', () =>
      handle.db.execute(sql`
        INSERT INTO agents (user_id, owner_user_id, channel_room_id, host, harness, model)
        VALUES (${carol}, ${carol}, ${seeded.roomId}, 'h', 'claude', 'opus')
      `),
    );
  });

  // ── the invariant is closed under UPDATE, not only INSERT (#116 fix r2) ──────
  //
  // Round 1's triggers all fire `BEFORE INSERT OR UPDATE`, but only INSERT was
  // ever exercised — a regression to `BEFORE INSERT` alone would have stayed
  // green. These drive the UPDATE arm of every pstree trigger, so that regression
  // now fails a test, and pin the two new guards 0024 adds.

  it("REFUSES moving a plan out of its agent's channel by UPDATE (way 3, under mutation)", async () => {
    const a = await seedAgentChannel('fleet');
    const b = await seedAgentChannel('ops');
    const planId = await insertPlan(a.roomId, a.agentId);
    // The plan is legal where it was born. Now try to relocate it into room B —
    // a room agent A does not own. If `plans_room_matches_agent_channel` were
    // INSERT-only, this UPDATE would slip through and orphan the plan.
    await violatesConstraint('plans_room_matches_agent_channel', () =>
      handle.db.execute(sql`UPDATE plans SET room_id = ${b.roomId} WHERE id = ${planId}`),
    );
  });

  it("REFUSES re-pointing a plan's agent to one whose channel differs, by UPDATE", async () => {
    const a = await seedAgentChannel('fleet');
    const b = await seedAgentChannel('ops');
    const planId = await insertPlan(a.roomId, a.agentId);
    // Same trigger, the other column: keep the room, swap the agent to B (whose
    // channel is room B, not this plan's room A).
    await violatesConstraint('plans_room_matches_agent_channel', () =>
      handle.db.execute(sql`UPDATE plans SET agent_user_id = ${b.agentId} WHERE id = ${planId}`),
    );
  });

  it('REFUSES changing an agent owner to a non-human by UPDATE (way 4, under mutation)', async () => {
    const a = await seedAgentChannel('fleet');
    const b = await seedAgentChannel('ops');
    // A legitimate agents row exists (owner is human). Flip its owner to an agent
    // — a machine owning a machine. INSERT-only immutability would miss this.
    await violatesConstraint('agents_owner_is_human', () =>
      handle.db.execute(
        sql`UPDATE agents SET owner_user_id = ${b.agentId} WHERE user_id = ${a.agentId}`,
      ),
    );
  });

  it('REFUSES changing an agent config to a human user_id by UPDATE (way 4, under mutation)', async () => {
    const a = await seedAgentChannel('fleet');
    // Try to re-key the config onto the human owner — a person holding agent
    // config. The BEFORE UPDATE arm of `agents_user_is_agent` refuses it.
    await violatesConstraint('agents_user_is_agent', () =>
      handle.db.execute(sql`UPDATE agents SET user_id = ${a.ownerId} WHERE user_id = ${a.agentId}`),
    );
  });

  // ── #116 fix r2: reciprocity — an agent's channel is a room IT owns ──────────

  it('REFUSES an agents row whose channel room it does not own (reciprocity)', async () => {
    // A room that belongs to nobody as a channel: seed a plain room, leave its
    // agent_user_id NULL, and try to name it as a fresh agent's channel.
    const seeded = await seedRoom(handle, ['owner', 'drone'], {
      slug: 'unowned',
      agents: ['drone'],
    });
    const ownerId = seeded.people.owner as string;
    const droneId = seeded.people.drone as string;
    // No `UPDATE rooms SET agent_user_id` first, so rooms.agent_user_id is NULL:
    // (channel_room_id, user_id) has no matching (id, agent_user_id) row.
    await violatesConstraint('agents_channel_owned_fk', () =>
      handle.db.execute(sql`
        INSERT INTO agents (user_id, owner_user_id, channel_room_id, host, harness, model)
        VALUES (${droneId}, ${ownerId}, ${seeded.roomId}, 'h', 'claude', 'opus')
      `),
    );
  });

  it('REFUSES a channel pointing at a room a DIFFERENT agent owns (reciprocity)', async () => {
    // A room owned (in rooms.agent_user_id) by a bare agent principal `other` that
    // holds no config of its own — so the room is NOT any agent's channel and the
    // unique agents_channel_room_key does not intercept. drone then tries to name
    // it as ITS channel: the composite FK finds (room, other), not (room, drone).
    const seeded = await seedRoom(handle, ['owner2', 'drone2', 'other'], {
      slug: 'poach',
      agents: ['drone2', 'other'],
    });
    const ownerId = seeded.people.owner2 as string;
    const droneId = seeded.people.drone2 as string;
    const otherId = seeded.people.other as string;
    await handle.db.execute(
      sql`UPDATE rooms SET agent_user_id = ${otherId} WHERE id = ${seeded.roomId}`,
    );
    await violatesConstraint('agents_channel_owned_fk', () =>
      handle.db.execute(sql`
        INSERT INTO agents (user_id, owner_user_id, channel_room_id, host, harness, model)
        VALUES (${droneId}, ${ownerId}, ${seeded.roomId}, 'h', 'claude', 'opus')
      `),
    );
  });

  it('makes channel_room_id immutable, so a channel change cannot orphan plans (finding 1)', async () => {
    const a = await seedAgentChannel('fleet');
    await insertPlan(a.roomId, a.agentId); // a plan lives in a's channel
    // A fresh room a's agent does not own (agent_user_id NULL). The finding-1
    // exploit verbatim: point the agent's channel at it. The composite FK finds
    // no (spare, a.agentId) tuple, so the channel cannot move — and with the
    // one-channel-per-agent unique index there is no room a's agent DOES own to
    // move to either, so channel_room_id is immutable and the plan in a.roomId
    // cannot be orphaned.
    const spare = await seedRoom(handle, ['bystander'], { slug: 'spare' });
    await violatesConstraint('agents_channel_owned_fk', () =>
      handle.db.execute(
        sql`UPDATE agents SET channel_room_id = ${spare.roomId} WHERE user_id = ${a.agentId}`,
      ),
    );
  });

  it('REFUSES naming a non-agent as a room owner (rooms_agent_user_is_agent)', async () => {
    // A plain room and a human. Point the room's agent_user_id at the human — the
    // reciprocity half a foreign key cannot state. This is the UPDATE path, and
    // the only test that pins this trigger on its own.
    const seeded = await seedRoom(handle, ['dave'], { slug: 'daves-room' });
    const dave = seeded.people.dave as string;
    await violatesConstraint('rooms_agent_user_is_agent', () =>
      handle.db.execute(sql`UPDATE rooms SET agent_user_id = ${dave} WHERE id = ${seeded.roomId}`),
    );
  });

  // ── the payload-room CHECK still fails CLOSED after learning six new kinds ───

  it('enumerates the six lifecycle kinds in the room CHECK, and keeps its fail-closed tail', async () => {
    const [defRow] = await handle.db.execute<{ def: string }>(sql`
      SELECT pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      WHERE c.conname = 'core_events_payload_room_matches'
        AND c.conrelid = 'public.core_events'::regclass
    `);
    const def = defRow?.def ?? '';
    for (const kind of [
      'plan_opened',
      'plan_settled',
      'session_opened',
      'session_settled',
      'session_failed',
      'signal_raised',
    ]) {
      expect(def, kind).toContain(kind);
    }
    // The `coalesce(…, false)` tail is what refuses a kind the CASE does not
    // enumerate — a ninth event type added without a room policy fails closed
    // rather than being waved through. Dropping it is the mutation this pins.
    expect(def.toLowerCase()).toContain('false)');
  });
});

/**
 * `@atrium/auth`'s `provisionAgentConfig` (#116), the agent-config write. The
 * function itself checks nothing about the two kinds — the triggers do — so this
 * is where the two meet: a legitimate config lands, and the same call with a
 * non-human owner is refused by the database through the function's own INSERT.
 */
describe('provisionAgentConfig writes the sidecar and inherits the DB triggers', () => {
  it('writes an agents row for a valid agent + human owner', async () => {
    const seeded = await seedRoom(handle, ['owner', 'hexi'], { slug: 'chan', agents: ['hexi'] });
    const ownerId = seeded.people.owner as string;
    const agentId = seeded.people.hexi as string;
    const config = await provisionAgentConfig({
      db: handle.db,
      userId: agentId,
      ownerUserId: ownerId,
      channelRoomId: seeded.roomId,
      host: 'localhost',
      harness: 'claude',
      model: 'opus',
      budgetLimitMicros: 5_000_000,
    });
    expect(config).toMatchObject({ userId: agentId, ownerUserId: ownerId, model: 'opus' });
    const [row] = await handle.db.select().from(agents).where(eq(agents.userId, agentId));
    expect(row).toMatchObject({ channelRoomId: seeded.roomId, budgetLimitMicros: 5_000_000 });
  });

  it('is refused by the DB when the owner is not a human', async () => {
    // Two agents; one is asked to own the other. The function does not check —
    // the trigger does, through the INSERT the function issues.
    const seeded = await seedRoom(handle, ['machine-a', 'machine-b'], {
      slug: 'chan',
      agents: ['machine-a', 'machine-b'],
    });
    await violatesConstraint('agents_owner_is_human', () =>
      provisionAgentConfig({
        db: handle.db,
        userId: seeded.people['machine-b'] as string,
        ownerUserId: seeded.people['machine-a'] as string,
        channelRoomId: seeded.roomId,
        host: 'h',
        harness: 'claude',
        model: 'opus',
      }),
    );
  });
});

/**
 * A SETTLED/FAILED ROW IS DONE, AS A TABLE FACT (#116 fix r3, F-B, drizzle/0025).
 *
 * The command path already enforces one-exit-per-plan/session (projectPlanSettled
 * / projectSessionExit scope their UPDATE with `status = 'open'`). But that is a
 * property of one writer, not of the table: raw SQL — or a future projection that
 * forgets the predicate — could `UPDATE plans SET status='open'` a settled plan
 * and re-settle it, or rewrite a session's exit receipt. The two BEFORE UPDATE
 * triggers 0025 adds make "done is one-way" a fact of the `plans` and `sessions`
 * tables, and this drives them through raw SQL so a refusal surfaces the *named*
 * trigger. It also backstops F-A: even if the session-open status check
 * regressed, the plan it targets cannot be reopened here.
 */
describe('terminal plan/session states are frozen at the table (F-B)', () => {
  /** A plan raw-settled through the legal open → settled transition. */
  async function settledPlan(): Promise<{ roomId: string; planId: string }> {
    const ch = await seedAgentChannel('fleet');
    const planId = await insertPlan(ch.roomId, ch.agentId);
    // OLD is `open` here, so the terminal guard does not fire — the legitimate
    // settle passes exactly as the projection's does.
    await handle.db.execute(sql`UPDATE plans SET status = 'settled' WHERE id = ${planId}`);
    return { roomId: ch.roomId, planId };
  }

  /** A session raw-inserted, then raw-exited to a terminal `status`. */
  async function exitedSession(
    status: 'settled' | 'failed',
  ): Promise<{ roomId: string; sessionId: string }> {
    const ch = await seedAgentChannel('fleet');
    const planId = await insertPlan(ch.roomId, ch.agentId);
    const sessionId = randomUUID();
    await handle.db.execute(sql`
      INSERT INTO sessions (id, room_id, plan_id, harness, model)
      VALUES (${sessionId}, ${ch.roomId}, ${planId}, 'claude', 'opus')
    `);
    await handle.db.execute(
      sql`UPDATE sessions SET status = ${status}, exit_summary = 'done' WHERE id = ${sessionId}`,
    );
    return { roomId: ch.roomId, sessionId };
  }

  it('REFUSES reopening a settled plan by UPDATE', async () => {
    const { planId } = await settledPlan();
    await violatesConstraint('plans_terminal_immutable', () =>
      handle.db.execute(sql`UPDATE plans SET status = 'open' WHERE id = ${planId}`),
    );
    // Still settled: the reopen was refused, not silently applied.
    const [row] = await handle.db.execute<{ status: string }>(
      sql`SELECT status FROM plans WHERE id = ${planId}`,
    );
    expect(row?.status).toBe('settled');
  });

  it("REFUSES rewriting a settled plan's receipt pointer by UPDATE", async () => {
    const { planId } = await settledPlan();
    await violatesConstraint('plans_terminal_immutable', () =>
      handle.db.execute(
        sql`UPDATE plans SET settled_by_event_id = 'forged-event' WHERE id = ${planId}`,
      ),
    );
  });

  it('ALLOWS an unrelated touch on a settled plan — the freeze is on the receipt, not the row', async () => {
    // The control that keeps the trigger honest: it must refuse a status/receipt
    // rewrite, not every write. A spend rollup or an updated_at touch is fine.
    const { planId } = await settledPlan();
    await handle.db.execute(sql`UPDATE plans SET spent_micros = 42 WHERE id = ${planId}`);
    const [row] = await handle.db.execute<{ spent_micros: string; status: string }>(
      sql`SELECT spent_micros, status FROM plans WHERE id = ${planId}`,
    );
    expect(row?.status).toBe('settled');
    expect(Number(row?.spent_micros)).toBe(42);
  });

  for (const status of ['settled', 'failed'] as const) {
    it(`REFUSES reopening a ${status} session by UPDATE`, async () => {
      const { sessionId } = await exitedSession(status);
      await violatesConstraint('sessions_terminal_immutable', () =>
        handle.db.execute(sql`UPDATE sessions SET status = 'open' WHERE id = ${sessionId}`),
      );
      const [row] = await handle.db.execute<{ status: string }>(
        sql`SELECT status FROM sessions WHERE id = ${sessionId}`,
      );
      expect(row?.status).toBe(status);
    });
  }

  it('REFUSES flipping a settled session to failed — two contradictory receipts for one process', async () => {
    const { sessionId } = await exitedSession('settled');
    await violatesConstraint('sessions_terminal_immutable', () =>
      handle.db.execute(sql`UPDATE sessions SET status = 'failed' WHERE id = ${sessionId}`),
    );
  });

  it("REFUSES rewriting a terminal session's exit receipt by UPDATE", async () => {
    const { sessionId } = await exitedSession('failed');
    await violatesConstraint('sessions_terminal_immutable', () =>
      handle.db.execute(
        sql`UPDATE sessions SET exit_summary = 'rewritten', spend_micros = 999 WHERE id = ${sessionId}`,
      ),
    );
  });

  it('ALLOWS an unrelated touch on a terminal session — the freeze is on the receipt, not the row', async () => {
    const { sessionId } = await exitedSession('settled');
    await handle.db.execute(sql`UPDATE sessions SET updated_at = now() WHERE id = ${sessionId}`);
    const [row] = await handle.db.execute<{ status: string; exit_summary: string }>(
      sql`SELECT status, exit_summary FROM sessions WHERE id = ${sessionId}`,
    );
    expect(row?.status).toBe('settled');
    expect(row?.exit_summary).toBe('done');
  });

  // ── TERMINAL-NULL PROGRESS IS A TABLE FACT (#159 fix, finding 5) ──────────────
  //
  // The settle projection clears `sessions.progress` to NULL in the same UPDATE as
  // the exit receipt — the durable receipt replaces the live stream wholesale — and
  // a CHECK + the terminal trigger's progress clause make that the TABLE's fact, not
  // one writer's discipline. A `~` preview may never outlive the receipt.
  const sampleProgress = sql`'{"progressSeq":0,"phase":"writing","spendMicros":null,"contextPct":null,"updatedAt":"2026-08-15T00:00:00.000Z"}'::jsonb`;

  it('REFUSES constructing a terminal session that carries a live preview (the CHECK)', async () => {
    // A settled row with non-null progress is refused at INSERT — no trigger involved
    // (the terminal-immutability trigger is BEFORE UPDATE only), so the CHECK itself
    // is what binds. Revert the `status = 'open' OR progress IS NULL` CHECK and this
    // row lands.
    const ch = await seedAgentChannel('fleet');
    const planId = await insertPlan(ch.roomId, ch.agentId);
    await violatesConstraint('sessions_progress_open_or_null', () =>
      handle.db.execute(sql`
        INSERT INTO sessions (id, room_id, plan_id, harness, model, status, exit_summary, progress)
        VALUES (${randomUUID()}, ${ch.roomId}, ${planId}, 'claude', 'opus', 'settled', 'done', ${sampleProgress})
      `),
    );
  });

  it('ALLOWS a live preview on an OPEN session — the CHECK binds only the terminal state', async () => {
    // The control that keeps the CHECK honest: a running session streams its `~`
    // preview freely; it is only refused once the session is terminal.
    const ch = await seedAgentChannel('fleet');
    const planId = await insertPlan(ch.roomId, ch.agentId);
    const sessionId = randomUUID();
    await handle.db.execute(sql`
      INSERT INTO sessions (id, room_id, plan_id, harness, model, progress)
      VALUES (${sessionId}, ${ch.roomId}, ${planId}, 'claude', 'opus', ${sampleProgress})
    `);
    const [row] = await handle.db.execute<{ status: string }>(
      sql`SELECT status FROM sessions WHERE id = ${sessionId}`,
    );
    expect(row?.status).toBe('open');
  });

  it('REFUSES resurrecting a live preview onto an already-terminal session (the trigger)', async () => {
    // A terminal session's progress was cleared to NULL at exit. Writing a new preview
    // onto it — the "stale preview outlives the receipt" hazard — is refused by the
    // terminal-immutability trigger's progress clause (which fires BEFORE the CHECK).
    // Revert the trigger's progress clause AND the CHECK and this UPDATE lands.
    const { sessionId } = await exitedSession('settled');
    await violatesConstraint('sessions_terminal_immutable', () =>
      handle.db.execute(
        sql`UPDATE sessions SET progress = ${sampleProgress} WHERE id = ${sessionId}`,
      ),
    );
    const [row] = await handle.db.execute<{ progress: unknown }>(
      sql`SELECT progress FROM sessions WHERE id = ${sessionId}`,
    );
    expect(row?.progress ?? null).toBeNull();
  });
});

/**
 * AN AGENT PROPOSER NAMES AN AGENT, AS A TABLE FACT (#117 fix r2, F5, drizzle/0027).
 *
 * 0026 widened `proposer_kind` with `'agent'` and grew `proposals_proposer_
 * identified` one arm — `proposer_kind='agent' AND proposer_user_id IS NOT NULL`
 * — whose COMMENT claims the id names the agent's "own agent-kind users row". A
 * CHECK cannot cross to `users.principal_kind`, so it proves only NOT NULL: an
 * INSERT with a HUMAN uuid satisfied it and read as an agent that staged the
 * reading. The blind dual-lineage gauntlet flagged that the constraint did not
 * do what it said. 0027 adds the `proposals_agent_proposer_is_agent` trigger —
 * the sibling of 0021 `agents_user_is_agent` and 0024 `rooms_agent_user_is_agent`
 * — reading `users.principal_kind` for the agent arm only.
 *
 * Raw SQL, so a refusal surfaces the *named* trigger: drop it from 0027 and
 * exactly the dishonest-attribution cases below go green (the row lands), while
 * the honest case and the human/model arms are untouched.
 */
describe('an agent proposal names an agent, at the table (F5)', () => {
  /** A room with a human author and an agent principal that can stage a `~`. */
  async function seedProposerRoom(slug: string) {
    const seeded = await seedRoom(handle, [`${slug}-human`, `${slug}-agent`], {
      slug,
      agents: [`${slug}-agent`],
    });
    return {
      roomId: seeded.roomId,
      humanId: seeded.people[`${slug}-human`] as string,
      agentId: seeded.people[`${slug}-agent`] as string,
    };
  }

  /** Stage a reading as `proposerKind`, attributed to `proposerUserId`. */
  function stageProposal(input: {
    roomId: string;
    proposalId: string;
    proposerKind: 'agent' | 'human';
    proposerUserId: string;
  }) {
    return handle.db.execute(sql`
      INSERT INTO proposals
        (id, room_id, type, payload, confidence, proposer_kind, proposer_user_id,
         staged_by_kind, staged_by_id, status)
      VALUES
        (${input.proposalId}, ${input.roomId}, 'claim',
         ${JSON.stringify({ statement: 's', claimant: input.proposerUserId })}::jsonb,
         0.9, ${input.proposerKind}, ${input.proposerUserId},
         ${input.proposerKind}, ${input.proposerUserId}, 'proposed')
    `);
  }

  it('ACCEPTS an agent proposal whose proposer_user_id is an agent-kind identity', async () => {
    const r = await seedProposerRoom('honest');
    const proposalId = randomUUID();
    await stageProposal({
      roomId: r.roomId,
      proposalId,
      proposerKind: 'agent',
      proposerUserId: r.agentId,
    }); // the one legal shape — a machine drafting `~` as itself.
    const [row] = await handle.db.execute<{ proposer_kind: string }>(
      sql`SELECT proposer_kind FROM proposals WHERE id = ${proposalId}`,
    );
    expect(row?.proposer_kind).toBe('agent');
  });

  it('REFUSES an agent proposal whose proposer_user_id is a HUMAN — the id the CHECK cannot cross to', async () => {
    // The exact gauntlet finding: proposer_kind='agent' with a person's uuid. The
    // CHECK passes (NOT NULL); the trigger reads users.principal_kind and refuses.
    const r = await seedProposerRoom('dishonest');
    await violatesConstraint('proposals_agent_proposer_is_agent', () =>
      stageProposal({
        roomId: r.roomId,
        proposalId: randomUUID(),
        proposerKind: 'agent',
        proposerUserId: r.humanId,
      }),
    );
  });

  it('REFUSES re-attributing an agent proposal onto a human by UPDATE (the trigger fires on UPDATE too)', async () => {
    // A regression to `BEFORE INSERT` alone would leave this green. Stage an honest
    // agent proposal, then swing its proposer_user_id to the human — dishonest
    // attribution introduced one act later, refused by the same trigger.
    const r = await seedProposerRoom('mutate');
    const proposalId = randomUUID();
    await stageProposal({
      roomId: r.roomId,
      proposalId,
      proposerKind: 'agent',
      proposerUserId: r.agentId,
    });
    await violatesConstraint('proposals_agent_proposer_is_agent', () =>
      handle.db.execute(
        sql`UPDATE proposals SET proposer_user_id = ${r.humanId} WHERE id = ${proposalId}`,
      ),
    );
  });

  it('LEAVES the human arm alone — a human proposer naming a human is untouched by the agent trigger', async () => {
    // The control that keeps the trigger honest: it guards the agent arm only, so
    // the ordinary human-staged reading the rest of the system rests on is fine.
    const r = await seedProposerRoom('control');
    const proposalId = randomUUID();
    await stageProposal({
      roomId: r.roomId,
      proposalId,
      proposerKind: 'human',
      proposerUserId: r.humanId,
    });
    const [row] = await handle.db.execute<{ proposer_kind: string }>(
      sql`SELECT proposer_kind FROM proposals WHERE id = ${proposalId}`,
    );
    expect(row?.proposer_kind).toBe('human');
  });
});

/**
 * A PLAN SETTLES ONLY AFTER ITS CHILDREN, AS A TABLE FACT (#119, drizzle/0031).
 *
 * The mirror of 0025's F-A: F-A froze a settled plan so a session cannot open
 * under it; this refuses settling a plan while a child session is still `open`.
 * The command path already enforces it (projectPlanSettled reads the children
 * `FOR SHARE` and throws on an open child) — but that is one writer's predicate,
 * not the table's. Raw SQL — `UPDATE plans SET status='settled'` with a live
 * child — would slip through and leave a receipt that indexes a child receipt
 * not yet written. This drives the trigger through raw SQL so a refusal surfaces
 * the *named* trigger; drop it from 0031 and exactly the open-child settle below
 * goes green (the plan closes over a running child), while the no-child and
 * all-children-exited controls are untouched.
 */
describe('a plan settles only after its children exit, at the table (#119)', () => {
  /** A plan with one child session in the given exit state (or left open). */
  async function planWithChild(childStatus: 'open' | 'settled' | 'failed') {
    const ch = await seedAgentChannel('fleet');
    const planId = await insertPlan(ch.roomId, ch.agentId);
    const sessionId = randomUUID();
    await handle.db.execute(sql`
      INSERT INTO sessions (id, room_id, plan_id, harness, model)
      VALUES (${sessionId}, ${ch.roomId}, ${planId}, 'claude', 'opus')
    `);
    if (childStatus !== 'open') {
      // OLD is `open`, so 0025's terminal freeze does not fire — the child takes
      // its one legal exit, exactly as projectSessionExit's UPDATE would.
      await handle.db.execute(
        sql`UPDATE sessions SET status = ${childStatus}, exit_summary = 'done' WHERE id = ${sessionId}`,
      );
    }
    return { roomId: ch.roomId, planId, sessionId };
  }

  it('REFUSES settling a plan while a child session is still open, and leaves it open', async () => {
    const { planId } = await planWithChild('open');
    await violatesConstraint('plans_settle_needs_children_exited', () =>
      handle.db.execute(sql`UPDATE plans SET status = 'settled' WHERE id = ${planId}`),
    );
    // The settle was refused, not silently applied: the plan is still open.
    const [row] = await handle.db.execute<{ status: string }>(
      sql`SELECT status FROM plans WHERE id = ${planId}`,
    );
    expect(row?.status).toBe('open');
  });

  it('ALLOWS settling a plan with NO sessions — the EXISTS finds no open child', async () => {
    const ch = await seedAgentChannel('fleet');
    const planId = await insertPlan(ch.roomId, ch.agentId);
    await handle.db.execute(sql`UPDATE plans SET status = 'settled' WHERE id = ${planId}`);
    const [row] = await handle.db.execute<{ status: string }>(
      sql`SELECT status FROM plans WHERE id = ${planId}`,
    );
    expect(row?.status).toBe('settled');
  });

  for (const childStatus of ['settled', 'failed'] as const) {
    it(`ALLOWS settling a plan whose child is ${childStatus} — an exited child does not block`, async () => {
      const { planId } = await planWithChild(childStatus);
      await handle.db.execute(sql`UPDATE plans SET status = 'settled' WHERE id = ${planId}`);
      const [row] = await handle.db.execute<{ status: string }>(
        sql`SELECT status FROM plans WHERE id = ${planId}`,
      );
      expect(row?.status).toBe('settled');
    });
  }

  it('ALLOWS an updated_at touch on a plan with an open child — the trigger fires only on the settle transition', async () => {
    // The control that keeps the trigger narrow: it must refuse the open → settled
    // transition, not every write to a plan that has a live child.
    const { planId } = await planWithChild('open');
    await handle.db.execute(sql`UPDATE plans SET updated_at = now() WHERE id = ${planId}`);
    const [row] = await handle.db.execute<{ status: string }>(
      sql`SELECT status FROM plans WHERE id = ${planId}`,
    );
    expect(row?.status).toBe('open');
  });
});
