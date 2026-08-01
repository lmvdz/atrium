import { randomUUID } from 'node:crypto';
import {
  atriumOrganizationOptions,
  atriumOrganizationPorts,
  joinWorkspaceRooms,
  listAuthorizedRooms,
  loadAuthorizedRoom,
  loadRoomMembership,
  memberLockKeys,
  type RoomCleanupFailure,
  revokeWorkspaceRooms,
  syncWorkspaceRoomRoles,
} from '@atrium/auth';
import {
  createDatabase,
  type Database,
  memberships,
  organizationSchemaOptions,
  rooms,
  users,
  workspaceMembers,
  workspaces,
} from '@atrium/db';
import { expect, test } from '@playwright/test';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { databaseUrl } from './support/config.mjs';

/**
 * Room authorization against a real Postgres, because the fix is a join.
 *
 * ## What five rounds got wrong
 *
 * Rounds 2 through 5 of #26 each closed a way for a revocation to fail to
 * propagate into `memberships`. Every one was a real defect and every one left
 * the class open, because the authorization *read* asked only `memberships` —
 * the table this codebase derives from `workspace_members`. Any cleanup that
 * failed, for any reason, left a row that was still full authority.
 *
 * Round 6 joins `workspace_members` into every room-authorization query
 * (`packages/auth/src/room-access.ts`). The tests below do not assert that the
 * join is present; they *break the cleanup on purpose*, prove it stayed broken,
 * and then ask whether access survived. That distinction is the point: a test
 * that mocks the revocation and checks a SQL string would pass against a query
 * that never runs.
 *
 * The functions under test are the ones the apps run. `apps/server/src/index.ts`
 * and `apps/web/lib/workspaces.ts` do nothing but hand these a `Database`, so
 * there is no re-typed approximation between the test and production.
 *
 * These live in the Playwright suite rather than in Vitest because this is where
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
  roomSlug: string;
}

/** A workspace with one room and one member, at a role of our choosing. */
async function fixture(
  workspaceRole: string,
  roomRole: 'owner' | 'admin' | 'member' = 'member',
): Promise<Fixture> {
  const tag = randomUUID().slice(0, 8);
  const [workspace] = await db
    .insert(workspaces)
    .values({ name: `room-access-${tag}`, slug: `room-access-${tag}` })
    .returning({ id: workspaces.id });
  const [user] = await db
    .insert(users)
    .values({
      email: `room-access-${tag}@atrium.test`,
      displayName: `room access ${tag}`,
      emailVerified: true,
    })
    .returning({ id: users.id });
  if (!workspace || !user) throw new Error('fixture insert returned nothing');

  const [room] = await db
    .insert(rooms)
    .values({ workspaceId: workspace.id, slug: 'general', name: 'general', createdBy: user.id })
    .returning({ id: rooms.id, slug: rooms.slug });
  if (!room) throw new Error('fixture room insert returned nothing');

  await db
    .insert(workspaceMembers)
    .values({ organizationId: workspace.id, userId: user.id, role: workspaceRole });
  await db.insert(memberships).values({ roomId: room.id, userId: user.id, role: roomRole });

  return { workspaceId: workspace.id, userId: user.id, roomId: room.id, roomSlug: room.slug };
}

/** How many `memberships` rows this user still holds. The residue, counted. */
async function roomRowsFor(at: Fixture): Promise<number> {
  const rows = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(eq(memberships.userId, at.userId));
  return rows.length;
}

/** Delete the `workspace_members` row, the way Better Auth's own write does. */
async function deleteMemberRow(at: Fixture): Promise<void> {
  await db
    .delete(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.organizationId, at.workspaceId),
        eq(workspaceMembers.userId, at.userId),
      ),
    );
}

