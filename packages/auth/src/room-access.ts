import { type Database, memberships, rooms, workspaceMembers } from '@atrium/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { parseRole, type Role } from './authz.js';
import { lowerOf, type ReconcileLogger } from './workspace.js';

/**
 * Room authorization. Every read of it, in one place.
 *
 * ## The finding this file exists for
 *
 * Rounds 2 through 5 of #26 each closed a different way for a revocation to
 * fail to *propagate* into `memberships`: reconcile inside the transaction,
 * evict the socket roster, order demotions before the library's commit,
 * serialize the whole thing under an advisory lock. Every one was a real
 * defect. Every one left the class open, because room authorization asked only
 * `memberships` — a table this codebase *derives* from `workspace_members`. A
 * cleanup that failed for any reason at all (the 5s lock timeout, a crashed
 * process, an interleaving nobody drew yet, a refactor that moves a hook) left
 * a stale row behind, and a stale row was sufficient authority.
 *
 * The fix is not another propagation path. It is that **every authorization
 * query joins `workspace_members`**, so a room row grants nothing once the
 * member row is gone. Authorization then does not depend on cleanup having
 * succeeded, and a cleanup failure degrades from a security hole to orphaned
 * rows nobody can use.
 *
 * This is the defect class the Buzz research recorded independently the same
 * day (`plans/research-buzz/BRIEF.md`, class 2/3): authorization consulting a
 * derived table rather than the source of truth.
 *
 * ## Why the queries live here and not in the two apps
 *
 * There are exactly three room-authorization reads in the repo — the realtime
 * server's membership oracle, and the web app's room list and room page — and
 * the failure mode of copying a security predicate into three files is that the
 * fourth one forgets it. They are all *here*, so a new call site can only get
 * the join or not have a query at all, and so a real Postgres can be pointed at
 * the same functions the apps run rather than at a re-typed approximation of
 * them. `apps/server/src/index.ts` and `apps/web/lib/workspaces.ts` now do
 * nothing but hand over a `Database`.
 *
 * The one rule that is *not* re-encoded here is the role lattice. `lowerOf` is
 * the single place `owner > admin > member` is written down; expressing it a
 * second time in SQL (`least()` sorts the role names alphabetically, which puts
 * `admin` below `member`) would be exactly the "two components that must agree
 * on a shared constant" failure this project already has a retro about. So the
 * join is SQL and the ceiling is TypeScript.
 */

/**
 * The join condition: this room's workspace must still carry this member.
 *
 * Correlates `workspace_members` to the `rooms` and `memberships` rows already
 * in the query, so it composes with any shape that has both — it does not
 * assume how the caller filtered. Safe against row multiplication: the
 * `workspace_members_org_user_key` unique index makes at most one row match.
 *
 * A drizzle condition is an immutable value, so one module-level constant is
 * shared by every query rather than rebuilt per call.
 */
export const roomWorkspaceMemberJoin = and(
  eq(workspaceMembers.organizationId, rooms.workspaceId),
  eq(workspaceMembers.userId, memberships.userId),
);

/**
 * The two role columns an authorization read selects.
 *
 * Spread into a `.select({ ... })`, so that adding the join and then forgetting
 * to read the workspace role is not a shape a query can end up in.
 */
export const roomAuthorizationRoles = {
  role: memberships.role,
  workspaceRole: workspaceMembers.role,
} as const;

/** A row selected with {@link roomAuthorizationRoles}. */
export interface RoomAuthorizationRow {
  /** `memberships.role` — the derived room role. */
  role: string;
  /** `workspace_members.role` — the source of truth it is derived from. */
  workspaceRole: string;
}

const silent: ReconcileLogger = { warn: () => {} };

