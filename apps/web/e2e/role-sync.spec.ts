import { randomUUID } from 'node:crypto';
import {
  createDefaultRoom,
  joinWorkspaceRooms,
  memberLockKeys,
  memberLockTimeoutMs,
  revokeAcceptedInvitation,
  revokeWorkspaceRooms,
  syncWorkspaceRoomRoles,
  voidInvitation,
} from '@atrium/auth';
import {
  createDatabase,
  type Database,
  memberships,
  rooms,
  users,
  workspaceInvitations,
  workspaceMembers,
  workspaces,
} from '@atrium/db';
import { expect, test } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { databaseUrl } from './support/config.mjs';

/**
 * Role reconciliation against a real Postgres, because the mechanism *is*
 * Postgres.
 *
 * `packages/auth/test/org.test.ts` proves the hooks cannot pass a stale role —
 * that is a property of the port's signature and a stub can settle it. It cannot
 * settle the other half: that the read of the committed role and the write of
 * the room rows are one serialized unit per (workspace, member). That is
 * `pg_advisory_xact_lock`, and the only honest way to test a lock is to hold it
 * from somewhere else and watch.
 *
 * These run in the Playwright suite rather than in Vitest because this is where
 * a migrated database exists (`e2e/support/ensure-database.mjs`, which starts one
 * if it has to and never silently skips). No browser is involved.
 */

let handle: ReturnType<typeof createDatabase>;
let db: Database;

test.beforeAll(() => {
  handle = createDatabase({ url: databaseUrl, max: 4 });
  db = handle.db;
});

test.afterAll(async () => {
  await handle.close();
});

interface Fixture {
  workspaceId: string;
  userId: string;
  roomId: string;
}

/** A workspace with one room and one member, at a role of our choosing. */
async function fixture(role: string, roomRole: 'owner' | 'admin' | 'member'): Promise<Fixture> {
  const tag = randomUUID().slice(0, 8);
  const [workspace] = await db
    .insert(workspaces)
    .values({ name: `role-sync-${tag}`, slug: `role-sync-${tag}` })
    .returning({ id: workspaces.id });
  const [user] = await db
    .insert(users)
    .values({
      email: `role-sync-${tag}@atrium.test`,
      displayName: `role sync ${tag}`,
      emailVerified: true,
    })
    .returning({ id: users.id });
  if (!workspace || !user) throw new Error('fixture insert returned nothing');

  const [room] = await db
    .insert(rooms)
    .values({ workspaceId: workspace.id, slug: 'general', name: 'general', createdBy: user.id })
    .returning({ id: rooms.id });
  if (!room) throw new Error('fixture room insert returned nothing');

  await db.insert(workspaceMembers).values({ organizationId: workspace.id, userId: user.id, role });
  await db.insert(memberships).values({ roomId: room.id, userId: user.id, role: roomRole });

  return { workspaceId: workspace.id, userId: user.id, roomId: room.id };
}

async function roomRoleOf(at: Fixture): Promise<string | null> {
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.roomId, at.roomId), eq(memberships.userId, at.userId)))
    .limit(1);
  return row?.role ?? null;
}

async function setCommittedRole(at: Fixture, role: string): Promise<void> {
  await db
    .update(workspaceMembers)
    .set({ role })
    .where(
      and(
        eq(workspaceMembers.organizationId, at.workspaceId),
        eq(workspaceMembers.userId, at.userId),
      ),
    );
}

/** Whether a promise has settled, without awaiting it. */
function settled<T>(promise: Promise<T>): () => boolean {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return () => done;
}