/** Every room-authorization answer this repo has, for one user. */
async function accessFor(at: Fixture) {
  return {
    realtime: await loadRoomMembership(db, at.roomId, at.userId),
    list: await listAuthorizedRooms(db, at.workspaceId, at.userId),
    page: await loadAuthorizedRoom(db, at.workspaceId, at.roomSlug, at.userId),
  };
}

test.describe('authorization does not depend on cleanup having succeeded', () => {
  test('grants access when both rows are there', async () => {
    /**
     * The positive control, first, because everything else in this file is a
     * denial and a `return null` would satisfy all of them. If this test ever
     * goes red the rest of the file is proving nothing.
     */
    const at = await fixture('admin', 'admin');
    const access = await accessFor(at);

    expect(access.realtime).toEqual({ role: 'admin' });
    expect(access.list.map((room) => room.slug)).toEqual(['general']);
    expect(access.page).toMatchObject({ slug: 'general', role: 'admin' });
  });

  test('denies every read when the member row is gone but the room rows are not', async () => {
    /**
     * The finding, at its smallest: the state a failed sweep leaves behind.
     *
     * Catches: removing `.innerJoin(workspaceMembers, roomWorkspaceMemberJoin)`
     * from any of the three queries in `room-access.ts`. Verified by doing
     * exactly that — with the join removed, `realtime` comes back as
     * `{ role: 'admin' }` and both web reads return the room.
     */
    const at = await fixture('admin', 'admin');
    await deleteMemberRow(at);

    // The premise, measured rather than assumed: the room rows really are still
    // there. Without this line the test would also pass against a cascade that
    // had quietly deleted them, and would be proving the wrong thing.
    expect(await roomRowsFor(at), 'the stale room row this test is about').toBe(1);

    const access = await accessFor(at);
    expect(access.realtime).toBeNull();
    expect(access.list).toEqual([]);
    expect(access.page).toBeNull();
  });

  test('denies after a post-removal sweep fails on the lock timeout', async () => {
    /**
     * The forced regression the round-5 delta asked for, with the failure made
     * real rather than simulated.
     *
     * Round 5 gave `withMemberLock` a 5s `lock_timeout`, which turned a hang
     * into a `MemberLockTimeoutError` — and `afterRemoveMember` swallowed it.
     * So: a third session holds the member's advisory lock, the member row goes
     * (Better Auth's write, which does not take that lock), and the sweep that
     * follows genuinely times out. Three things are then asserted in order,
     * and the first two are the premise:
     *
     *   1. the sweep failed, by name — not "something threw";
     *   2. the room row survived it;
     *   3. no read grants access anyway.
     *
     * Catches: removing the join (assertion 3 fails while 1 and 2 still pass,
     * which is precisely the round-5 state of the world).
     */
    const at = await fixture('admin', 'admin');
    const [first, second] = memberLockKeys(at.workspaceId, at.userId);
    const holder = postgres(databaseUrl, { max: 1, onnotice: () => {} });

    try {
      await holder`select pg_advisory_lock(${first}, ${second})`;
      await deleteMemberRow(at);

      const failure = await revokeWorkspaceRooms(db, {
        workspaceId: at.workspaceId,
        userId: at.userId,
      }).then(
        () => null,
        (error: Error) => error,
      );

      expect(failure, 'the sweep succeeded while another session held its lock').not.toBeNull();
      expect(failure?.name).toBe('MemberLockTimeoutError');
      expect(await roomRowsFor(at), 'the sweep left the room row behind, as designed').toBe(1);

      const access = await accessFor(at);
      expect(access.realtime).toBeNull();
      expect(access.list).toEqual([]);
      expect(access.page).toBeNull();
    } finally {
      await holder`select pg_advisory_unlock(${first}, ${second})`;
      await holder.end({ timeout: 5 });
    }
  });

  test('denies through the real removal hook, whose sweep it lets fail', async () => {
    /**
     * The same thing one level up: through `afterRemoveMember` itself, with the
     * real database-backed ports, so the swallow under test is the shipped one
     * rather than a call this test made directly.
     *
     * The hook is *supposed* to swallow — the removal has committed and
     * throwing would report the opposite of what happened. What round 6 changes
     * is that swallowing is no longer a security decision. So this asserts both
     * halves: the failure is reported through `onCleanupFailure`, and the
     * orphaned rows it leaves grant nothing.
     *
     * Catches: removing the join (the access assertions fail); deleting the
     * `onCleanupFailure` call (the report assertion fails).
     */
    const at = await fixture('admin', 'admin');
    const reported: RoomCleanupFailure[] = [];
    const hooks = atriumOrganizationOptions({
      ports: atriumOrganizationPorts(db),
      baseURL: 'https://atrium.test',
      mailer: async () => {},
      schema: organizationSchemaOptions,
      logger: { warn: () => {}, error: () => {} },
      onCleanupFailure: (f) => reported.push(f),
    }).organizationHooks;

    const [first, second] = memberLockKeys(at.workspaceId, at.userId);
    const holder = postgres(databaseUrl, { max: 1, onnotice: () => {} });

    try {
      await holder`select pg_advisory_lock(${first}, ${second})`;
      await deleteMemberRow(at);

      // Better Auth calls this and ignores its result; so do we.
      await expect(
        hooks.afterRemoveMember({
          member: { userId: at.userId, organizationId: at.workspaceId },
          organization: { id: at.workspaceId },
        }),
      ).resolves.toBeUndefined();

      expect(reported).toHaveLength(1);
      expect(reported[0]?.error.name).toBe('MemberLockTimeoutError');
      expect(reported[0]).toMatchObject({
        operation: 'revokeWorkspaceRooms',
        phase: 'afterRemoveMember',
        workspaceId: at.workspaceId,
        userId: at.userId,
      });
      expect(await roomRowsFor(at), 'the swallowed failure left the room row').toBe(1);

      const access = await accessFor(at);
      expect(access.realtime).toBeNull();
      expect(access.list).toEqual([]);
      expect(access.page).toBeNull();
    } finally {
      await holder`select pg_advisory_unlock(${first}, ${second})`;
      await holder.end({ timeout: 5 });
    }
  });

  test('denies after the full interleaving the round-5 delta drew', async () => {
    /**
     * Codex's schedule, played out end to end rather than argued about:
     *
     *   1. `beforeRemoveMember` sweeps the rooms and releases the member lock;
     *   2. a concurrent `afterAcceptInvitation → joinWorkspaceRooms` takes that
     *      released lock while the member row is *still there*, and re-grants
     *      every room — legitimately, on the row it can see;
     *   3. Better Auth deletes the member row;
     *   4. `afterRemoveMember` sweeps again and hits the 5s lock timeout;
     *   5. the failure is swallowed.
     *
     * Final state: no workspace membership, full room membership. Through round
     * 5 that was access. Every step below is a real call in the real order —
     * the only thing arranged is the advisory-lock holder that makes step 4
     * time out, which is what "the sweep failed" means in practice.
     *
     * Catches: removing the join. With it removed, step 6 finds `{ role:
     * 'admin' }` and the room listed — the failure this whole ticket is about,
     * reached without a single propagation bug remaining.
     */
    const at = await fixture('admin', 'admin');

    // 1. the pre-removal sweep, which really does clear the rooms.
    await revokeWorkspaceRooms(db, { workspaceId: at.workspaceId, userId: at.userId });
    expect(await roomRowsFor(at), 'the pre-removal sweep cleared the rooms').toBe(0);

    // 2. the join that beat the removal, on a member row that still exists.
    expect(
      await joinWorkspaceRooms(db, {
        workspaceId: at.workspaceId,
        userId: at.userId,
        role: 'admin',
      }),
      'the racing join re-granted the room — this is the window, not a bug in it',
    ).toBe(1);

    // 3. Better Auth's own write.
    await deleteMemberRow(at);

    const [first, second] = memberLockKeys(at.workspaceId, at.userId);
    const holder = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    try {
      await holder`select pg_advisory_lock(${first}, ${second})`;

      // 4 and 5. the second sweep, failing, swallowed.
      const failure = await revokeWorkspaceRooms(db, {
        workspaceId: at.workspaceId,
        userId: at.userId,
      }).then(
        () => null,
        (error: Error) => error,
      );
      expect(failure?.name).toBe('MemberLockTimeoutError');
      expect(await roomRowsFor(at), 'the interleaving left room access behind').toBe(1);

      // 6. and none of it is access.
      const access = await accessFor(at);
      expect(access.realtime).toBeNull();
      expect(access.list).toEqual([]);
      expect(access.page).toBeNull();
    } finally {
      await holder`select pg_advisory_unlock(${first}, ${second})`;
      await holder.end({ timeout: 5 });
    }
  });
});

