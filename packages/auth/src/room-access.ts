import { type Database, memberships, rooms, workspaceMembers } from '@atrium/db';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
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

/* ---------------------------------------------------------------------------
 * THE REALTIME SERVER'S TWO READS, ON THIS FILE'S QUERY.
 *
 * #22 built its own membership predicate in `apps/server/src/session.ts`, over
 * `memberships` alone, because it was written before this file existed. Merging
 * the two lanes put both predicates in one tree — the exact thing `room-access`
 * exists to prevent, and `test/room-access.test.ts` fails on it by design: an
 * app that can reach `memberships` can ask the question the stale-row way.
 *
 * The realtime predicate could not simply be deleted in favour of
 * `loadRoomMembership`, because it does two things that one does not:
 *
 *   1. it runs INSIDE the append transaction and takes `FOR SHARE`, which is
 *      #22 r1's fix for a time-of-check/time-of-use gap — a membership revoked
 *      between the check and the write produced durable history authored by
 *      somebody who had been removed from the room;
 *   2. it asks about MANY (user, room) pairs in one statement, because the
 *      fan-out set is re-checked every second and one query per subscriber is
 *      not the cost that was budgeted for.
 *
 * So they are both here, with the join, rather than one of them being dropped.
 * Same `roomWorkspaceMemberJoin`, same `effectiveRoomRole`, same fail-closed
 * direction — and `apps/server` no longer names `memberships` at all.
 * ------------------------------------------------------------------------- */

/** The read surface these need: the database, or a transaction inside it. */
export type RoomAccessRunner = Pick<Database, 'select'>;

/** A room membership as the realtime server consumes it. */
export interface RoomMembershipRow {
  roomId: string;
  userId: string;
  role: Role;
  seenSeq: number;
}

/**
 * One membership, joined, optionally row-locked.
 *
 * `lock: 'share'` when the caller is inside the transaction that will write.
 * Re-reading in the transaction closes most of the TOCTOU gap; the row lock
 * closes the rest, by making a concurrent DELETE wait for the append to commit
 * or abort instead of slipping between the read and the write. Cheap: one row,
 * one shared lock, held for the length of an append.
 *
 * The lock is taken on `memberships` — the row whose disappearance is the race —
 * and the joined `workspace_members` row is read without one: a workspace
 * revocation that lands mid-append is caught by the next revalidation pass,
 * which is the one-second window `MEMBERSHIP_REVALIDATE_INTERVAL_MS` names.
 */
export async function loadRoomMembershipRow(
  runner: RoomAccessRunner,
  roomId: string,
  userId: string,
  options: { lock?: 'share'; logger?: ReconcileLogger } = {},
): Promise<RoomMembershipRow | null> {
  const query = runner
    .select({
      roomId: memberships.roomId,
      userId: memberships.userId,
      seenSeq: memberships.seenSeq,
      ...roomAuthorizationRoles,
    })
    .from(memberships)
    .innerJoin(rooms, eq(memberships.roomId, rooms.id))
    .innerJoin(workspaceMembers, roomWorkspaceMemberJoin)
    .where(
      and(eq(memberships.roomId, roomId), eq(memberships.userId, userId), isNull(rooms.archivedAt)),
    )
    .limit(1);

  const [row] = await (options.lock === 'share' ? query.for('share', { of: memberships }) : query);
  const role = effectiveRoomRole(row, options.logger ?? silent);
  if (!row || role === null) return null;
  return { roomId: row.roomId, userId: row.userId, role, seenSeq: Number(row.seenSeq) };
}

/**
 * The key {@link roomMembershipsHeld} answers in.
 *
 * A single string so the caller can use a `Set` rather than a nested map, and
 * ONE function so the two sides cannot spell it differently — a mismatch here
 * reads as "everybody was revoked", which is not a hypothetical: the merge that
 * moved this query out of `apps/server/src/session.ts` first wrote the key as
 * `${userId}:${roomId}` here while the caller went on building
 * `${userId}\u0000${roomId}`, and three integration tests came back with every
 * subscriber on the instance dropped, including the ones nobody had revoked.
 *
 * The separator is NUL because a uuid cannot contain one. `apps/server` re-exports
 * this as `membershipKey`; there is no second definition.
 */
