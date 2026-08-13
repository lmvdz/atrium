import { randomUUID } from 'node:crypto';
import { provisionAgentConfig } from '@atrium/auth';
import { memberships, plans, sessions } from '@atrium/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CERTIFY_ARM_TTL_MS, CERTIFY_REQUIRED_HOLD_MS } from '../../apps/web/lib/certify-hold.js';
import {
  armCertification,
  certifySession,
  disarmCertification,
} from '../../apps/web/lib/certify-session.js';
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
  workspaceId: string;
  ada: string;
  bob: string;
  hexi: string;
  planId: string;
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
    workspaceId: room.workspaceId,
    ada,
    bob,
    hexi,
    planId,
    sessionId: (settled as { id: string }).id,
    openSessionId: (running as { id: string }).id,
  };
}

/** A settled session with NO artifact — nothing for a signature to be a signature of. */
async function settledNoArtifact(at: Fixture): Promise<string> {
  const [row] = await handle.db
    .insert(sessions)
    .values({
      roomId: at.roomId,
      planId: at.planId,
      harness: 'omp',
      model: 'sonnet · audit',
      status: 'settled',
      exitSummary: 'read-only audit; nothing to land',
    })
    .returning({ id: sessions.id });
  return (row as { id: string }).id;
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

  /**
   * FINDING (round 3, fix 1) — THE WORKSPACE-MEMBERS LEG OF THE TOCTOU.
   *
   * `loadRoomMembershipRow` INNER-JOINs `workspace_members` (a room grants nothing
   * once the source-of-truth member row is gone), but on the append path it locks
   * only `memberships` — a workspace revocation that lands mid-write is tolerated,
   * caught by the next ~1s revalidation pass, because nothing an append writes is
   * irreversible. Certification IS irreversible (drizzle/0033). A member whose
   * WORKSPACE membership is revoked while the certify transaction is open must not
   * be able to slip inside that window and permanently land an artifact.
   *
   * The certify path therefore takes the stronger `membership-and-workspace` lock
   * (`FOR SHARE OF memberships, workspace_members`). This test drives the exact
   * interleaving that scope closes: a `workspace_members` DELETE held open by a
   * SECOND connection while certify runs. With the lock, certify's read waits on
   * that row; when the DELETE commits, the join returns nothing and certify
   * refuses `not_in_room`. Without it, certify reads the still-visible row under
   * MVCC and lands the certification before the revocation is even visible.
   *
   * RED ON REVERT: change the certify-path lock back to `'membership'` (or drop
   * the `of: [memberships, workspaceMembers]` scope). The certify then no longer
   * waits on the workspace-member row, reads it as present, and CERTIFIES —
   * authored by somebody the workspace had removed, on a write that can never be
   * undone. Both outputs are shown in the round-3 receipt.
   */
  it('a workspace_members revocation racing inside the write refuses the certify', async () => {
    const at = await fixture();
    await armCertification({
      database: handle.db,
      viewerId: at.ada,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
    });
    await backdateArm(at.sessionId, CERTIFY_REQUIRED_HOLD_MS + 500);

    /* A SECOND connection holds an uncommitted DELETE of ada's workspace-member
       row — the revocation, in flight, landing between the caller's authorized
       read and this write. A reserved connection pins one physical socket so the
       transaction stays open across the awaits below. */
    const reserved = await handle.sql.reserve();
    let outcome: Awaited<ReturnType<typeof certifySession>>;
    try {
      await reserved`BEGIN`;
      await reserved`DELETE FROM workspace_members
        WHERE organization_id = ${at.workspaceId} AND user_id = ${at.ada}`;

      /* Fire the certify WITHOUT awaiting. With the stronger lock its in-txn
         membership read takes `FOR SHARE` on the workspace-member row and BLOCKS
         on the uncommitted DELETE; without it, the read sees the still-visible
         row under MVCC and the certify runs straight through to a landing. */
      const pending = certifySession({
        database: handle.db,
        viewerId: at.ada,
        authorizedRoomId: at.roomId,
        sessionId: at.sessionId,
      });

      /* Give the un-locked (reverted) path time to certify and the locked path
         time to reach the wait, then commit the revocation. A locked certify now
         re-evaluates and finds the member row gone → `not_in_room`; a reverted
         certify has already resolved `{ ok: true }`. */
      await new Promise((resolve) => setTimeout(resolve, 400));
      await reserved`COMMIT`;
      outcome = await pending;
    } finally {
      await reserved.release();
    }

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
   * THE ARTIFACT IS FROZEN ONCE CERTIFIED (#121 CS-1) — but not before.
   *
   * The freeze is still on the CERTIFICATION, not on the whole session: an
   * uncertified row's artifact stays mutable, which is when #120's
   * ExecutionProvider writes it at settle. The change from the shipped build is
   * that once a human has signed, the artifact they signed cannot move underneath
   * the signature — the CS-1 hole that let a `✓` certified at artifact A stand
   * over an artifact B nobody reviewed. This replaces the old test, which asserted
   * the opposite ("a certified one still takes an artifact") and pinned the defect.
   *
   * RED ON REVERT: drop the `NEW.artifact IS DISTINCT FROM OLD.artifact` branch
   * from `atrium_sessions_certification_immutable` (drizzle/0034). The post-cert
   * UPDATE then succeeds and the `✓` floats free of what it signed.
   */
  it('an UNCERTIFIED row is not frozen; a certified one FREEZES its artifact (drizzle/0034)', async () => {
    const at = await fixture();
    // Before certification: the artifact is fully mutable.
    await handle.db
      .update(sessions)
      .set({ artifact: { branch: 'feat/x', commit: 'beforecert' } })
      .where(eq(sessions.id, at.sessionId));

    await certify(at);

    // After certification: the artifact the human signed cannot change.
    expect(
      await refusal(
        handle.db
          .update(sessions)
          .set({ artifact: { branch: 'feat/x', commit: 'aftercert' } })
          .where(eq(sessions.id, at.sessionId)),
      ),
    ).toMatch(/signed THIS artifact|may not change/i);
    const [row] = await read(at.sessionId);
    expect(row?.certifiedBy).toBe(at.ada);
    const artifactRows = await handle.db
      .select({ artifact: sessions.artifact })
      .from(sessions)
      .where(eq(sessions.id, at.sessionId));
    // The signed artifact still stands — the post-cert write did not land.
    expect((artifactRows[0]?.artifact as { commit?: string } | null)?.commit).toBe('beforecert');
  });
});

describe('a certification is bound to an artifact to sign (#121 CS-1)', () => {
  /**
   * NOTHING TO SIGN, NOTHING TO ARM. A settled session with no artifact has no
   * reviewable work; arming a hold over it would let a person hold a control
   * against nothing.
   *
   * RED ON REVERT: drop the `session.artifact === null` guard from
   * `armCertification`. The arm then lands on a session with nothing to certify.
   */
  it('arming a NULL-ARTIFACT session is refused', async () => {
    const at = await fixture();
    const sid = await settledNoArtifact(at);
    const outcome = await armCertification({
      database: handle.db,
      viewerId: at.ada,
      sessionId: sid,
      authorizedRoomId: at.roomId,
    });
    expect(outcome).toEqual({ ok: false, reason: 'no_artifact' });
    expect((await read(sid))[0]?.armedBy).toBeNull();
  });

  /**
   * And a confirm cannot slip past a missing artifact either — even if a raw arm
   * were forced onto the row, the confirm re-checks.
   *
   * RED ON REVERT: drop the `session.artifact === null` guard from
   * `certifySession`.
   */
  it('confirming a NULL-ARTIFACT session is refused, even with a forced arm', async () => {
    const at = await fixture();
    const sid = await settledNoArtifact(at);
    // Force a valid-looking, aged arm straight onto the row (the arm guard is
    // what we are bypassing, to prove the confirm guard stands on its own).
    await handle.db
      .update(sessions)
      .set({
        certifyArmedBy: at.ada,
        certifyArmedAt: sql`now() - make_interval(secs => ${(CERTIFY_REQUIRED_HOLD_MS + 500) / 1000})`,
      })
      .where(eq(sessions.id, sid));
    const outcome = await certifySession({
      database: handle.db,
      viewerId: at.ada,
      sessionId: sid,
      authorizedRoomId: at.roomId,
    });
    expect(outcome).toEqual({ ok: false, reason: 'no_artifact' });
    expect((await read(sid))[0]?.certifiedBy).toBeNull();
  });

  /**
   * THE TABLE, not the function: even with every application guard gone, a
   * certifier cannot be named over a null artifact.
   *
   * RED ON REVERT: drop `atrium_sessions_certify_needs_artifact` (drizzle/0034).
   */
  it('the TABLE refuses a certifier over a null artifact (drizzle/0034)', async () => {
    const at = await fixture();
    const sid = await settledNoArtifact(at);
    // A complete-looking receipt, but no artifact — the needs-artifact trigger is
    // what must catch it (arm first so the receipt-complete trigger is satisfied).
    await handle.db
      .update(sessions)
      .set({ certifyArmedBy: at.ada, certifyArmedAt: sql`now() - make_interval(secs => 3)` })
      .where(eq(sessions.id, sid));
    const why = await refusal(
      handle.db
        .update(sessions)
        .set({ certifiedBy: at.ada, certifiedAt: sql`now()`, certifiedHeldMs: 2400 })
        .where(eq(sessions.id, sid)),
    );
    expect(why).toMatch(/none to sign|null work|artifact/i);
    expect((await read(sid))[0]?.certifiedBy).toBeNull();
  });
});

describe('a `✓` requires a COMPLETE hold receipt at the table (#121 CS-2)', () => {
  /**
   * THE HOLE 0032/0033 LEFT. The humanity trigger accepts a human name; nothing
   * stopped `SET certified_by = <human>` on its own, arm and held-ms and stamp all
   * null. A render reading name + kind then mints `✓` from a certification with no
   * hold. The integration suite's own control-plane-data test used to WRITE exactly
   * this row and call it valid.
   *
   * RED ON REVERT: drop `atrium_sessions_certification_receipt_complete`
   * (drizzle/0035). This UPDATE — a human name, nothing else — then succeeds, which
   * is the exact false-`✓` shape the backstop closes.
   */
  it('the TABLE refuses a certified_by with no arm behind it (drizzle/0035)', async () => {
    const at = await fixture();
    const why = await refusal(
      handle.db.update(sessions).set({ certifiedBy: at.ada }).where(eq(sessions.id, at.sessionId)),
    );
    expect(why).toMatch(/no hold behind it|certify_armed_at is null/i);
    expect((await read(at.sessionId))[0]?.certifiedBy).toBeNull();
  });

  it('the TABLE refuses a certified_by whose held duration is under the gate', async () => {
    const at = await fixture();
    const why = await refusal(
      handle.db
        .update(sessions)
        .set({
          certifyArmedBy: at.ada,
          certifyArmedAt: sql`now() - make_interval(secs => 3)`,
          certifiedBy: at.ada,
          certifiedAt: sql`now()`,
          certifiedHeldMs: 10,
        })
        .where(eq(sessions.id, at.sessionId)),
    );
    expect(why).toMatch(/under the server hold gate|held/i);
    expect((await read(at.sessionId))[0]?.certifiedBy).toBeNull();
  });

  /* The complete receipt the app path writes still passes the backstop — the
     trigger refuses the incomplete row, not the honest one. */
  it('a complete receipt is accepted by the backstop', async () => {
    const at = await fixture();
    await handle.db
      .update(sessions)
      .set({ certifyArmedBy: at.ada, certifyArmedAt: sql`now() - make_interval(secs => 3)` })
      .where(eq(sessions.id, at.sessionId));
    await handle.db
      .update(sessions)
      .set({ certifiedBy: at.ada, certifiedAt: sql`now()`, certifiedHeldMs: 2400 })
      .where(eq(sessions.id, at.sessionId));
    expect((await read(at.sessionId))[0]?.certifiedBy).toBe(at.ada);
  });
});

describe('a cancelled hold leaves no live arm (#121 CS-3)', () => {
  /**
   * THE CS-3 CASE. Arm, release immediately (the browser cancel that used to be
   * local-only now calls disarm), wait past the gate, confirm directly. The arm is
   * gone, so the confirm has nothing to measure and is refused.
   *
   * RED ON REVERT: make `disarmCertification` a no-op (or stop the control from
   * calling it). The arm then survives the release for its whole TTL, and this
   * confirm — fired after the gate has elapsed — certifies, which is exactly the
   * CS-3 finding.
   */
  it('arm → disarm → (wait) → confirm is refused: the arm was consumed by the cancel', async () => {
    const at = await fixture();
    expect(
      await armCertification({
        database: handle.db,
        viewerId: at.ada,
        sessionId: at.sessionId,
        authorizedRoomId: at.roomId,
      }),
    ).toEqual({ ok: true });
    expect((await read(at.sessionId))[0]?.armedAt).not.toBeNull();

    // The release, now a server disarm rather than a local-only cancel.
    expect(
      await disarmCertification({
        database: handle.db,
        viewerId: at.ada,
        sessionId: at.sessionId,
        authorizedRoomId: at.roomId,
      }),
    ).toEqual({ ok: true });
    expect((await read(at.sessionId))[0]?.armedAt).toBeNull();
    expect((await read(at.sessionId))[0]?.armedBy).toBeNull();

    // Even after the gate would have elapsed, a direct confirm finds no arm.
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
   * SINGLE-USE. A completed certification consumes the arm — `certified_by` is set
   * and every write is scoped `isNull(certified_by)` — so a second confirm on the
   * same session is refused rather than spending the arm twice.
   */
  it('a second confirm on a consumed arm is refused (already certified)', async () => {
    const at = await fixture();
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

    // The same arm, spent, cannot land a second signature.
    const second = await certifySession({
      database: handle.db,
      viewerId: at.ada,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
    });
    expect(second).toEqual({ ok: false, reason: 'already_certified' });
  });

  /* A non-member cannot disarm somebody's arm — the same membership gate the arm
     and confirm take. Disarm is not a back door around it. */
  it('disarm refuses a viewer who is not in the room', async () => {
    const at = await fixture();
    const elsewhere = await seedRoom(handle, ['stranger']);
    const stranger = elsewhere.people.stranger as string;
    const outcome = await disarmCertification({
      database: handle.db,
      viewerId: stranger,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
    });
    expect(outcome).toEqual({ ok: false, reason: 'not_in_room' });
  });

  /**
   * THE CONSUMED NONCE. A successful confirm spends the arm's single-use attempt
   * id — it is cleared in the same statement that lands the signature, so the arm
   * is not only "already certified" but carries no live nonce a replay could reuse.
   */
  it('a successful confirm consumes the arm nonce (it is null on the certified row)', async () => {
    const at = await fixture();
    await armCertification({
      database: handle.db,
      viewerId: at.ada,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
    });
    // The arm minted a nonce.
    const [armed] = await handle.db
      .select({ nonce: sessions.certifyArmNonce })
      .from(sessions)
      .where(eq(sessions.id, at.sessionId));
    expect(armed?.nonce).not.toBeNull();

    await backdateArm(at.sessionId, CERTIFY_REQUIRED_HOLD_MS + 500);
    expect(
      await certifySession({
        database: handle.db,
        viewerId: at.ada,
        sessionId: at.sessionId,
        authorizedRoomId: at.roomId,
      }),
    ).toEqual({ ok: true });

    const [after] = await handle.db
      .select({ nonce: sessions.certifyArmNonce })
      .from(sessions)
      .where(eq(sessions.id, at.sessionId));
    expect(after?.nonce).toBeNull();
  });

  /**
   * A LEAKED OR FORGED ARM WITHOUT A LIVE NONCE IS NOT CONFIRMABLE (finding 5).
   *
   * Only `armCertification` mints a nonce. This forces a valid-LOOKING arm straight
   * onto the row — the right armer, an aged stamp past the gate, and even a matching
   * artifact digest so nothing else stands in the way — but no nonce, the shape a
   * disarmed/spent/forged arm has. The confirm honours only a live attempt.
   *
   * RED ON REVERT: drop `session.armNonce === null` from the arm check in
   * `certifySession`. With a matching digest and an aged stamp, this forged arm
   * then reaches the write and certifies — a confirm spending an arm no hold minted.
   */
  it('a forced arm carrying no nonce is refused, even aged and digest-matched', async () => {
    const at = await fixture();
    await handle.db
      .update(sessions)
      .set({
        certifyArmedBy: at.ada,
        certifyArmedAt: sql`now() - make_interval(secs => ${(CERTIFY_REQUIRED_HOLD_MS + 500) / 1000})`,
        // The digest of the artifact actually on the row, so the bind check passes
        // and only the missing nonce is left to stop the confirm.
        certifyArmedArtifactDigest: sql`md5(${sessions.artifact}::text)`,
        // certify_arm_nonce deliberately left NULL — this arm was not minted by the
        // one path that mints one.
      })
      .where(eq(sessions.id, at.sessionId));

    const outcome = await certifySession({
      database: handle.db,
      viewerId: at.ada,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
    });
    expect(outcome).toEqual({ ok: false, reason: 'not_armed' });
    expect((await read(at.sessionId))[0]?.certifiedBy).toBeNull();
  });
});

describe('a certification binds to the artifact reviewed (#121 round-5 finding 3)', () => {
  /**
   * RENDER A, CONFIRM B. The hold is armed over the artifact on screen; if it
   * changes before the confirm, the person is signing a revision they did not
   * review — and 0034 would then FREEZE that unreviewed revision under the `✓`.
   * The arm records a digest of what it was taken over; the confirm refuses if the
   * artifact moved underneath it.
   *
   * RED ON REVERT: drop the `session.artifactChanged` branch from `certifySession`
   * (and/or stop stamping `certify_armed_artifact_digest` at arm). The confirm then
   * certifies artifact B under a hold armed over artifact A.
   */
  it('mutating the artifact between arm and confirm refuses the confirm', async () => {
    const at = await fixture();
    await armCertification({
      database: handle.db,
      viewerId: at.ada,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
    });
    await backdateArm(at.sessionId, CERTIFY_REQUIRED_HOLD_MS + 500);

    // The artifact changes AFTER the hold was armed over the original — the
    // ExecutionProvider re-wrote it, a concurrent settle, a swap. The row is
    // uncertified, so 0034 does not yet freeze it; the digest bind is what catches
    // the change.
    await handle.db
      .update(sessions)
      .set({ artifact: { branch: 'feat/x', commit: 'switched-under-the-hold' } })
      .where(eq(sessions.id, at.sessionId));

    const outcome = await certifySession({
      database: handle.db,
      viewerId: at.ada,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
    });
    expect(outcome).toEqual({ ok: false, reason: 'artifact_changed' });
    expect((await read(at.sessionId))[0]?.certifiedBy).toBeNull();
  });

  /* THE CONTROL: an UNCHANGED artifact still certifies, so the bind refuses the
     mutation, not the honest confirm. */
  it('an unchanged artifact certifies through the bind', async () => {
    const at = await fixture();
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
    expect((await read(at.sessionId))[0]?.certifiedBy).toBe(at.ada);
  });
});

describe('the table refuses an internally inconsistent receipt (#121 round-5 finding 4, drizzle/0036)', () => {
  /**
   * THE FABRICATED COMPLETE RECEIPT. 0035 accepted a row that satisfied each of its
   * clauses individually — arm stamp present, certified_at present, held_ms ≥ gate —
   * while describing a hold that never happened: no armer, and a held_ms of 2000
   * across a ZERO interval between the arm and the signature.
   *
   * RED ON REVERT: drop the `sessions_certify_receipt_consistent` trigger
   * (drizzle/0036). Each of these raw writes then succeeds, which is the exact
   * fabricated `✓` the backstop closes.
   */
  it('refuses a certifier with no armer — the armer must be the certifier', async () => {
    const at = await fixture();
    const why = await refusal(
      handle.db
        .update(sessions)
        .set({
          // certify_armed_by left null: nobody armed it.
          certifyArmedAt: sql`now() - make_interval(secs => 3)`,
          certifiedBy: at.ada,
          certifiedAt: sql`now()`,
          certifiedHeldMs: 2400,
        })
        .where(eq(sessions.id, at.sessionId)),
    );
    expect(why).toMatch(/must be the same|nobody performed|armed the hold/i);
    expect((await read(at.sessionId))[0]?.certifiedBy).toBeNull();
  });

  it('refuses a held duration that does not match the arm→signature interval', async () => {
    const at = await fixture();
    // armer = certifier, but armed_at == certified_at (zero interval) while
    // held_ms claims 2000ms of hold.
    const why = await refusal(
      handle.db
        .update(sessions)
        .set({
          certifyArmedBy: at.ada,
          certifyArmedAt: sql`now()`,
          certifiedBy: at.ada,
          certifiedAt: sql`now()`,
          certifiedHeldMs: 2000,
        })
        .where(eq(sessions.id, at.sessionId)),
    );
    expect(why).toMatch(/interval|does not match|under the .*gate/i);
    expect((await read(at.sessionId))[0]?.certifiedBy).toBeNull();
  });

  it('refuses a certifier over a non-settled session (with an artifact to pass 0034)', async () => {
    const at = await fixture();
    // An OPEN session that nonetheless carries an artifact, so 0034's needs-artifact
    // trigger passes and the not-settled clause is what must fire.
    const [openRow] = await handle.db
      .insert(sessions)
      .values({
        roomId: at.roomId,
        planId: at.planId,
        harness: 'claude-code',
        model: 'opus',
        status: 'open',
        artifact: { branch: 'feat/x', commit: 'not-yet-settled' },
      })
      .returning({ id: sessions.id });
    const openId = (openRow as { id: string }).id;
    const why = await refusal(
      handle.db
        .update(sessions)
        .set({
          certifyArmedBy: at.ada,
          certifyArmedAt: sql`now() - make_interval(secs => 3)`,
          certifiedBy: at.ada,
          certifiedAt: sql`now()`,
          certifiedHeldMs: 2400,
        })
        .where(eq(sessions.id, openId)),
    );
    expect(why).toMatch(/status is open|only a settled|no landing/i);
    expect((await read(openId))[0]?.certifiedBy).toBeNull();
  });

  /* The honest receipt the app path writes — armer = certifier, settled, held_ms
     consistent with a real interval — still passes the backstop. */
  it('accepts a coherent receipt', async () => {
    const at = await fixture();
    await handle.db
      .update(sessions)
      .set({ certifyArmedBy: at.ada, certifyArmedAt: sql`now() - make_interval(secs => 3)` })
      .where(eq(sessions.id, at.sessionId));
    await handle.db
      .update(sessions)
      .set({ certifiedBy: at.ada, certifiedAt: sql`now()`, certifiedHeldMs: 2900 })
      .where(eq(sessions.id, at.sessionId));
    expect((await read(at.sessionId))[0]?.certifiedBy).toBe(at.ada);
  });
});