test.describe('the role a stale room row carries is capped at the workspace role', () => {
  test('reads a demoted member as a member, even with an admin room row', async () => {
    /**
     * The same class one notch down, and the reason the fix is not only the
     * join. A demotion whose `syncWorkspaceRoomRoles` failed leaves
     * `memberships.role = 'admin'` beside `workspace_members.role = 'member'`.
     * The join is satisfied — they *are* still a member — so existence alone
     * would hand back `admin`, and `room.rename` / `room.archive` are admin
     * commands.
     *
     * The failure is forced the same way as above: the lock is held, the
     * demotion's reconciliation times out, and the room row keeps the old role.
     *
     * Catches: `effectiveRoomRole` returning `row.role` instead of the lower of
     * the two — which is what all three queries did through round 5.
     */
    const at = await fixture('admin', 'admin');
    const [first, second] = memberLockKeys(at.workspaceId, at.userId);
    const holder = postgres(databaseUrl, { max: 1, onnotice: () => {} });

    try {
      await holder`select pg_advisory_lock(${first}, ${second})`;

      // The workspace row is demoted — that write takes no advisory lock.
      await db
        .update(workspaceMembers)
        .set({ role: 'member' })
        .where(
          and(
            eq(workspaceMembers.organizationId, at.workspaceId),
            eq(workspaceMembers.userId, at.userId),
          ),
        );

      // The reconciliation that should follow it down, failing.
      const failure = await syncWorkspaceRoomRoles(db, {
        workspaceId: at.workspaceId,
        userId: at.userId,
      }).then(
        () => null,
        (error: Error) => error,
      );
      expect(failure?.name).toBe('MemberLockTimeoutError');

      // The premise: the room row still says admin.
      const [stale] = await db
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.roomId, at.roomId), eq(memberships.userId, at.userId)));
      expect(stale?.role, 'the demotion did not reach the room row').toBe('admin');

      // And the authority it grants is the workspace's, not its own.
      const access = await accessFor(at);
      expect(access.realtime).toEqual({ role: 'member' });
      expect(access.page).toMatchObject({ role: 'member' });
      expect(access.list[0]).toMatchObject({ role: 'member' });
    } finally {
      await holder`select pg_advisory_unlock(${first}, ${second})`;
      await holder.end({ timeout: 5 });
    }
  });

  test('does not promote a room row to meet a higher workspace role', async () => {
    /**
     * The ceiling is a ceiling. A member whose workspace role was raised to
     * owner but whose rooms have not been reconciled yet stays at their room
     * role until `afterUpdateMemberRole` runs — the direction round 2 got wrong
     * by granting room authority before the workspace write had committed.
     *
     * Catches: replacing the `lowerOf` ceiling with "prefer the workspace role",
     * which would look like a fix and would hand out authority early.
     */
    const at = await fixture('owner', 'member');
    expect(await loadRoomMembership(db, at.roomId, at.userId)).toEqual({ role: 'member' });
  });
});
