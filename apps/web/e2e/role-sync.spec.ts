import { randomUUID } from 'node:crypto';
import {
  joinWorkspaceRooms,
  memberLockKeys,
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
});
