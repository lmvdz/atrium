import { randomUUID } from 'node:crypto';
import { provisionAgentConfig } from '@atrium/auth';
import { memberships, plans, sessions } from '@atrium/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CERTIFY_ARM_TTL_MS, CERTIFY_REQUIRED_HOLD_MS } from '../../apps/web/lib/certify-hold.js';
import { armCertification, certifySession } from '../../apps/web/lib/certify-session.js';
import { openDatabase, resetDatabase, seedRoom } from '../support/harness.js';

/* ---------------------------------------------------------------------------
 * THE CERTIFY PATH, ON A REAL POSTGRES — #121 fix round, CS-2 and finding 6/7.
 *
 * The blind gauntlet found three things a unit test could not have seen, because
 * all three are properties of the SERVER path and the TABLE rather than of a
 * component:
 *
 *   * the hold was a number the CLIENT sent. `heldMs: 0` certified. So did
 *     `heldMs: 999999` from something that had never rendered the control.
 *   * membership was resolved by the caller and never re-read, so a person
 *     removed from the room between the read and the write still certified.
 *   * nothing froze a certification once made — `SET certified_by = NULL`
 *     un-landed it.
 *
 * Every case below is written so that REVERTING the guard turns it red, and the
 * revert is named in the docblock. That is the acceptance bar these exist to
 * meet: a guard whose test still passes without it is decoration.
 *
 * The DB triggers are exercised here too rather than only reasoned about — the
 * #19 finding this whole suite answers is that a constraint present in a string
 * and absent from the database reports exactly like one that works.
 * ------------------------------------------------------------------------- */

const handle = openDatabase();

beforeEach(async () => resetDatabase(handle));
afterAll(async () => handle.close());

interface Fixture {
  roomId: string;
  ada: string;
  bob: string;
  hexi: string;
  sessionId: string;
  openSessionId: string;
}

/** A room, a person, a second person, an AGENT, and a settled session to certify. */
async function fixture(): Promise<Fixture> {
  const room = await seedRoom(handle, ['ada', 'bob', 'hexi'], { agents: ['hexi'] });
  const ada = room.people.ada as string;
  const bob = room.people.bob as string;
  const hexi = room.people.hexi as string;

  /* The plan lives in the agent's CHANNEL — the `plans_room_matches_agent_channel`
     trigger (#116) refuses one otherwise, so the sidecar comes first. */
  await provisionAgentConfig({
    db: handle.db,
    userId: hexi,
    ownerUserId: ada,
    channelRoomId: room.roomId,
    host: 'fly-ord',
    harness: 'claude-code',
    model: 'opus',
    budgetLimitMicros: 20_000_000,
  });

  const planId = randomUUID();
  await handle.db.insert(plans).values({
    id: planId,
    roomId: room.roomId,
    agentUserId: hexi,
    title: 'the users migration',
    status: 'open',
  });

  const [settled] = await handle.db
    .insert(sessions)
    .values({
      roomId: room.roomId,
      planId,
      harness: 'claude-code',
      model: 'opus',
      status: 'settled',
      artifact: { branch: 'feat/x', commit: 'abc123' },
      exitSummary: 'done',
    })
    .returning({ id: sessions.id });

  const [running] = await handle.db
    .insert(sessions)
    .values({
      roomId: room.roomId,
      planId,
      harness: 'claude-code',
      model: 'sonnet',
      status: 'open',
    })
    .returning({ id: sessions.id });

  return {
    roomId: room.roomId,
    ada,
    bob,
    hexi,
    sessionId: (settled as { id: string }).id,
    openSessionId: (running as { id: string }).id,
  };
}