test.describe('room roles follow the committed workspace role', () => {
  test('applies what is in the member row, not what the caller believed', async () => {
    // Catches: any version of `syncWorkspaceRoomRoles` that takes a role and
    // writes it. The room row says `admin` and the caller says nothing; only the
    // committed `member` can produce the expected result.
    const at = await fixture('member', 'admin');
    await syncWorkspaceRoomRoles(db, { workspaceId: at.workspaceId, userId: at.userId });
    expect(await roomRoleOf(at)).toBe('member');
  });

  test('treats a missing member row as the strongest revocation there is', async () => {
    // Catches: reading a null committed role as "leave them alone".
    const at = await fixture('admin', 'admin');
    await db
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.organizationId, at.workspaceId),
          eq(workspaceMembers.userId, at.userId),
        ),
      );

    await syncWorkspaceRoomRoles(db, { workspaceId: at.workspaceId, userId: at.userId });
    expect(await roomRoleOf(at)).toBeNull();
  });

  test('atMost is a ceiling and never a value', async () => {
    // Catches: making `atMost` an instruction — the second case would then
    // promote a plain member to owner from a hook that only meant to demote.
    const down = await fixture('admin', 'admin');
    await syncWorkspaceRoomRoles(db, {
      workspaceId: down.workspaceId,
      userId: down.userId,
      atMost: 'member',
    });
    expect(await roomRoleOf(down)).toBe('member');

    const up = await fixture('member', 'member');
    await syncWorkspaceRoomRoles(db, {
      workspaceId: up.workspaceId,
      userId: up.userId,
      atMost: 'owner',
    });
    expect(await roomRoleOf(up)).toBe('member');
  });

  test('an unreadable committed role revokes rather than guessing', async () => {
    // Catches: `parseRole(role) ?? 'member'` creeping back in on this path.
    const at = await fixture('billing,admin', 'admin');
    await syncWorkspaceRoomRoles(db, { workspaceId: at.workspaceId, userId: at.userId });
    expect(await roomRoleOf(at)).toBeNull();
  });

  test('joining a workspace’s rooms cannot exceed the committed role', async () => {
    // An acceptance that overlaps a demotion must not hand out the role the
    // invitation was minted with.
    // Catches: dropping the `lowerOf(input.role, committed)` cap in
    // `joinWorkspaceRooms`.
    const at = await fixture('member', 'member');
    await db.delete(memberships).where(eq(memberships.userId, at.userId));
    await joinWorkspaceRooms(db, {
      workspaceId: at.workspaceId,
      userId: at.userId,
      role: 'owner',
    });
    expect(await roomRoleOf(at)).toBe('member');
  });
});

/**
 * The lock itself.
 *
 * Held from a second connection, so "does the reconciliation wait for it?" is a
 * question about Postgres rather than about this code's opinion of itself.
 */
test.describe('the reconciliation is serialized per (workspace, member)', () => {
  test('waits for a lock somebody else is holding on the same pair', async () => {
    const at = await fixture('admin', 'admin');
    const [first, second] = memberLockKeys(at.workspaceId, at.userId);

    // A session-scoped lock on the same key, taken from outside.
    const holder = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    try {
      await holder`select pg_advisory_lock(${first}, ${second})`;

      const sync = syncWorkspaceRoomRoles(db, {
        workspaceId: at.workspaceId,
        userId: at.userId,
      });
      const done = settled(sync);

      // It cannot proceed, so it has not: the room row is untouched and the
      // promise is outstanding.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(done(), 'the sync ran while another session held its lock').toBe(false);
      expect(await roomRoleOf(at)).toBe('admin');

      /**
       * And *this* is the round 3 interleaving, at the layer it actually lives
       * on: the committed role changes while the reconciliation is queued behind
       * the lock. Round 3 would have written the role its hook captured. This
       * one has not read anything yet — it reads when its turn comes.
       */
      await setCommittedRole(at, 'member');
      await holder`select pg_advisory_unlock(${first}, ${second})`;

      await sync;
      expect(await roomRoleOf(at)).toBe('member');
    } finally {
      await holder.end({ timeout: 5 });
    }
  });

  test('does not wait for a lock held on a different pair', async () => {
    // Catches: keying the lock on the workspace alone (or on a constant), which
    // would serialize every member of a workspace behind one another — correct,
    // and a bottleneck nobody asked for.
    const mine = await fixture('admin', 'admin');
    const theirs = await fixture('admin', 'admin');
    const [first, second] = memberLockKeys(theirs.workspaceId, theirs.userId);

    const holder = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    try {
      await holder`select pg_advisory_lock(${first}, ${second})`;
      await setCommittedRole(mine, 'member');
      // No timeout, no polling: if this were serialized behind the other pair's
      // lock it would hang until the test times out.
      await syncWorkspaceRoomRoles(db, { workspaceId: mine.workspaceId, userId: mine.userId });
      expect(await roomRoleOf(mine)).toBe('member');
    } finally {
      await holder`select pg_advisory_unlock(${first}, ${second})`;
      await holder.end({ timeout: 5 });
    }
  });

  test('a revocation takes the same lock as a role change', async () => {
    // Catches: leaving `revokeWorkspaceRooms` outside the lock, which would let
    // a removal and a role change on the same member interleave halfway.
    const at = await fixture('admin', 'admin');
    const [first, second] = memberLockKeys(at.workspaceId, at.userId);

    const holder = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    try {
      await holder`select pg_advisory_lock(${first}, ${second})`;
      const revoke = revokeWorkspaceRooms(db, {
        workspaceId: at.workspaceId,
        userId: at.userId,
      });
      const done = settled(revoke);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(done()).toBe(false);

      await holder`select pg_advisory_unlock(${first}, ${second})`;
      expect(await revoke).toBe(1);
      expect(await roomRoleOf(at)).toBeNull();
    } finally {
      await holder.end({ timeout: 5 });
    }
  });
});

