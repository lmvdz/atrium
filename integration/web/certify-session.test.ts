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
 * THE CERTIFY PATH, ON A REAL POSTGRES — #121 fix round, CS-2 and the later findings.
 *
 * The blind gauntlet found things a unit test could not have seen, because each is
 * a property of the SERVER path and the TABLE rather than of a component:
 *
 *   * the hold was a number the CLIENT sent. `heldMs: 0` certified. So did
 *     `heldMs: 999999` from something that had never rendered the control.
 *   * membership was resolved by the caller and never re-read, so a person
 *     removed from the room between the read and the write still certified.
 *   * nothing froze a certification once made — `SET certified_by = NULL`
 *     un-landed it.
 *   * (round 7) `reviewedDigest` was OPTIONAL and absent-means-unchanged, the
 *     cancel watermark was a CLIENT wall-clock any member could jam, the arm stamp
 *     was `now()` (transaction-start) so a blocked arm backdated itself, and a
 *     cancellation was refused the moment the owner lost membership.
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

/** A settled session carrying a given artifact (used for the empty/partial cases). */
async function settledWithArtifact(at: Fixture, artifact: unknown): Promise<string> {
  const [row] = await handle.db
    .insert(sessions)
    .values({
      roomId: at.roomId,
      planId: at.planId,
      harness: 'claude-code',
      model: 'opus',
      status: 'settled',
      // biome-ignore lint/suspicious/noExplicitAny: the point is to seed a malformed artifact shape.
      artifact: artifact as any,
      exitSummary: 'done',
    })
    .returning({ id: sessions.id });
  return (row as { id: string }).id;
}

/** The server's own `md5(artifact::text)` for a session — the reviewed digest the render carries. */
async function digestOf(sessionId: string): Promise<string | null> {
  const [row] = await handle.db
    .select({ digest: sql<string | null>`md5(${sessions.artifact}::text)` })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return (row as { digest: string | null } | undefined)?.digest ?? null;
}

/**
 * Arm through the REAL function, with the row's current reviewed digest.
 *
 * `reviewedDigest` is REQUIRED now (round-7 finding 1): there is no
 * absent-means-unchanged branch, so a raw caller computes it exactly as the render
 * would. Defaults to the digest of the artifact on the row (the honest attestation);
 * pass one explicitly to drive the stale-review case. Returns the whole outcome so a
 * caller can assert on it AND read back the server-issued token.
 */
async function arm(params: {
  sessionId: string;
  viewerId: string;
  roomId: string;
  reviewedDigest?: string | null;
}): Promise<Awaited<ReturnType<typeof armCertification>>> {
  const reviewedDigest =
    params.reviewedDigest !== undefined ? params.reviewedDigest : await digestOf(params.sessionId);
  return armCertification({
    database: handle.db,
    viewerId: params.viewerId,
    sessionId: params.sessionId,
    authorizedRoomId: params.roomId,
    // Empty string when the row has no digest (a null/empty artifact): the arm
    // refuses `no_artifact` before it ever compares the digest, so the value is
    // moot there and the type stays a plain string.
    reviewedDigest: reviewedDigest ?? '',
  });
}