function read(sessionId: string) {
  return handle.db
    .select({
      certifiedBy: sessions.certifiedBy,
      certifiedAt: sessions.certifiedAt,
      certifiedHeldMs: sessions.certifiedHeldMs,
      armedBy: sessions.certifyArmedBy,
      armedAt: sessions.certifyArmedAt,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
}

/**
 * Run a write that must be REFUSED, and return the database's own words.
 *
 * `rejects.toThrow(/…/)` matches only the outermost message, and drizzle's is
 * always `Failed query: update "sessions" set …` — so a naive matcher passes on
 * ANY rejection, including a syntax error in the test's own SQL. Walking the
 * `cause` chain is what makes these assertions about the constraint that fired
 * rather than about the fact that something went wrong.
 */
async function refusal(write: Promise<unknown>): Promise<string> {
  try {
    await write;
  } catch (error) {
    const parts: string[] = [];
    let cursor: unknown = error;
    while (cursor instanceof Error) {
      parts.push(cursor.message);
      cursor = (cursor as { cause?: unknown }).cause;
    }
    return parts.join(' | ');
  }
  throw new Error('the write was accepted, and this case exists because it must not be');
}

/** Age the SERVER's arm stamp by `ms`, so a real hold need not be waited out. */
async function backdateArm(sessionId: string, ms: number): Promise<void> {
  await handle.db
    .update(sessions)
    .set({ certifyArmedAt: sql`now() - make_interval(secs => ${ms / 1000})` })
    .where(eq(sessions.id, sessionId));
}

describe('the SERVER refuses a non-human certifier', () => {
  /**
   * FINDING 7. The refusal is driven through the real server function with a real
   * AGENT principal — not asserted about a component's props.
   *
   * RED ON REVERT: delete the `parsePrincipalKind(...) !== 'human'` guard from
   * `viewerMayCertify`. The call then reaches the UPDATE, drizzle/0032's
   * `sessions_certified_by_is_human` trigger raises, and this test fails on the
   * thrown error instead of the refusal — red either way, which is the point:
   * with the guard the refusal is legible, without it the only thing standing
   * between an agent and the column is the table.
   */
  it('an agent principal is refused, and nothing reaches certified_by', async () => {
    const at = await fixture();
    const outcome = await certifySession({
      database: handle.db,
      viewerId: at.hexi,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
    });
    expect(outcome).toEqual({ ok: false, reason: 'not_human' });
    const [row] = await read(at.sessionId);
    expect(row?.certifiedBy).toBeNull();
  });

  it('an agent principal cannot even ARM — the hold is half of the human-only act', async () => {
    const at = await fixture();
    const outcome = await armCertification({
      database: handle.db,
      viewerId: at.hexi,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
    });
    expect(outcome).toEqual({ ok: false, reason: 'not_human' });
    const [row] = await read(at.sessionId);
    expect(row?.armedBy).toBeNull();
  });

  /* THE TABLE, not the function. Even with every application guard gone, the
     column cannot hold a machine's name. */
  it('the TABLE refuses an agent certifier written by raw SQL (drizzle/0032)', async () => {
    const at = await fixture();
    const why = await refusal(
      handle.db.update(sessions).set({ certifiedBy: at.hexi }).where(eq(sessions.id, at.sessionId)),
    );
    expect(why).toMatch(/certified only by a human|agent principal/i);
    const [row] = await read(at.sessionId);
    expect(row?.certifiedBy).toBeNull();
  });

  it('the TABLE refuses an agent ARMER written by raw SQL (drizzle/0033)', async () => {
    const at = await fixture();
    const why = await refusal(
      handle.db
        .update(sessions)
        .set({ certifyArmedBy: at.hexi })
        .where(eq(sessions.id, at.sessionId)),
    );
    expect(why).toMatch(/human-only act|armer/i);
  });
});

describe('the hold is measured by the server, and there is nothing to forge', () => {
  /**
   * CS-2, THE CENTRAL CASE. This is the request that used to certify: a confirm
   * with no prior arm. It could not carry a fake duration if it wanted to — the
   * input type has no timing field — and the server has nothing to subtract from.
   *
   * RED ON REVERT: restore the `armedAt`/`heldMs` parameters and write them
   * straight through (`certifiedHeldMs: Math.max(0, Math.round(heldMs))`). This
   * then returns `{ ok: true }` and the row lands, which is exactly what shipped.
   */
  it('a certify with NO prior arm is refused — nothing was held', async () => {
    const at = await fixture();
    const outcome = await certifySession({
      database: handle.db,
      viewerId: at.ada,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
    });
    expect(outcome).toEqual({ ok: false, reason: 'not_armed' });
    expect((await read(at.sessionId))[0]?.certifiedBy).toBeNull();
  });

  /**
   * RED ON REVERT: delete the `heldMs < CERTIFY_REQUIRED_HOLD_MS` branch. An
   * arm-then-immediately-confirm — a script, or a click — then certifies.
   */
  it('a certify IMMEDIATELY after the arm is refused — the interval is ~0ms', async () => {
    const at = await fixture();
    expect(
      await armCertification({
        database: handle.db,
        viewerId: at.ada,
        sessionId: at.sessionId,
        authorizedRoomId: at.roomId,
      }),
    ).toEqual({ ok: true });

    const outcome = await certifySession({
      database: handle.db,
      viewerId: at.ada,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
    });
    expect(outcome).toEqual({ ok: false, reason: 'held_too_short' });
    expect((await read(at.sessionId))[0]?.certifiedBy).toBeNull();
  });

  it('a hold past the gate certifies, and the recorded duration is the MEASURED one', async () => {
    const at = await fixture();
    await armCertification({
      database: handle.db,
      viewerId: at.ada,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
    });
    /* The arm stamp is the server's, so ageing it is the only way to make the
       server believe a hold happened — which is the property under test. */
    await backdateArm(at.sessionId, CERTIFY_REQUIRED_HOLD_MS + 500);

    expect(
      await certifySession({
        database: handle.db,
        viewerId: at.ada,
        sessionId: at.sessionId,
        authorizedRoomId: at.roomId,
      }),
    ).toEqual({ ok: true });

    const [row] = await read(at.sessionId);
    expect(row?.certifiedBy).toBe(at.ada);
    expect(row?.certifiedHeldMs ?? 0).toBeGreaterThanOrEqual(CERTIFY_REQUIRED_HOLD_MS);
    /* And it is a measurement, not a copy of anything a caller could have sent:
       it tracks the interval that was actually aged. */
    expect(row?.certifiedHeldMs ?? 0).toBeLessThan(CERTIFY_REQUIRED_HOLD_MS + 5_000);
    expect(row?.certifiedAt).not.toBeNull();
  });

  /**
   * ONE PERSON'S HOLD MAY NOT ARM A CONTROL ANOTHER CONFIRMS — otherwise the
   * signature names somebody who never pressed anything.
   *
   * RED ON REVERT: drop `session.armedBy !== viewerId` from the arm check.
   */
  it("a second person cannot confirm somebody else's arm", async () => {
    const at = await fixture();
    await armCertification({
      database: handle.db,
      viewerId: at.ada,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
    });
    await backdateArm(at.sessionId, CERTIFY_REQUIRED_HOLD_MS + 500);

    const outcome = await certifySession({
      database: handle.db,
      viewerId: at.bob,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
    });
    expect(outcome).toEqual({ ok: false, reason: 'not_armed' });
    expect((await read(at.sessionId))[0]?.certifiedBy).toBeNull();
  });

  /**
   * A PAGE ARMED AND ABANDONED IS NOT A HOLD. Without the TTL, a tab left open
   * overnight would report a nine-hour hold and sail past the gate.
   *
   * RED ON REVERT: delete the `heldMs > CERTIFY_ARM_TTL_MS` branch — the stale
   * arm then certifies, because it is very much longer than the required hold.
   */
  it('a STALE arm is refused, not rewarded for being old', async () => {
    const at = await fixture();
    await armCertification({
      database: handle.db,
      viewerId: at.ada,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
    });
    await backdateArm(at.sessionId, CERTIFY_ARM_TTL_MS + 60_000);

    const outcome = await certifySession({
      database: handle.db,
      viewerId: at.ada,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
    });
    expect(outcome).toEqual({ ok: false, reason: 'arm_expired' });
    expect((await read(at.sessionId))[0]?.certifiedBy).toBeNull();
  });

  it('a running session cannot be armed or certified at all', async () => {
    const at = await fixture();
    expect(
      await armCertification({
        database: handle.db,
        viewerId: at.ada,
        sessionId: at.openSessionId,
        authorizedRoomId: at.roomId,
      }),
    ).toEqual({ ok: false, reason: 'not_settled' });
    expect(
      await certifySession({
        database: handle.db,
        viewerId: at.ada,
        sessionId: at.openSessionId,
        authorizedRoomId: at.roomId,
      }),
    ).toEqual({ ok: false, reason: 'not_settled' });
  });
});

describe('the membership is re-derived in the write transaction', () => {
  /**
   * FINDING 6, THE TOCTOU. The caller's `loadRoom` has already run and said yes —
   * that is exactly the stale read being simulated. Between it and the write, the
   * membership is revoked; the write must not inherit the caller's answer.
   *
   * RED ON REVERT: remove the `loadRoomMembershipRow` call from
   * `viewerMayCertify`. The certification then lands, authored by somebody the
   * room had already removed.
   */
  it('a membership revoked after the caller resolved the room refuses the certify', async () => {
    const at = await fixture();
    await armCertification({
      database: handle.db,
      viewerId: at.ada,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
    });
    await backdateArm(at.sessionId, CERTIFY_REQUIRED_HOLD_MS + 500);

    // The revocation, landing between the caller's authorized read and the write.
    await handle.db
      .delete(memberships)
      .where(and(eq(memberships.roomId, at.roomId), eq(memberships.userId, at.ada)));

    const outcome = await certifySession({
      database: handle.db,
      viewerId: at.ada,
      // The caller's STALE answer, handed in exactly as the Server Action would.
      authorizedRoomId: at.roomId,
      sessionId: at.sessionId,
    });
    expect(outcome).toEqual({ ok: false, reason: 'not_in_room' });
    expect((await read(at.sessionId))[0]?.certifiedBy).toBeNull();
  });

  it('a session in another room is refused even with a valid membership here', async () => {
    const at = await fixture();
    const elsewhere = await seedRoom(handle, ['ada2']);
    const outcome = await certifySession({
      database: handle.db,
      viewerId: at.ada,
      sessionId: at.sessionId,
      authorizedRoomId: elsewhere.roomId,
    });
    // Not a member of `elsewhere`, so the membership re-read refuses first.
    expect(outcome).toEqual({ ok: false, reason: 'not_in_room' });
  });
});

describe('a certification is written once', () => {
  async function certify(at: Fixture): Promise<void> {
    await armCertification({
      database: handle.db,
      viewerId: at.ada,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
    });
    await backdateArm(at.sessionId, CERTIFY_REQUIRED_HOLD_MS + 500);
    expect(
      await certifySession({
        database: handle.db,
        viewerId: at.ada,
        sessionId: at.sessionId,
        authorizedRoomId: at.roomId,
      }),
    ).toEqual({ ok: true });
  }

  it('a second certify is refused by the application', async () => {
    const at = await fixture();
    await certify(at);
    await armCertification({
      database: handle.db,
      viewerId: at.bob,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
    });
    expect(
      await certifySession({
        database: handle.db,
        viewerId: at.bob,
        sessionId: at.sessionId,
        authorizedRoomId: at.roomId,
      }),
    ).toEqual({ ok: false, reason: 'already_certified' });
    expect((await read(at.sessionId))[0]?.certifiedBy).toBe(at.ada);
  });

  /**
   * THE CASE THE APPLICATION PREDICATE COULD NEVER SEE. `isNull(certified_by)`
   * guards the transition INTO certification; it says nothing about an UPDATE
   * that clears it back out, and clearing is how a landed session is un-landed.
   *
   * RED ON REVERT: drop the `sessions_certification_immutable` trigger from
   * drizzle/0033. All three of these UPDATEs then succeed.
   */
  it('the TABLE refuses a rewrite, a re-attribution and a clear (drizzle/0033)', async () => {
    const at = await fixture();
    await certify(at);

    // RE-ATTRIBUTION — somebody else's name over the signature that is there.
    expect(
      await refusal(
        handle.db
          .update(sessions)
          .set({ certifiedBy: at.bob })
          .where(eq(sessions.id, at.sessionId)),
      ),
    ).toMatch(/recorded once/i);

    // THE CLEAR — un-landing a landed session. The application's
    // `isNull(certified_by)` predicate never guarded this direction at all.
    expect(
      await refusal(
        handle.db.update(sessions).set({ certifiedBy: null }).where(eq(sessions.id, at.sessionId)),
      ),
    ).toMatch(/recorded once/i);

    // THE HELD DURATION — the evidence that it was a deliberate hold.
    expect(
      await refusal(
        handle.db
          .update(sessions)
          .set({ certifiedHeldMs: 999_999 })
          .where(eq(sessions.id, at.sessionId)),
      ),
    ).toMatch(/recorded once/i);

    // THE WHEN.
    expect(
      await refusal(
        handle.db
          .update(sessions)
          .set({ certifiedAt: new Date('2020-01-01T00:00:00.000Z') })
          .where(eq(sessions.id, at.sessionId)),
      ),
    ).toMatch(/recorded once/i);

    // And the arm behind it, which is what the held duration was measured from.
    expect(
      await refusal(
        handle.db
          .update(sessions)
          .set({ certifyArmedAt: new Date('2020-01-01T00:00:00.000Z') })
          .where(eq(sessions.id, at.sessionId)),
      ),
    ).toMatch(/may not be rewritten/i);

    const [row] = await read(at.sessionId);
    expect(row?.certifiedBy).toBe(at.ada);
    expect(row?.certifiedHeldMs).not.toBe(999_999);
  });

  /**
   * THE FREEZE IS ON THE CERTIFICATION, NOT ON THE SESSION — stated because a
   * trigger that froze the whole row would break the artifact write #120's
   * ExecutionProvider does at settle, and would do it silently.
   *
   * (`exit_summary` is not the column to prove it with: 0025 already freezes the
   * exit receipt on any terminal session, certified or not. `artifact` is
   * deliberately outside both freezes.)
   */
  it('an UNCERTIFIED row is not frozen, and a certified one still takes an artifact', async () => {
    const at = await fixture();
    await handle.db
      .update(sessions)
      .set({ artifact: { branch: 'feat/x', commit: 'beforecert' } })
      .where(eq(sessions.id, at.sessionId));

    await certify(at);

    await handle.db
      .update(sessions)
      .set({ artifact: { branch: 'feat/x', commit: 'aftercert' } })
      .where(eq(sessions.id, at.sessionId));
    expect((await read(at.sessionId))[0]?.certifiedBy).toBe(at.ada);
  });
});