/**
 * The invitation compensation, against the rows it actually has to move.
 */
test.describe('compensating an invitation reports what it found', () => {
  async function invite(at: Fixture, status: string): Promise<string> {
    const [row] = await db
      .insert(workspaceInvitations)
      .values({
        organizationId: at.workspaceId,
        email: `invitee-${randomUUID().slice(0, 8)}@atrium.test`,
        role: 'admin',
        status,
        expiresAt: new Date(Date.now() + 3_600_000),
        inviterId: at.userId,
      })
      .returning({ id: workspaceInvitations.id, email: workspaceInvitations.email });
    if (!row) throw new Error('invitation insert returned nothing');
    return row.id;
  }

  test('voids a pending row, and says which of the other states it hit', async () => {
    // Catches: collapsing `InvitationVoidOutcome` back to a boolean — the
    // accepted case is what `afterCreateInvitation` branches on.
    const at = await fixture('admin', 'admin');

    const pending = await invite(at, 'pending');
    expect(
      await voidInvitation(db, { invitationId: pending, workspaceId: at.workspaceId }),
    ).toEqual({ outcome: 'voided' });

    const accepted = await invite(at, 'accepted');
    const found = await voidInvitation(db, {
      invitationId: accepted,
      workspaceId: at.workspaceId,
    });
    expect(found.outcome).toBe('accepted');

    const canceled = await invite(at, 'canceled');
    expect(
      await voidInvitation(db, { invitationId: canceled, workspaceId: at.workspaceId }),
    ).toEqual({ outcome: 'already-inert', status: 'canceled' });

    expect(
      await voidInvitation(db, { invitationId: randomUUID(), workspaceId: at.workspaceId }),
    ).toEqual({ outcome: 'missing' });
  });

  test('undoes an acceptance: room rows first, then the member row', async () => {
    /**
     * Major finding 5. Round 3 could only cancel a `pending` row, so an
     * acceptance that beat the compensation left an elevated member and their
     * room memberships exactly where it put them — and threw a FORBIDDEN at the
     * inviter about it.
     *
     * Catches: deleting either half of `revokeAcceptedInvitation`.
     */
    const at = await fixture('admin', 'admin');
    const [invitee] = await db
      .insert(users)
      .values({
        email: `accepted-${randomUUID().slice(0, 8)}@atrium.test`,
        displayName: 'accepted invitee',
        emailVerified: true,
      })
      .returning({ id: users.id, email: users.email });
    if (!invitee) throw new Error('invitee insert returned nothing');

    await db
      .insert(workspaceMembers)
      .values({ organizationId: at.workspaceId, userId: invitee.id, role: 'admin' });
    await db.insert(memberships).values({ roomId: at.roomId, userId: invitee.id, role: 'admin' });

    const undone = await revokeAcceptedInvitation(db, {
      workspaceId: at.workspaceId,
      email: invitee.email,
    });
    expect(undone).toEqual({ removed: true, rooms: 1 });

    const rooms = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.userId, invitee.id));
    expect(rooms).toHaveLength(0);
    const member = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.organizationId, at.workspaceId),
          eq(workspaceMembers.userId, invitee.id),
        ),
      );
    expect(member).toHaveLength(0);
  });

  test('reports a compensation that hit nobody rather than inventing one', async () => {
    // Catches: returning `removed: true` unconditionally.
    const at = await fixture('admin', 'admin');
    expect(
      await revokeAcceptedInvitation(db, {
        workspaceId: at.workspaceId,
        email: 'nobody@atrium.test',
      }),
    ).toEqual({ removed: false, rooms: 0 });
  });

  /**
   * Major finding, round-4 delta: the compensation could leave room access
   * behind.
   *
   * Round 4 revoked the room rows through `revokeWorkspaceRooms` — its own
   * transaction, its own acquisition of the member lock — and then deleted the
   * `workspace_members` row in a *second* statement. Codex walked the
   * interleaving: the first transaction commits and **releases the lock**, a
   * concurrent `afterAcceptInvitation → joinWorkspaceRooms` takes it while the
   * member row is still there, reads that row, inserts room membership, and
   * finishes. The compensator then deletes only the workspace row. Final state:
   * no workspace membership, retained room access — the exact residue the
   * compensation exists to remove.
   *
   * ## Forcing the interleaving, deterministically
   *
   * The e2e above is serial, and a concurrency test that relies on timing
   * proves nothing on a fast machine. So the schedule is *held in place* with a
   * barrier Postgres enforces rather than a sleep: a third session opens a
   * transaction and takes a **row lock** on the invitee's `workspace_members`
   * row (`SELECT … FOR UPDATE`). It takes no advisory lock, so it does not
   * interfere with the mechanism under test — it only makes one specific
   * statement, `DELETE FROM workspace_members`, block until the test says
   * otherwise.
   *
   * That parks the compensator at precisely the moment the finding is about:
   *
   *  - **Round 4's shape:** the room rows are already deleted, the first
   *    transaction has committed, the member lock is *free*, and the member row
   *    still exists. A join started now sails through and re-grants the rooms.
   *  - **This shape:** both deletes are one transaction, so the compensator is
   *    parked *holding* the member lock. A join started now blocks, and when it
   *    finally runs there is no member row for it to read — which
   *    `joinWorkspaceRooms` treats as a refusal rather than as "use the role I
   *    was given".
   *
   * Catches, each independently: (1) splitting the compensation back into two
   * transactions — the joiner is then not blocked and the `settled` assertion
   * fails immediately; (2) restoring `committed ?? input.role` in
   * `joinWorkspaceRooms` — the joiner then grants rooms to a non-member and the
   * final assertions fail.
   */
  test('an acceptance racing the compensation cannot leave room access behind', async () => {
    const at = await fixture('admin', 'admin');
    const [invitee] = await db
      .insert(users)
      .values({
        email: `racing-${randomUUID().slice(0, 8)}@atrium.test`,
        displayName: 'racing invitee',
        emailVerified: true,
      })
      .returning({ id: users.id, email: users.email });
    if (!invitee) throw new Error('invitee insert returned nothing');

    await db
      .insert(workspaceMembers)
      .values({ organizationId: at.workspaceId, userId: invitee.id, role: 'admin' });
    await db.insert(memberships).values({ roomId: at.roomId, userId: invitee.id, role: 'admin' });

    const barrier = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    let releaseBarrier: () => void = () => {};
    const barrierReleased = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let barrierTaken: () => void = () => {};
    const taken = new Promise<void>((resolve) => {
      barrierTaken = resolve;
    });

    // The barrier: a row lock on the member row, and nothing else. Held open
    // until this test releases it.
    const held = barrier.begin(async (tx) => {
      await tx`select 1 from workspace_members
               where organization_id = ${at.workspaceId} and user_id = ${invitee.id}
               for update`;
      barrierTaken();
      await barrierReleased;
    });

    try {
      await Promise.race([
        taken,
        held.then(() => {
          throw new Error('the barrier transaction ended before it took the row lock');
        }),
      ]);

      // The compensator. It deletes the room rows, then blocks on the member
      // row — inside the member lock, which is the property under test.
      const compensating = revokeAcceptedInvitation(db, {
        workspaceId: at.workspaceId,
        email: invitee.email,
      });
      const compensated = settled(compensating);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(compensated(), 'the compensation ran through the row lock').toBe(false);

      // The acceptance that beat it, started in exactly the window round 4 left
      // open. It must not get in.
      const joining = joinWorkspaceRooms(db, {
        workspaceId: at.workspaceId,
        userId: invitee.id,
        role: 'admin',
      });
      const joined = settled(joining);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(
        joined(),
        'a join ran while the compensation was mid-flight — the member lock was released between its two writes',
      ).toBe(false);

      releaseBarrier();
      expect(await compensating).toEqual({ removed: true, rooms: 1 });

      // And now the join gets its turn, against a workspace it is no longer a
      // member of. It grants nothing.
      expect(await joining).toBe(0);
    } finally {
      releaseBarrier();
      await held.catch(() => {});
      await barrier.end({ timeout: 5 });
    }

    const leftBehind = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.userId, invitee.id));
    expect(leftBehind, 'room membership survived the compensation').toHaveLength(0);

    const member = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.organizationId, at.workspaceId),
          eq(workspaceMembers.userId, invitee.id),
        ),
      );
    expect(member).toHaveLength(0);
  });

  test('joining grants nothing at all when there is no workspace member row', async () => {
    /**
     * The second half of the same fix, on its own so its mutation is separable.
     *
     * Round 4 read a missing committed role as "the library has not committed
     * yet, so use the role I was handed". The ordering is the other way round —
     * Better Auth awaits its own transaction before calling
     * `afterAcceptInvitation` — so an absent member row means gone, not
     * pending, and granting rooms on it is the residue the compensation exists
     * to prevent.
     *
     * Catches: restoring `lowerOf(input.role, committed ?? input.role)`.
     */
    const at = await fixture('member', 'member');
    await db.delete(memberships).where(eq(memberships.userId, at.userId));
    await db
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.organizationId, at.workspaceId),
          eq(workspaceMembers.userId, at.userId),
        ),
      );

    expect(
      await joinWorkspaceRooms(db, {
        workspaceId: at.workspaceId,
        userId: at.userId,
        role: 'admin',
      }),
    ).toBe(0);
    expect(await roomRoleOf(at)).toBeNull();
  });
});