/**
 * The role a caller actually holds in a room: the **lower** of the room row and
 * the workspace row, or `null` for no authority at all.
 *
 * The join makes a stale room row grant no *access*. This makes it grant no
 * *authority* either — the same class, one notch down. A demotion whose
 * propagation failed leaves `memberships.role = 'admin'` beside
 * `workspace_members.role = 'member'`, and `room.rename` / `room.archive` are
 * admin commands; reading the room role alone would still let them through.
 * Room roles in Atrium are wholly derived from workspace roles (`roomRole`,
 * `joinWorkspaceRooms`, `syncWorkspaceRoomRoles` — nothing grants a per-room
 * elevation), so capping at the workspace role is a no-op whenever propagation
 * worked and a repair whenever it did not.
 *
 * An unreadable role on either side resolves to `null` and denies: `lowerOf`
 * returns the unparseable string and `parseRole` refuses it. Fail-closed, the
 * same direction as `roomRole`.
 *
 * @param row    the selected row, or `undefined`/`null` when the join matched nothing.
 * @param logger gets a line when a role string is present but unreadable, which
 *               is either a bug or an attack and deserves one either way.
 */
export function effectiveRoomRole(
  row: RoomAuthorizationRow | undefined | null,
  logger: ReconcileLogger = silent,
): Role | null {
  if (!row) return null;
  const role = parseRole(lowerOf(row.role, row.workspaceRole));
  if (role === null) {
    logger.warn('refusing room authority for an unrecognised role', {
      unknownRole: true,
      role: row.role,
      workspaceRole: row.workspaceRole,
    });
  }
  return role;
}

/**
 * The realtime server's membership oracle: may this user act in this room, and
 * as what?
 *
 * Three conditions, all of them required: a `memberships` row for the pair, a
 * live (non-archived) room, and a surviving `workspace_members` row for the
 * room's workspace. Archiving a room therefore closes it to commands without a
 * second rule anywhere, and a removed member's leftover room rows authorize
 * nothing without a sweep having succeeded.
 */
export async function loadRoomMembership(
  db: Database,
  roomId: string,
  userId: string,
  logger: ReconcileLogger = silent,
): Promise<{ role: Role } | null> {
  const [row] = await db
    .select(roomAuthorizationRoles)
    .from(memberships)
    .innerJoin(rooms, eq(memberships.roomId, rooms.id))
    .innerJoin(workspaceMembers, roomWorkspaceMemberJoin)
    .where(
      and(eq(memberships.roomId, roomId), eq(memberships.userId, userId), isNull(rooms.archivedAt)),
    )
    .limit(1);

  const role = effectiveRoomRole(row, logger);
  return role === null ? null : { role };
}

export interface AuthorizedRoom {
  id: string;
  slug: string;
  name: string;
  role: Role;
}

/** Live rooms in a workspace this user may actually open, in slug order. */
export async function listAuthorizedRooms(
  db: Database,
  workspaceId: string,
  userId: string,
  logger: ReconcileLogger = silent,
): Promise<AuthorizedRoom[]> {
  const rows = await db
    .select({
      id: rooms.id,
      slug: rooms.slug,
      name: rooms.name,
      ...roomAuthorizationRoles,
    })
    .from(rooms)
    .innerJoin(memberships, and(eq(memberships.roomId, rooms.id), eq(memberships.userId, userId)))
    .innerJoin(workspaceMembers, roomWorkspaceMemberJoin)
    .where(and(eq(rooms.workspaceId, workspaceId), isNull(rooms.archivedAt)))
    .orderBy(asc(rooms.slug));

  // A role neither table can be read for is not a room this caller gets to see.
  return rows.flatMap((row) => {
    const role = effectiveRoomRole(row, logger);
    return role === null ? [] : [{ id: row.id, slug: row.slug, name: row.name, role }];
  });
}

/** One room of a workspace by slug, or null if this user may not open it. */
export async function loadAuthorizedRoom(
  db: Database,
  workspaceId: string,
  roomSlug: string,
  userId: string,
  logger: ReconcileLogger = silent,
): Promise<AuthorizedRoom | null> {
  const [row] = await db
    .select({
      id: rooms.id,
      slug: rooms.slug,
      name: rooms.name,
      ...roomAuthorizationRoles,
    })
    .from(rooms)
    .innerJoin(memberships, and(eq(memberships.roomId, rooms.id), eq(memberships.userId, userId)))
    .innerJoin(workspaceMembers, roomWorkspaceMemberJoin)
    .where(
      and(eq(rooms.workspaceId, workspaceId), eq(rooms.slug, roomSlug), isNull(rooms.archivedAt)),
    )
    .limit(1);

  if (!row) return null;
  const role = effectiveRoomRole(row, logger);
  return role === null ? null : { id: row.id, slug: row.slug, name: row.name, role };
}