/** Arm and assert it landed; return the server-issued attempt token. */
async function armOk(params: {
  sessionId: string;
  viewerId: string;
  roomId: string;
  reviewedDigest?: string | null;
}): Promise<string> {
  const outcome = await arm(params);
  if (!outcome.ok) throw new Error(`the arm was refused (${outcome.reason}) and the case needs it`);
  return outcome.attemptToken;
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
      // A well-formed token is required now (round-8); it is refused not_human long
      // before the attempt check, so a throwaway is the honest input here.
      attemptToken: randomUUID(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'not_human' });
    const [row] = await read(at.sessionId);
    expect(row?.certifiedBy).toBeNull();
  });

  it('an agent principal cannot even ARM — the hold is half of the human-only act', async () => {
    const at = await fixture();
    const outcome = await arm({ viewerId: at.hexi, sessionId: at.sessionId, roomId: at.roomId });
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
      // A well-formed token, but no arm was ever taken: refused not_armed.
      attemptToken: randomUUID(),
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
    const token = await armOk({ viewerId: at.ada, sessionId: at.sessionId, roomId: at.roomId });

    const outcome = await certifySession({
      database: handle.db,
      viewerId: at.ada,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
      attemptToken: token,
    });
    expect(outcome).toEqual({ ok: false, reason: 'held_too_short' });
    expect((await read(at.sessionId))[0]?.certifiedBy).toBeNull();
  });

  it('a hold past the gate certifies, and the recorded duration is the MEASURED one', async () => {
    const at = await fixture();
    const token = await armOk({ viewerId: at.ada, sessionId: at.sessionId, roomId: at.roomId });
    /* The arm stamp is the server's, so ageing it is the only way to make the
       server believe a hold happened — which is the property under test. */
    await backdateArm(at.sessionId, CERTIFY_REQUIRED_HOLD_MS + 500);

    expect(
      await certifySession({
        database: handle.db,
        viewerId: at.ada,
        sessionId: at.sessionId,
        authorizedRoomId: at.roomId,
        attemptToken: token,
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
    const token = await armOk({ viewerId: at.ada, sessionId: at.sessionId, roomId: at.roomId });
    await backdateArm(at.sessionId, CERTIFY_REQUIRED_HOLD_MS + 500);

    const outcome = await certifySession({
      database: handle.db,
      viewerId: at.bob,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
      // Bob even presents ADA's token — the arm is still not his, so not_armed.
      attemptToken: token,
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
    const token = await armOk({ viewerId: at.ada, sessionId: at.sessionId, roomId: at.roomId });
    await backdateArm(at.sessionId, CERTIFY_ARM_TTL_MS + 60_000);

    const outcome = await certifySession({
      database: handle.db,
      viewerId: at.ada,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
      attemptToken: token,
    });
    expect(outcome).toEqual({ ok: false, reason: 'arm_expired' });
    expect((await read(at.sessionId))[0]?.certifiedBy).toBeNull();
  });

  it('a running session cannot be armed or certified at all', async () => {
    const at = await fixture();
    expect(await arm({ viewerId: at.ada, sessionId: at.openSessionId, roomId: at.roomId })).toEqual(
      { ok: false, reason: 'not_settled' },
    );
    expect(
      await certifySession({
        database: handle.db,
        viewerId: at.ada,
        sessionId: at.openSessionId,
        authorizedRoomId: at.roomId,
        attemptToken: randomUUID(),
      }),
    ).toEqual({ ok: false, reason: 'not_settled' });
  });
});

describe('the arm stamp is the real clock, not the transaction start (#121 round-7 finding 3)', () => {
  /**
   * THE BACKDATE-BY-BLOCKING HOLE. The arm used to stamp `certify_armed_at = now()`,
   * which is the TRANSACTION-START time. If the arm's `SELECT … FOR UPDATE` blocked
   * on the row lock for longer than the gate, `now()` was already that far in the
   * past when the stamp finally wrote — so an immediate confirm measured a hold that
   * never happened and certified. `clock_timestamp()` is evaluated when the UPDATE
   * runs, after the lock is acquired, so the interval is measured from the real
   * moment the arm landed.
   *
   * This drives the exact interleaving: a second connection holds the session row's
   * lock while the arm blocks on it for longer than the gate; when it releases, the
   * arm stamps and we confirm at once. With `clock_timestamp()` the measured hold is
   * ~0ms → `held_too_short`. With `now()` it is the whole block → it certifies.
   *
   * RED ON REVERT: change the arm's stamp back to `certifyArmedAt: sql\`now()\``.
   * The arm then backdates itself to its blocked transaction's start, and this
   * immediate confirm reads a >2s hold and certifies.
   */
  it('an arm blocked past the gate, then stamped, cannot immediately confirm', async () => {
    const at = await fixture();

    /* A SECOND connection pins the session row with an uncommitted `FOR UPDATE`, so
       the arm's own `SELECT … FOR UPDATE` blocks behind it. A reserved connection
       keeps one physical socket across the awaits. */
    const reserved = await handle.sql.reserve();
    let armed: Awaited<ReturnType<typeof armCertification>>;
    try {
      await reserved`BEGIN`;
      await reserved`SELECT id FROM sessions WHERE id = ${at.sessionId} FOR UPDATE`;

      /* Fire the arm WITHOUT awaiting: its transaction opens now (fixing `now()` to
         ~T0), then it blocks on the row lock the reserved connection holds. */
      const pending = arm({ viewerId: at.ada, sessionId: at.sessionId, roomId: at.roomId });

      /* Hold the lock well past the gate, so a reverted arm's `now()` is more than
         the required hold in the past by the time it finally stamps. */
      await new Promise((resolve) => setTimeout(resolve, CERTIFY_REQUIRED_HOLD_MS + 800));
      await reserved`COMMIT`;
      armed = await pending;
    } finally {
      await reserved.release();
    }
    if (!armed.ok) throw new Error(`the arm was refused (${armed.reason}) and the case needs it`);

    /* Immediately confirm. With `clock_timestamp()` the arm stamped just now, so the
       measured interval is ~0ms and this is refused; with `now()` the stamp is >2s
       old and this certifies. */
    const outcome = await certifySession({
      database: handle.db,
      viewerId: at.ada,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
      attemptToken: armed.attemptToken,
    });
    expect(outcome).toEqual({ ok: false, reason: 'held_too_short' });
    expect((await read(at.sessionId))[0]?.certifiedBy).toBeNull();
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
    const token = await armOk({ viewerId: at.ada, sessionId: at.sessionId, roomId: at.roomId });
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
      // A live, valid token — the membership re-read still refuses first.
      attemptToken: token,
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
    const token = await armOk({ viewerId: at.ada, sessionId: at.sessionId, roomId: at.roomId });
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
        attemptToken: token,
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
      attemptToken: randomUUID(),
    });
    // Not a member of `elsewhere`, so the membership re-read refuses first.
    expect(outcome).toEqual({ ok: false, reason: 'not_in_room' });
  });
});

describe('a certification is written once', () => {
  async function certify(at: Fixture): Promise<void> {
    const token = await armOk({ viewerId: at.ada, sessionId: at.sessionId, roomId: at.roomId });
    await backdateArm(at.sessionId, CERTIFY_REQUIRED_HOLD_MS + 500);
    expect(
      await certifySession({
        database: handle.db,
        viewerId: at.ada,
        sessionId: at.sessionId,
        authorizedRoomId: at.roomId,
        attemptToken: token,
      }),
    ).toEqual({ ok: true });
  }

  it('a second certify is refused by the application', async () => {
    const at = await fixture();
    await certify(at);
    await arm({ viewerId: at.bob, sessionId: at.sessionId, roomId: at.roomId });
    expect(
      await certifySession({
        database: handle.db,
        viewerId: at.bob,
        sessionId: at.sessionId,
        authorizedRoomId: at.roomId,
        attemptToken: randomUUID(),
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
   * RED ON REVERT: drop the `!isReviewableArtifact(session.artifact)` guard from
   * `armCertification`. The arm then lands on a session with nothing to certify.
   */
  it('arming a NULL-ARTIFACT session is refused', async () => {
    const at = await fixture();
    const sid = await settledNoArtifact(at);
    const outcome = await arm({ viewerId: at.ada, sessionId: sid, roomId: at.roomId });
    expect(outcome).toEqual({ ok: false, reason: 'no_artifact' });
    expect((await read(sid))[0]?.armedBy).toBeNull();
  });

  /**
   * And a confirm cannot slip past a missing artifact either — even if a raw arm
   * were forced onto the row, the confirm re-checks.
   *
   * RED ON REVERT: drop the `!isReviewableArtifact(session.artifact)` guard from
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
      attemptToken: randomUUID(),
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
    const token = await armOk({ viewerId: at.ada, sessionId: at.sessionId, roomId: at.roomId });
    expect((await read(at.sessionId))[0]?.armedAt).not.toBeNull();

    // The release, now a server disarm rather than a local-only cancel — carrying
    // the server-issued token so it cancels exactly this attempt.
    expect(
      await disarmCertification({
        database: handle.db,
        viewerId: at.ada,
        sessionId: at.sessionId,
        attemptToken: token,
      }),
    ).toEqual({ ok: true });
    expect((await read(at.sessionId))[0]?.armedAt).toBeNull();
    expect((await read(at.sessionId))[0]?.armedBy).toBeNull();

    // Even after the gate would have elapsed, a direct confirm finds no arm — even
    // carrying the released press's token, whose nonce the disarm cleared.
    const outcome = await certifySession({
      database: handle.db,
      viewerId: at.ada,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
      attemptToken: token,
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
    const token = await armOk({ viewerId: at.ada, sessionId: at.sessionId, roomId: at.roomId });
    await backdateArm(at.sessionId, CERTIFY_REQUIRED_HOLD_MS + 500);
    expect(
      await certifySession({
        database: handle.db,
        viewerId: at.ada,
        sessionId: at.sessionId,
        authorizedRoomId: at.roomId,
        attemptToken: token,
      }),
    ).toEqual({ ok: true });

    // The same arm, spent, cannot land a second signature.
    const second = await certifySession({
      database: handle.db,
      viewerId: at.ada,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
      attemptToken: token,
    });
    expect(second).toEqual({ ok: false, reason: 'already_certified' });
  });

  /**
   * THE CONSUMED NONCE. A successful confirm spends the arm's single-use attempt
   * id — it is cleared in the same statement that lands the signature, so the arm
   * is not only "already certified" but carries no live nonce a replay could reuse.
   */
  it('a successful confirm consumes the arm nonce (it is null on the certified row)', async () => {
    const at = await fixture();
    const token = await armOk({ viewerId: at.ada, sessionId: at.sessionId, roomId: at.roomId });
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
        attemptToken: token,
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
      // Any well-formed token: the forced arm carries no live nonce to match.
      attemptToken: randomUUID(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'not_armed' });
    expect((await read(at.sessionId))[0]?.certifiedBy).toBeNull();
  });
});

describe('the disarm authorizes on arm-ownership, not membership (#121 round-7 finding 4)', () => {
  /**
   * ARM → LOSE MEMBERSHIP → RELEASE STILL CLEARS THE ARM. The round-6 disarm ran the
   * same membership gate as the confirm, so a person who armed as a member and then
   * lost membership got `not_in_room` on release — the arm stayed live, and a
   * confirm after regaining membership within the TTL spent the cancelled hold.
   * Retracting your OWN pending intention is not an act on the room; the owner may
   * always cancel their own.
   *
   * RED ON REVERT: put the `viewerMayCertify` membership gate back at the top of
   * `disarmCertification`. The disarm below then refuses `not_in_room`, the arm
   * survives, and the later confirm (once membership is back) spends it.
   */
  it('arm → lose membership → disarm clears the arm; a later confirm cannot spend it', async () => {
    const at = await fixture();
    const token = await armOk({ viewerId: at.ada, sessionId: at.sessionId, roomId: at.roomId });
    await backdateArm(at.sessionId, CERTIFY_REQUIRED_HOLD_MS + 500);

    // Ada is removed from the room AFTER arming, BEFORE releasing.
    await handle.db
      .delete(memberships)
      .where(and(eq(memberships.roomId, at.roomId), eq(memberships.userId, at.ada)));

    // The release still clears the arm — ownership authorizes it, membership does not.
    expect(
      await disarmCertification({
        database: handle.db,
        viewerId: at.ada,
        sessionId: at.sessionId,
        attemptToken: token,
      }),
    ).toEqual({ ok: true });
    expect((await read(at.sessionId))[0]?.armedBy).toBeNull();
    expect((await read(at.sessionId))[0]?.armedAt).toBeNull();

    // Membership comes back (a re-invite) — but the arm is gone, so there is
    // nothing for a direct confirm to spend.
    await handle.db
      .insert(memberships)
      .values({ roomId: at.roomId, userId: at.ada, role: 'member' });
    const outcome = await certifySession({
      database: handle.db,
      viewerId: at.ada,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
      // The released press's token — its arm was cleared by the disarm, so not_armed.
      attemptToken: token,
    });
    expect(outcome).toEqual({ ok: false, reason: 'not_armed' });
    expect((await read(at.sessionId))[0]?.certifiedBy).toBeNull();
  });

  /**
   * OWNERSHIP IS THE SCOPE — a disarm cannot reach SOMEBODY ELSE'S arm. The disarm
   * clears only where `certify_armed_by = viewerId`, so a second person's release
   * (even a stranger's, and even carrying the token) leaves the owner's arm holding.
   *
   * RED ON REVERT: drop the `eq(sessions.certifyArmedBy, viewerId)` scope from the
   * disarm's clear. Bob's disarm then wipes Ada's live arm, and her held hold is
   * cancelled out from under her.
   */
  it("one viewer's disarm cannot clear another viewer's arm", async () => {
    const at = await fixture();
    const token = await armOk({ viewerId: at.ada, sessionId: at.sessionId, roomId: at.roomId });

    // Bob releases — but he owns no arm on this session, so nothing is cleared,
    // even though he presents the token.
    expect(
      await disarmCertification({
        database: handle.db,
        viewerId: at.bob,
        sessionId: at.sessionId,
        attemptToken: token,
      }),
    ).toEqual({ ok: true });
    // Ada's arm still stands.
    expect((await read(at.sessionId))[0]?.armedBy).toBe(at.ada);

    // …and Ada can still carry it through to a signature past the gate.
    await backdateArm(at.sessionId, CERTIFY_REQUIRED_HOLD_MS + 500);
    expect(
      await certifySession({
        database: handle.db,
        viewerId: at.ada,
        sessionId: at.sessionId,
        authorizedRoomId: at.roomId,
        attemptToken: token,
      }),
    ).toEqual({ ok: true });
    expect((await read(at.sessionId))[0]?.certifiedBy).toBe(at.ada);
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
    const token = await armOk({ viewerId: at.ada, sessionId: at.sessionId, roomId: at.roomId });
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
      attemptToken: token,
    });
    expect(outcome).toEqual({ ok: false, reason: 'artifact_changed' });
    expect((await read(at.sessionId))[0]?.certifiedBy).toBeNull();
  });

  /* THE CONTROL: an UNCHANGED artifact still certifies, so the bind refuses the
     mutation, not the honest confirm. */
  it('an unchanged artifact certifies through the bind', async () => {
    const at = await fixture();
    const token = await armOk({ viewerId: at.ada, sessionId: at.sessionId, roomId: at.roomId });
    await backdateArm(at.sessionId, CERTIFY_REQUIRED_HOLD_MS + 500);
    expect(
      await certifySession({
        database: handle.db,
        viewerId: at.ada,
        sessionId: at.sessionId,
        authorizedRoomId: at.roomId,
        attemptToken: token,
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

describe('the arm binds to the artifact the human REVIEWED (#121 round-6 finding 1)', () => {
  /**
   * RENDER A, ARM B. The round-5 fix bound the confirm to the ARM-time artifact,
   * not the reviewed one: between the render the human saw and the moment the arm
   * locked the row, the still-mutable artifact could change, and the arm would
   * digest the NEW revision — so a confirm certified work the pane never showed.
   * The render now carries `md5(artifact::text)`; the arm refuses if the artifact
   * moved since.
   *
   * RED ON REVERT: drop the `session.reviewedChanged` branch from `armCertification`.
   * The arm over the mutated artifact then lands, and the reviewed-revision bind is
   * gone one step earlier than the confirm's.
   */
  it('mutating the artifact between render and arm refuses the arm (stale_review)', async () => {
    const at = await fixture();
    // The digest the render carried — captured before the artifact moves.
    const reviewedDigest = await digestOf(at.sessionId);

    // The artifact changes AFTER the person reviewed it but BEFORE they press hold.
    await handle.db
      .update(sessions)
      .set({ artifact: { branch: 'feat/x', commit: 'changed-since-review' } })
      .where(eq(sessions.id, at.sessionId));

    const outcome = await arm({
      viewerId: at.ada,
      sessionId: at.sessionId,
      roomId: at.roomId,
      reviewedDigest,
    });
    expect(outcome).toEqual({ ok: false, reason: 'stale_review' });
    expect((await read(at.sessionId))[0]?.armedBy).toBeNull();
  });

  /**
   * THE FAIL-OPEN THAT SHIPPED (round-7 finding 1). Round 6 treated an ABSENT
   * `reviewedDigest` as "unchanged" and skipped the check, so a scripted caller that
   * simply omitted it armed over whatever was current — binding a signature to work
   * it never rendered. `reviewedDigest` is REQUIRED now; there is no absent branch.
   * A caller that attests the WRONG digest (as an omission once silently did) is
   * refused `stale_review`.
   *
   * RED ON REVERT: make `reviewedDigest` optional again and skip the compare when it
   * is undefined/null. An arm attesting a mismatched (or no) digest then lands over
   * the current artifact.
   */
  it('an arm attesting the wrong digest is refused — there is no absent-means-unchanged', async () => {
    const at = await fixture();
    const outcome = await arm({
      viewerId: at.ada,
      sessionId: at.sessionId,
      roomId: at.roomId,
      // A digest that is not the row's — the shape an omission used to fall open to.
      reviewedDigest: 'ffffffffffffffffffffffffffffffff',
    });
    expect(outcome).toEqual({ ok: false, reason: 'stale_review' });
    expect((await read(at.sessionId))[0]?.armedBy).toBeNull();
  });

  /* THE CONTROL: an unchanged artifact — the reviewed digest still matches — arms. */
  it('arming with the reviewed digest of the current artifact succeeds', async () => {
    const at = await fixture();
    const reviewedDigest = await digestOf(at.sessionId);
    const outcome = await arm({
      viewerId: at.ada,
      sessionId: at.sessionId,
      roomId: at.roomId,
      reviewedDigest,
    });
    expect(outcome.ok).toBe(true);
    expect((await read(at.sessionId))[0]?.armedBy).toBe(at.ada);
  });
});

describe('a certification needs a REVIEWABLE artifact (#121 round-6 finding 2)', () => {
  /**
   * AN EMPTY `{}` IS NOT REVIEWABLE. `SessionArtifact` has every field optional, so
   * `{}` is non-null JSONB the round-5 null-checks accepted — a signature on a blank
   * page. Arm and confirm now require a non-empty branch AND commit.
   *
   * RED ON REVERT: restore `session.artifact === null` (from `!isReviewableArtifact`)
   * in `armCertification`. The arm over `{}` then lands.
   */
  it('arming an EMPTY {} artifact is refused', async () => {
    const at = await fixture();
    const sid = await settledWithArtifact(at, {});
    const outcome = await arm({ viewerId: at.ada, sessionId: sid, roomId: at.roomId });
    expect(outcome).toEqual({ ok: false, reason: 'no_artifact' });
    expect((await read(sid))[0]?.armedBy).toBeNull();
  });

  it('arming a PARTIAL artifact (branch only, no commit) is refused', async () => {
    const at = await fixture();
    const sid = await settledWithArtifact(at, { branch: 'feat/x' });
    const outcome = await arm({ viewerId: at.ada, sessionId: sid, roomId: at.roomId });
    expect(outcome).toEqual({ ok: false, reason: 'no_artifact' });
  });

  /**
   * THE TABLE, not the function: even with every application guard gone, a certifier
   * cannot be named over an empty `{}`.
   *
   * RED ON REVERT: revert `atrium_sessions_certify_needs_artifact` to the 0034
   * null-only body (drizzle/0038). The complete receipt over `{}` then writes.
   */
  it('the TABLE refuses a certifier over an empty {} artifact (drizzle/0038)', async () => {
    const at = await fixture();
    const sid = await settledWithArtifact(at, {});
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
    expect(why).toMatch(/reviewable|empty work|branch\+commit|no branch/i);
    expect((await read(sid))[0]?.certifiedBy).toBeNull();
  });

  /* THE CONTROL: a well-formed artifact (branch AND commit) still certifies through
     the app path, so the guard refuses the empty shape, not the honest one. */
  it('a well-formed artifact still arms and certifies', async () => {
    const at = await fixture();
    const sid = await settledWithArtifact(at, { branch: 'feat/y', commit: 'deadbee' });
    const token = await armOk({ viewerId: at.ada, sessionId: sid, roomId: at.roomId });
    await backdateArm(sid, CERTIFY_REQUIRED_HOLD_MS + 500);
    expect(
      await certifySession({
        database: handle.db,
        viewerId: at.ada,
        sessionId: sid,
        authorizedRoomId: at.roomId,
        attemptToken: token,
      }),
    ).toEqual({ ok: true });
    expect((await read(sid))[0]?.certifiedBy).toBe(at.ada);
  });
});

describe('the attempt is server-issued, and no client value can jam it (#121 round-7 finding 2)', () => {
  /**
   * THE DoS THAT SHIPPED. Round 6 raised a session-global cancel watermark from a
   * CLIENT-minted `attemptSeq`: `disarm(attemptSeq = MAX_SAFE_INTEGER)` set an
   * unbounded watermark that refused every honest arm forever, and cross-client
   * clock skew tripped it by accident. The attempt is SERVER-ISSUED now — the nonce
   * the arm mints and returns is its whole identity, and there is no watermark and
   * no client number to raise. So a cancel cannot jam a future arm: a fresh press
   * arms and certifies right after one.
   *
   * RED ON REVERT: reintroduce a client-supplied cancel watermark (`certify_cancel_seq`
   * raised by the disarm, an arm refusing at or below it). A disarm carrying a huge
   * value would then block the fresh arm below, which this test forbids.
   */
  it('a release does not jam the next arm — begin → release → begin → confirm still lands', async () => {
    const at = await fixture();
    const token1 = await armOk({ viewerId: at.ada, sessionId: at.sessionId, roomId: at.roomId });
    // Release the first press.
    expect(
      await disarmCertification({
        database: handle.db,
        viewerId: at.ada,
        sessionId: at.sessionId,
        attemptToken: token1,
      }),
    ).toEqual({ ok: true });

    // A genuinely fresh press arms cleanly — nothing the release left behind blocks it.
    const token2 = await armOk({ viewerId: at.ada, sessionId: at.sessionId, roomId: at.roomId });
    expect(token2).not.toBe(token1);
    await backdateArm(at.sessionId, CERTIFY_REQUIRED_HOLD_MS + 500);
    expect(
      await certifySession({
        database: handle.db,
        viewerId: at.ada,
        sessionId: at.sessionId,
        authorizedRoomId: at.roomId,
        attemptToken: token2,
      }),
    ).toEqual({ ok: true });
    expect((await read(at.sessionId))[0]?.certifiedBy).toBe(at.ada);
  });

  /**
   * BEGIN → RELEASE → (REORDERED) CONFIRM STILL REFUSES. The release clears the
   * nonce; a confirm that presents the released press's token — however it was
   * reordered onto the wire — finds no live attempt and is refused.
   *
   * RED ON REVERT: make `disarmCertification` a no-op. The confirm carrying the
   * token then finds the arm still live past the gate and certifies the released
   * hold.
   */
  it('a confirm carrying a released token is refused (the nonce is cleared)', async () => {
    const at = await fixture();
    const token = await armOk({ viewerId: at.ada, sessionId: at.sessionId, roomId: at.roomId });
    await backdateArm(at.sessionId, CERTIFY_REQUIRED_HOLD_MS + 500);
    expect(
      await disarmCertification({
        database: handle.db,
        viewerId: at.ada,
        sessionId: at.sessionId,
        attemptToken: token,
      }),
    ).toEqual({ ok: true });

    // The confirm for the released press — even with its token, past the gate.
    const outcome = await certifySession({
      database: handle.db,
      viewerId: at.ada,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
      attemptToken: token,
    });
    expect(outcome).toEqual({ ok: false, reason: 'not_armed' });
    expect((await read(at.sessionId))[0]?.certifiedBy).toBeNull();
  });

  /**
   * THE CONFIRM COMPLETES THE PRESS IT BEGAN. A confirm carrying a token that is not
   * the pending arm's is refused — a stale or forged token cannot spend the live arm.
   *
   * RED ON REVERT: drop the `attemptToken !== undefined && session.armNonce !== attemptToken`
   * clause from `certifySession`. The mismatched-token confirm then certifies.
   */
  it('a confirm whose token is not the pending arm’s is refused', async () => {
    const at = await fixture();
    const token = await armOk({ viewerId: at.ada, sessionId: at.sessionId, roomId: at.roomId });
    await backdateArm(at.sessionId, CERTIFY_REQUIRED_HOLD_MS + 500);
    // A confirm carrying a DIFFERENT token than the one the arm returned.
    expect(
      await certifySession({
        database: handle.db,
        viewerId: at.ada,
        sessionId: at.sessionId,
        authorizedRoomId: at.roomId,
        attemptToken: randomUUID(),
      }),
    ).toEqual({ ok: false, reason: 'not_armed' });
    // The right token still lands.
    expect(
      await certifySession({
        database: handle.db,
        viewerId: at.ada,
        sessionId: at.sessionId,
        authorizedRoomId: at.roomId,
        attemptToken: token,
      }),
    ).toEqual({ ok: true });
  });

  /**
   * A STALE RELEASE CANNOT CLOBBER A NEWER PRESS. A disarm carrying an OLD token
   * clears nothing when a fresh press has since re-armed with a new nonce, so the
   * live hold survives.
   *
   * RED ON REVERT: drop the `eq(sessions.certifyArmNonce, attemptToken)` scope from
   * the disarm's clear. The stale release then wipes the newer press's arm.
   */
  it('a disarm carrying a stale token does not clear a newer press’s arm', async () => {
    const at = await fixture();
    const stale = await armOk({ viewerId: at.ada, sessionId: at.sessionId, roomId: at.roomId });
    // A fresh press re-arms (a new nonce), superseding the first in the browser.
    const fresh = await armOk({ viewerId: at.ada, sessionId: at.sessionId, roomId: at.roomId });
    expect(fresh).not.toBe(stale);

    // The stale release (for the first press) arrives late — and clears nothing,
    // because the pending arm now carries the fresh nonce.
    expect(
      await disarmCertification({
        database: handle.db,
        viewerId: at.ada,
        sessionId: at.sessionId,
        attemptToken: stale,
      }),
    ).toEqual({ ok: true });
    expect((await read(at.sessionId))[0]?.armedBy).toBe(at.ada);

    // The fresh press still certifies.
    await backdateArm(at.sessionId, CERTIFY_REQUIRED_HOLD_MS + 500);
    expect(
      await certifySession({
        database: handle.db,
        viewerId: at.ada,
        sessionId: at.sessionId,
        authorizedRoomId: at.roomId,
        attemptToken: fresh,
      }),
    ).toEqual({ ok: true });
  });

  /**
   * THE TOKEN IS REQUIRED, NOT OPTIONAL-WHEN-SUPPLIED (#121 round-8, fix 1).
   *
   * The confirm lib made `attemptToken` optional and compared it only when present —
   * so a confirm carrying a LIVE, AGED arm but NO token slipped past the attempt
   * check and certified. The Server Action already required the token, so it was not
   * wire-reachable; but a green integration suite proving a tokenless certify
   * succeeds is exactly the false-green this codebase must never ship (the arm's
   * single-use attempt is its whole identity — a confirm that names none is not
   * completing any press). The lib now requires the token at the TYPE, and compares
   * it unconditionally, so a raw caller bypassing the type is still refused.
   *
   * RED ON REVERT: restore the `attemptToken !== undefined &&` guard on the nonce
   * compare in `certifySession`. This tokenless confirm — a live arm, aged past the
   * gate — then reaches the write and certifies, which is the shape fix 1 closes.
   */
  it('a confirm with NO token at all is refused — the attempt token is required', async () => {
    const at = await fixture();
    await armOk({ viewerId: at.ada, sessionId: at.sessionId, roomId: at.roomId });
    await backdateArm(at.sessionId, CERTIFY_REQUIRED_HOLD_MS + 500);

    // A raw caller bypassing the required-token TYPE (a hand-built request, an older
    // client). The lib must refuse it rather than spend the live arm behind it.
    const tokenless = {
      database: handle.db,
      viewerId: at.ada,
      sessionId: at.sessionId,
      authorizedRoomId: at.roomId,
    } as unknown as Parameters<typeof certifySession>[0];
    const outcome = await certifySession(tokenless);
    expect(outcome).toEqual({ ok: false, reason: 'not_armed' });
    expect((await read(at.sessionId))[0]?.certifiedBy).toBeNull();
  });
});

describe('certified_at is stamped on the same real clock the hold is measured on (#121 round-8)', () => {
  /**
   * A CONFIRM THAT BLOCKS ON THE ROW LOCK MUST NOT REFUSE AN HONEST HOLD (fix 4).
   *
   * The hold is measured `clock_timestamp() - certify_armed_at` in the confirm's
   * SELECT, which runs AFTER the row lock is acquired. `certified_at` must be
   * stamped on that SAME real clock, or drizzle/0036's consistency check
   * (`certified_held_ms ≈ certified_at − certify_armed_at`, within a 1s slack)
   * refuses a hold that genuinely happened. When `certified_at` was `now()`
   * (transaction-start), a confirm whose transaction OPENED and then blocked for
   * over a second before it measured the hold stamped a `certified_at` more than the
   * slack behind that measured interval, and 0036 refused the HONEST confirm — a
   * false negative under lock contention.
   *
   * The block must fall BEFORE the confirm measures the hold, so the measurement
   * clock and `certified_at`'s clock both land AFTER the wait while `now()` is stuck
   * at transaction-start. The confirm's FIRST in-transaction act is the membership
   * re-read (`viewerMayCertify`, a `FOR SHARE` on the membership row); a second
   * connection holds that row `FOR UPDATE` for over a second, so the confirm's
   * transaction is open (now() fixed at ~T0) while it waits, and only afterwards
   * does it measure `clock_timestamp() - certify_armed_at` and stamp `certified_at`.
   * With `certified_at = clock_timestamp()` the measurement and the stamp share that
   * post-wait clock and the receipt is consistent; with `now()` the stamp is ~T0,
   * over a second behind the measured hold, and 0036 refuses it.
   *
   * RED ON REVERT: change `certified_at` back to `sql\`now()\`` in `certifySession`.
   * The confirm below then stamps a `certified_at` ~2s behind the measured hold,
   * 0036 raises `certified_held_ms ... does not match the time that actually
   * elapsed`, the UPDATE throws, and this test fails instead of returning ok:true.
   */
  it('an honest aged arm confirmed under a >1s-held lock still certifies', async () => {
    const at = await fixture();
    const token = await armOk({ viewerId: at.ada, sessionId: at.sessionId, roomId: at.roomId });
    // Age the arm past the gate up front — the hold is honest, just not waited out.
    await backdateArm(at.sessionId, CERTIFY_REQUIRED_HOLD_MS + 500);

    const reserved = await handle.sql.reserve();
    let outcome: Awaited<ReturnType<typeof certifySession>>;
    try {
      await reserved`BEGIN`;
      /* Hold ADA's membership row FOR UPDATE — the row `viewerMayCertify` re-reads
         FOR SHARE as the confirm's first in-transaction act. The confirm's
         transaction opens, fixes now() at ~T0, then blocks HERE, before it ever
         measures the hold or stamps certified_at. */
      await reserved`SELECT role FROM memberships
        WHERE room_id = ${at.roomId} AND user_id = ${at.ada} FOR UPDATE`;

      // Fire the confirm WITHOUT awaiting: it opens its transaction and blocks on the
      // membership row this connection holds.
      const pending = certifySession({
        database: handle.db,
        viewerId: at.ada,
        sessionId: at.sessionId,
        authorizedRoomId: at.roomId,
        attemptToken: token,
      });

      /* Hold the lock well over a second, so a reverted `now()` (transaction-start)
         stamp is more than the 1s slack behind the clock the hold is measured on by
         the time the confirm proceeds past the wait. */
      await new Promise((resolve) => setTimeout(resolve, CERTIFY_REQUIRED_HOLD_MS));
      await reserved`COMMIT`;
      outcome = await pending;
    } finally {
      await reserved.release();
    }

    expect(outcome).toEqual({ ok: true });
    const [row] = await read(at.sessionId);
    expect(row?.certifiedBy).toBe(at.ada);
    /* The recorded hold spans the real interval — the arm's age plus the >1s the
       confirm spent blocked — not the transaction-start-relative one. */
    expect(row?.certifiedHeldMs ?? 0).toBeGreaterThanOrEqual(CERTIFY_REQUIRED_HOLD_MS);
  });
});