/**
 * The lock's other bound: how long anything waits for it.
 *
 * `pg_advisory_xact_lock` waits forever by default, so round 4's version of
 * this file made a stalled holder — a paused connection, a transaction whose
 * client vanished — hang every subsequent mutation on that member indefinitely,
 * with nothing logged and nothing changed. Codex's round-4 delta listed it as
 * polish; it is the difference between a failed request and a wedged one.
 */
test.describe('a stalled lock holder cannot hang a member’s mutations forever', () => {
  test('gives up after memberLockTimeoutMs instead of waiting for the holder', async () => {
    /**
     * Catches: removing the `set local lock_timeout` from `withMemberLock`.
     * Without it this test does not fail — it *hangs*, and Playwright's 60s
     * timeout is what would report it. The assertion on elapsed time is what
     * distinguishes "bounded" from "eventually", and the `MemberLockTimeoutError`
     * name is what distinguishes it from any other failure.
     */
    const at = await fixture('admin', 'admin');
    const [first, second] = memberLockKeys(at.workspaceId, at.userId);

    const holder = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    try {
      await holder`select pg_advisory_lock(${first}, ${second})`;

      const startedAt = Date.now();
      const failure = await syncWorkspaceRoomRoles(db, {
        workspaceId: at.workspaceId,
        userId: at.userId,
      }).then(
        () => null,
        (error: Error) => error,
      );
      const elapsed = Date.now() - startedAt;

      expect(failure, 'the sync succeeded while another session held its lock').not.toBeNull();
      expect(failure?.name).toBe('MemberLockTimeoutError');
      expect(failure?.message).toContain('pg_stat_activity');
      // Bounded: it waited roughly the timeout, not forever and not zero.
      expect(elapsed).toBeGreaterThanOrEqual(memberLockTimeoutMs - 500);
      expect(elapsed).toBeLessThan(memberLockTimeoutMs + 5_000);

      // And it changed nothing on its way out.
      expect(await roomRoleOf(at)).toBe('admin');
    } finally {
      await holder`select pg_advisory_unlock(${first}, ${second})`;
      await holder.end({ timeout: 5 });
    }
  });

  test('the room writes of a new workspace happen under the member lock too', async () => {
    /**
     * Round 4 left `createDefaultRoom` outside the lock on the argument that its
     * caller has nothing to race with — an argument about a caller, not about
     * the function. Codex flagged it; the rule worth having is that every write
     * to `memberships` for one member happens under that member's lock.
     *
     * Catches: taking `createDefaultRoom` back out of `withMemberLock`. Without
     * the lock this call completes while the holder still holds it.
     */
    const at = await fixture('owner', 'owner');
    const [first, second] = memberLockKeys(at.workspaceId, at.userId);

    const holder = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    try {
      await holder`select pg_advisory_lock(${first}, ${second})`;
      const creating = createDefaultRoom(db, {
        workspaceId: at.workspaceId,
        userId: at.userId,
        role: 'owner',
      });
      const done = settled(creating);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(done(), 'createDefaultRoom wrote room membership without the member lock').toBe(false);

      await holder`select pg_advisory_unlock(${first}, ${second})`;
      await creating;
    } finally {
      await holder.end({ timeout: 5 });
    }
  });
});

