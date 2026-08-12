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