export function roomMembershipKey(userId: string, roomId: string): string {
  return `${userId}\u0000${roomId}`;
}

/**
 * Which of these `(user, room)` pairs still hold authority — the fan-out check.
 *
 * Returns the pairs that are **still members**, keyed by {@link roomMembershipKey}.
 * Deliberately that direction: an absent key is the answer for a revoked
 * membership, a revoked workspace member, an archived room, a room that never
 * existed, a malformed id, and a user who was never there. A "who was revoked"
 * result would have to enumerate reasons, and every reason it failed to think
 * of would read as "still a member".
 */
export async function roomMembershipsHeld(
  db: Database,
  pairs: readonly { userId: string; roomId: string }[],
  logger: ReconcileLogger = silent,
): Promise<Set<string>> {
  const held = new Set<string>();
  if (pairs.length === 0) return held;
  // One statement for every subscription on the instance. A tuple `IN` list hits
  // the memberships primary key once per pair; the alternative shape —
  // `or(and(eq, eq), …)` — is the same plan written so that drizzle has to build
  // a tree proportional to the socket count on every pass.
  const tuples = sql.join(
    pairs.map((pair) => sql`(${pair.userId}::uuid, ${pair.roomId}::uuid)`),
    sql`, `,
  );
  const rows = await db
    .select({
      userId: memberships.userId,
      roomId: memberships.roomId,
      ...roomAuthorizationRoles,
    })
    .from(memberships)
    .innerJoin(rooms, eq(memberships.roomId, rooms.id))
    .innerJoin(workspaceMembers, roomWorkspaceMemberJoin)
    .where(
      and(
        sql`(${memberships.userId}, ${memberships.roomId}) IN (${tuples})`,
        isNull(rooms.archivedAt),
      ),
    );
  for (const row of rows) {
    // Present in the join but with no readable authority is still "not a member".
    if (effectiveRoomRole(row, logger) === null) continue;
    held.add(roomMembershipKey(row.userId, row.roomId));
  }
  return held;
}

/**
 * Every effective member of one live room, for room-wide derived projections.
 *
 * This deliberately applies the same workspace join and role clamp as command
 * authorization. Reading `memberships` alone would resurrect a user whose
 * workspace membership was revoked but whose derived room row survived.
 */
export async function roomMemberIds(
  db: Database,
  roomId: string,
  logger: ReconcileLogger = silent,
): Promise<string[]> {
  const rows = await db
    .select({ userId: memberships.userId, ...roomAuthorizationRoles })
    .from(memberships)
    .innerJoin(rooms, eq(memberships.roomId, rooms.id))
    .innerJoin(workspaceMembers, roomWorkspaceMemberJoin)
    .where(and(eq(memberships.roomId, roomId), isNull(rooms.archivedAt)));

  return rows.filter((row) => effectiveRoomRole(row, logger) !== null).map((row) => row.userId);
}

/**
 * Move a member's read cursor forward, never backward.
 *
 * `apps/server`'s `room.ack` command owned this `UPDATE memberships` directly,
 * which is the same boundary breach one write instead of one read. The clamp is
 * the caller's business and stays there; what belongs here is that the row being
 * written is a room membership.
 */
export async function advanceSeenSeq(
  db: Database,
  roomId: string,
  userId: string,
  roomSeq: number,
): Promise<{ seenSeq: number } | null> {
  const [row] = await db
    .update(memberships)
    .set({ seenSeq: sql`greatest(${memberships.seenSeq}, ${roomSeq})` })
    .where(and(eq(memberships.roomId, roomId), eq(memberships.userId, userId)))
    .returning({ seenSeq: memberships.seenSeq });
  return row ? { seenSeq: Number(row.seenSeq) } : null;
}