/**
 * The lock key, and the one honest thing to say about FNV-1a.
 *
 * It is not collision-resistant and this does not pretend it is. What matters
 * is the *direction* a collision fails in, which is the safe one: colliding
 * pairs take the same lock and serialize against each other. The failure that
 * would matter — two operations on the *same* pair taking *different* locks —
 * is impossible because the key is a pure function of the two ids and every
 * caller derives it from this one place.
 */
test.describe('the lock key', () => {
  test('is a pure function of the pair, so the same member never splits a lock', () => {
    // Catches: seeding the hash with anything per-call (a timestamp, a random
    // salt, `Math.random()` in a retry path). That is the only mutation that
    // could turn a collision property into a mutual-exclusion bug.
    const a = memberLockKeys('workspace-1', 'user-1');
    const b = memberLockKeys('workspace-1', 'user-1');
    expect(a).toEqual(b);
    expect(memberLockKeys('workspace-1', 'user-2')).not.toEqual(a);
    expect(memberLockKeys('workspace-2', 'user-1')).not.toEqual(a);
  });

  test('keeps the two ids in separate halves, so a collision needs both to collide', () => {
    // Catches: hashing `${workspaceId}:${userId}` into one number, which makes
    // the whole 64-bit space one 32-bit space and multiplies collisions —
    // still not a correctness bug, and still a needless bottleneck.
    const [firstA] = memberLockKeys('workspace-1', 'user-1');
    const [firstB] = memberLockKeys('workspace-1', 'user-2');
    expect(firstA).toBe(firstB);
    const [, secondA] = memberLockKeys('workspace-1', 'user-1');
    const [, secondB] = memberLockKeys('workspace-2', 'user-1');
    expect(secondA).toBe(secondB);
  });

  test('a collision serializes two unrelated members and never skips a lock', async () => {
    /**
     * The property, demonstrated rather than asserted: two *different* pairs
     * that happen to share a key contend, so the cost of a collision is
     * throughput. Rather than search for a natural FNV collision, this takes
     * one pair's key from outside and shows that a *different* pair whose ids
     * hash to it waits — which is what a collision is.
     *
     * The keys are integers, so "another pair that hashes here" is simulated
     * exactly by holding those integers. Nothing about the outcome depends on
     * which strings produced them.
     */
    const at = await fixture('admin', 'admin');
    const [first, second] = memberLockKeys(at.workspaceId, at.userId);

    const holder = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    try {
      await holder`select pg_advisory_lock(${first}, ${second})`;
      const sync = syncWorkspaceRoomRoles(db, {
        workspaceId: at.workspaceId,
        userId: at.userId,
      });
      const done = settled(sync);
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Waiting, not bypassing: the collision costs time and takes nothing away.
      expect(done()).toBe(false);
      await holder`select pg_advisory_unlock(${first}, ${second})`;
      await sync;
    } finally {
      await holder.end({ timeout: 5 });
    }
  });
});
