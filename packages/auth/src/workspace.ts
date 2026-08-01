import {
  type Database,
  memberships,
  rooms,
  users,
  workspaceInvitations,
  workspaceMembers,
} from '@atrium/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { parseRole, type Role, roleRank } from './authz.js';

/**
 * Keeping room membership in step with workspace membership.
 *
 * Better Auth owns *workspace* membership (`workspace_members`). Atrium's own
 * `memberships` table is *room* membership, and it is what the realtime server
 * authorizes against — it carries `last_read_seq`, which is per room by design
 * (init.md: no global mark-all-read).
 *
 * So the two have to be reconciled, and there is exactly one place it happens:
 * the organization plugin's hooks, wired in `org.ts`. Joining a workspace puts
 * you in its rooms; creating a workspace creates the room you land in; **being
 * removed from a workspace takes the rooms away again, and being demoted takes
 * the room role down with it**.
 *
 * ## Two writes, and why ordering was not enough
 *
 * Round 3 said the guarantee here was *direction*: revoke before Better Auth's
 * write, grant after it. That is true and it is not sufficient, which is what
 * codex found in round 3's gauntlet and it was the round's largest finding.
 * Direction is a statement about one role change. Two overlapping role changes
 * on the same member have an interleaving it does not cover:
 *
 * ```
 *   promote member→admin   demote admin→member
 *   before: not a demotion
 *                          before: demotion ⇒ rooms = member
 *   commit role=admin
 *                          commit role=member
 *                          after: rooms = member
 *   after: rooms = admin        ← carrying the value ITS hook captured
 * ```
 *
 * The workspace row says `member`; the room rows say `admin`; the realtime
 * server authorizes from the room rows. Nothing in the ordering rule forbids it,
 * because both changes obeyed the rule.
 *
 * Round 4 removes the ingredient rather than the interleaving: **the sync no
 * longer takes a role.** `syncWorkspaceRoomRoles` reads the role that is
 * *committed* in `workspace_members` and applies that, under a Postgres advisory
 * lock keyed on (workspace, member) held for the read and the write together. So
 * the two reconciliations serialize, each sees the row as it stands when its turn
 * comes, and the last one to run is the one that started after the last commit —
 * which is the value that landed. A hook cannot pass a stale role because a hook
 * cannot pass a role at all.
 *
 * The pre-write demotion survives as `atMost`: "bring the rooms down to at most
 * this, whatever is committed". It only ever lowers, so a partial failure still
 * leaves the benign shape — a workspace member with rooms they can see and
 * cannot administer — and it still cannot grant anything the committed row does
 * not already say.
 *
 * ## What is still not atomic, stated
 *
 * These transactions are ours, opened on our own `Database` handle; Better
 * Auth's workspace write happens in the library's own adapter transaction, and
 * the two are never joined. Nothing here rolls back when that one fails. The
 * advisory lock serializes *our* reconciliations against each other, and reading
 * the committed role is what makes the last one correct regardless of which
 * order the library's writes landed in. It is not a distributed transaction and
 * this file cannot give you one.
 */

/** The room every new workspace starts with, so nobody arrives at an empty page. */
export const defaultRoomSlug = 'general';
export const defaultRoomName = 'general';

/** What a hook does when it cannot make sense of a role. */
export interface ReconcileLogger {
  warn: (message: string, fields?: Record<string, unknown>) => void;
}

const silent: ReconcileLogger = { warn: () => {} };

/**
 * Workspace role → room role.
 *
 * Round 1 had this as `parseRole(role) ?? 'member'`, which fails **open**: the
 * exact string `authorize()` refuses to act on became a working room grant.
 * Same input, opposite direction, in two files. It now denies — the caller
 * grants nothing and the refusal is logged with `unknownRole`, because a role
 * we cannot read is a bug or an attack and both deserve a line in the log.
 */
export function roomRole(workspaceRole: string, logger: ReconcileLogger = silent): Role | null {
  const role = parseRole(workspaceRole);
  if (!role) {
    logger.warn('refusing to grant room membership for an unrecognised workspace role', {
      unknownRole: true,
      role: workspaceRole,
    });
    return null;
  }
  return role;
}

/**
 * The advisory-lock key for one (workspace, member) pair.
 *
 * Two 32-bit integers rather than one 64-bit one because `pg_advisory_xact_lock`
 * takes that form and it keeps the two ids in separate halves of the space, so a
 * collision needs both halves to collide. FNV-1a because it is short, has no
 * dependencies, and this is a lock key rather than a digest.
 *
 * ## The collision property, stated honestly
 *
 * FNV-1a is not collision-resistant and nothing here pretends it is. What
 * matters is **which direction a collision fails in**, and it is the safe one:
 * two different (workspace, member) pairs that hash to the same key pair take
 * *the same* lock, so they serialize against each other. The cost is
 * throughput — two unrelated members briefly queue behind one another — and the
 * cost is never correctness, because the lock is only ever used to make one
 * member's own reads and writes atomic with respect to each other.
 *
 * The failure that *would* matter is the opposite one: two operations on the
 * **same** pair taking **different** locks and therefore not excluding each
 * other. That cannot happen, because the key is a pure function of the two ids
 * and every caller derives it here. An attacker who could choose ids to force a
 * collision would gain a slower workspace and nothing else — there is no path
 * from "these two share a lock" to "this one skipped a lock".
 *
 * Exported so a test can take the *same* lock from a second connection and prove
 * the reconciliation actually waits for it, rather than asserting that a line of
 * SQL is present in the source.
 */
export function memberLockKeys(workspaceId: string, userId: string): [number, number] {
  return [fnv1a(workspaceId), fnv1a(userId)];
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  // `| 0` lands it in signed 32-bit, which is the range Postgres wants.
  return hash | 0;
}

/**
 * How long any of these transactions will wait for a lock before giving up.
 *
 * `pg_advisory_xact_lock` waits forever by default, and "forever" is a real
 * outcome: a holder that stalls — a paused connection, a transaction whose
 * client went away without the server noticing, a query stuck behind something
 * else — hangs *every* subsequent mutation on that member indefinitely. In this
 * package that means a removal, a demotion or an invitation compensation that
 * never returns and never errors, which is the worst shape a failure can take:
 * the caller's request hangs, nothing is logged, and nothing has happened.
 *
 * Five seconds. Long enough that ordinary contention (these transactions are
 * three statements) never trips it, short enough that a stall surfaces as a
 * failed request an operator can see.
 *
 * Deliberately a constant and not a setting. Postgres reads `lock_timeout = 0`
 * as *disabled*, so a knob here would ship with a value that restores the hang
 * — the same reason `WS_SWEEP_INTERVAL_MS` has a floor rather than an "off".
 *
 * `SET LOCAL` scopes it to this transaction, so it is reverted on commit or
 * rollback and never leaks to the next user of a pooled connection.
 */
export const memberLockTimeoutMs = 5_000;

/** Postgres `lock_not_available`, which is what `lock_timeout` raises. */
const lockTimeoutSqlState = '55P03';

/**
 * A stalled lock holder, named rather than surfaced as a raw driver error.
 *
 * The hooks in `org.ts` already treat a thrown error as "this mutation did not
 * happen" and fail closed on it. This only makes the reason legible in a log.
 */
export class MemberLockTimeoutError extends Error {
  constructor(workspaceId: string, userId: string) {
    super(
      `timed out after ${memberLockTimeoutMs}ms waiting for the (workspace, member) ` +
        `lock on ${workspaceId}/${userId}. Another transaction is holding it; nothing ` +
        'was changed. If this recurs, look for a stalled connection in pg_stat_activity ' +
        '— see memberLockTimeoutMs in packages/auth/src/workspace.ts.',
    );
    this.name = 'MemberLockTimeoutError';
  }
}

/**
 * Walks the `cause` chain, because drizzle wraps.
 *
 * Measured rather than assumed: drizzle-orm 0.45 rethrows a failed statement as
 * a `DrizzleQueryError` whose `name` is the plain `'Error'` and which carries no
 * `code` of its own — the postgres-js `PostgresError` with `code: '55P03'` is
 * one `cause` down. A check that only looked at the top-level error would
 * silently never match, which is how a guard becomes decoration. The chain is
 * bounded so a self-referential `cause` cannot spin.
 */
function isLockTimeout(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth += 1) {
    if ((current as { code?: unknown }).code === lockTimeoutSqlState) return true;
    const next: unknown = (current as { cause?: unknown }).cause;
    if (next === current) return false;
    current = next;
  }
  return false;
}

/**
 * Anything that touches one member's room rows runs inside this.
 *
 * A transaction-scoped advisory lock: taken here, released by the commit or
 * rollback, never leaked by a thrown error or a connection returned to the pool
 * still holding it. That last property is why it is `_xact_` and not the
 * session-scoped form — with a pool, "the same session" is not something a
 * caller can promise.
 *
 * `lock_timeout` is set first, so the wait is bounded (see above). It bounds
 * *every* lock this transaction waits for, not only the advisory one — a row
 * lock held on `workspace_members` by somebody else counts too, which is the
 * right answer for the same reason.
 */
async function withMemberLock<T>(
  db: Database,
  workspaceId: string,
  userId: string,
  body: (tx: Database) => Promise<T>,
): Promise<T> {
  const [first, second] = memberLockKeys(workspaceId, userId);
  try {
    return await db.transaction(async (tx) => {
      // `sql.raw`, because SET takes no bind parameters. The value is a module
      // constant that is never derived from input.
      await tx.execute(sql.raw(`set local lock_timeout = ${memberLockTimeoutMs}`));
      await tx.execute(sql`select pg_advisory_xact_lock(${first}, ${second})`);
      return body(tx as unknown as Database);
    });
  } catch (error) {
    if (isLockTimeout(error)) throw new MemberLockTimeoutError(workspaceId, userId);
    throw error;
  }
}

/** The committed workspace role, read inside whatever transaction is passed. */
async function committedRole(
  tx: Database,
  workspaceId: string,
  userId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.organizationId, workspaceId), eq(workspaceMembers.userId, userId)),
    )
    .limit(1);
  return row?.role ?? null;
}

/** Every room of a workspace, archived ones included. */
async function workspaceRoomIds(tx: Database, workspaceId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: rooms.id })
    .from(rooms)
    .where(eq(rooms.workspaceId, workspaceId));
  return rows.map((room) => room.id);
}

/**
 * Take a user's membership of a given set of rooms away, and say how many rows
 * moved.
 *
 * One function rather than three copies of the same `delete … returning`,
 * because three copies are three chances for one of them to grow a `WHERE`
 * clause the others do not have. Every caller is already inside the member
 * lock; this does not take it, so it cannot be used to write outside one by
 * accident.
 */
async function deleteRoomMemberships(
  tx: Database,
  userId: string,
  roomIds: readonly string[],
): Promise<number> {
  if (roomIds.length === 0) return 0;
  const deleted = await tx
    .delete(memberships)
    .where(and(eq(memberships.userId, userId), inArray(memberships.roomId, [...roomIds])))
    .returning({ id: memberships.id });
  return deleted.length;
}

export interface RoomGrantInput {
  workspaceId: string;
  userId: string;
  role: string;
}

/**
 * Creates the workspace's first room and puts its creator in it.
 *
 * Returns false when the role could not be read: the room is still created (a
 * workspace with no room is a dead end) but nobody is granted membership of it,
 * which is the fail-closed direction.
 *
 * **Under the member lock**, like every other room-membership write in this
 * file. Round 4 left it outside on the argument that `afterCreateOrganization`
 * runs on a workspace with exactly one member and nothing to race with — which
 * is true today and is an argument about a *caller*, not about this function.
 * Codex's round-4 delta was right to flag it: the rule worth having is "every
 * write to `memberships` for one member happens under that member's lock", and
 * a rule with one documented exception is a rule the next caller has to
 * re-derive. It costs one advisory lock nobody is contending for.
 *
 * `role` is the creator role the library just wrote; there is no committed read
 * here because the member row is the library's and may not be visible yet.
 */
export async function createDefaultRoom(
  db: Database,
  input: RoomGrantInput,
  logger: ReconcileLogger = silent,
): Promise<boolean> {
  const role = roomRole(input.role, logger);

  return withMemberLock(db, input.workspaceId, input.userId, async (tx) => {
    const [room] = await tx
      .insert(rooms)
      .values({
        workspaceId: input.workspaceId,
        slug: defaultRoomSlug,
        name: defaultRoomName,
        createdBy: input.userId,
      })
      .onConflictDoNothing({ target: [rooms.workspaceId, rooms.slug] })
      .returning({ id: rooms.id });

    if (!room || !role) return false;

    await tx
      .insert(memberships)
      .values({ roomId: room.id, userId: input.userId, role })
      .onConflictDoNothing({ target: [memberships.roomId, memberships.userId] });
    return true;
  });
}

/**
 * Puts a user into every live room of a workspace.
 *
 * Called when an invitation is accepted. Per-room invitations are a later
 * concern; today a workspace member can see the workspace's rooms, which is what
 * the acceptance test means by "lands in the shared room".
 *
 * Under the member lock, and **capped by the committed workspace role**: an
 * acceptance that overlaps a demotion must not hand out the role the invitation
 * was minted with after the demotion has already run.
 *
 * ## No member row is a refusal, not a fallback
 *
 * Round 4 read a missing committed role as "the library has not committed yet,
 * so use the role I was given". That was wrong in the direction that costs
 * something, and it is the second half of codex's round-4 major finding. The
 * ordering is the other way round — Better Auth's `accept-invitation` endpoint
 * awaits its own transaction and *then* calls `afterAcceptInvitation`
 * (`routes/crud-invites.mjs`), so a member row that is not visible here has not
 * merely not landed: it is gone, or was never there. The case that produces it
 * is the compensation race below — `revokeAcceptedInvitation` removing the
 * member while an acceptance is in flight — and granting rooms to somebody with
 * no workspace membership is exactly the residue the compensation exists to
 * prevent.
 *
 * So it grants nothing and says why. `syncWorkspaceRoomRoles` already reads a
 * missing member row as the strongest revocation there is; this now agrees with
 * it instead of reading the same absence the opposite way.
 */
export async function joinWorkspaceRooms(
  db: Database,
  input: RoomGrantInput,
  logger: ReconcileLogger = silent,
): Promise<number> {
  return withMemberLock(db, input.workspaceId, input.userId, async (tx) => {
    const committed = await committedRole(tx, input.workspaceId, input.userId);
    if (committed === null) {
      logger.warn('refusing to grant room membership: no workspace member row', {
        noMemberRow: true,
        workspaceId: input.workspaceId,
        userId: input.userId,
      });
      return 0;
    }

    const role = roomRole(lowerOf(input.role, committed), logger);
    if (!role) return 0;

    const live = await tx
      .select({ id: rooms.id })
      .from(rooms)
      .where(and(eq(rooms.workspaceId, input.workspaceId), isNull(rooms.archivedAt)));

    if (live.length === 0) return 0;

    await tx
      .insert(memberships)
      .values(live.map((room) => ({ roomId: room.id, userId: input.userId, role })))
      .onConflictDoNothing({ target: [memberships.roomId, memberships.userId] });

    return live.length;
  });
}

/**
 * Takes every room of a workspace away from a user.
 *
 * Called when workspace membership ends — removal, or the member leaving. The
 * realtime server authorizes each command against `memberships`, so deleting
 * these rows is what actually ends their access; the live socket notices on its
 * next command or within one sweep.
 *
 * Archived rooms are included: an archived room can be un-archived, and a row
 * left behind would silently restore access when it was.
 *
 * Under the same lock as the sync, so a removal and a role change on the same
 * member cannot interleave halfway.
 */
export async function revokeWorkspaceRooms(
  db: Database,
  input: { workspaceId: string; userId: string },
): Promise<number> {
  return withMemberLock(db, input.workspaceId, input.userId, async (tx) => {
    const roomIds = await workspaceRoomIds(tx, input.workspaceId);
    return deleteRoomMemberships(tx, input.userId, roomIds);
  });
}

export interface SyncRoomRolesInput {
  workspaceId: string;
  userId: string;
  /**
   * A ceiling, for the pre-write demotion. The applied role is the *lower* of
   * this and whatever is committed, so the hook can lower a member's rooms
   * before the library's write lands without ever being able to raise them.
   * Omitted, the committed role is applied as it stands.
   */
  atMost?: string;
}

/**
 * Brings a user's room roles in line with the **committed** workspace role.
 *
 * The whole of blocking finding 1 lives in that one word. Round 3 took the role
 * from the hook's payload, which is a value captured before somebody else's
 * change may have committed; two overlapping changes could therefore leave the
 * room rows carrying the loser's role (the interleaving is drawn at the top of
 * this file). This reads the row instead, holds the member lock across the read
 * and the write, and applies what it read.
 *
 * A committed role that is missing (the member was removed) or unreadable
 * revokes room membership outright rather than guessing — the same fail-closed
 * direction as everywhere else in this file.
 *
 * Returns the role it applied and how many room rows moved, so a caller can log
 * what actually happened rather than what it asked for.
 */
export async function syncWorkspaceRoomRoles(
  db: Database,
  input: SyncRoomRolesInput,
  logger: ReconcileLogger = silent,
): Promise<{ role: Role | null; updated: number }> {
  return withMemberLock(db, input.workspaceId, input.userId, async (tx) => {
    const committed = await committedRole(tx, input.workspaceId, input.userId);
    const roomIds = await workspaceRoomIds(tx, input.workspaceId);

    // No member row is not "leave them as they are": it is "they are not in this
    // workspace", which is the strongest revocation there is.
    const applied =
      committed === null
        ? null
        : roomRole(
            input.atMost === undefined ? committed : lowerOf(committed, input.atMost),
            logger,
          );

    if (roomIds.length === 0) return { role: applied, updated: 0 };

    if (applied === null) {
      return { role: null, updated: await deleteRoomMemberships(tx, input.userId, roomIds) };
    }

    const updated = await tx
      .update(memberships)
      .set({ role: applied })
      .where(and(eq(memberships.userId, input.userId), inArray(memberships.roomId, roomIds)))
      .returning({ id: memberships.id });

    return { role: applied, updated: updated.length };
  });
}

/**
 * The lower authority of two role strings.
 *
 * An unreadable role on either side wins, because "I cannot read this" resolves
 * downward everywhere else in this package and a ceiling that fails upward is
 * not a ceiling.
 */
export function lowerOf(left: string, right: string): string {
  const a = parseRole(left);
  const b = parseRole(right);
  if (!a) return left;
  if (!b) return right;
  return roleRank(a) <= roleRank(b) ? left : right;
}

/** What `voidInvitation` found when it went to compensate. */
export type InvitationVoidOutcome =
  /** Moved out of `pending`. The link is inert whoever holds it. */
  | { outcome: 'voided' }
  /** No such row in this workspace. Nothing to compensate and nothing to grant. */
  | { outcome: 'missing' }
  /** Already `canceled`/`rejected`. Inert already; nothing to do. */
  | { outcome: 'already-inert'; status: string }
  /**
   * Somebody accepted it in the gap. Cancelling is not available — the row is
   * out of `pending` and a member row exists. This is the state round 3's
   * compensation could not reach, and `revokeAcceptedInvitation` is what reaches
   * it.
   */
  | { outcome: 'accepted'; email: string };

/**
 * Moves a pending invitation to `canceled`, so it can never be accepted.
 *
 * The compensating write behind `afterCreateInvitation` — the inviter's
 * authority is re-checked once the row exists, and an invitation minted in the
 * gap by somebody who has since lost that authority is voided here. Better Auth
 * accepts only from `pending`, so this is what makes an already-emailed link
 * inert.
 *
 * Conditional on the row still being `pending`, and — new in round 4 — it says
 * *why* when the update hits nothing. Round 3 returned a bare `false`, which
 * collapsed "there is no such invitation" and "somebody already accepted it,
 * they are a member now, and their room rows exist" into the same non-answer.
 * The second one is a race with consequences and it needs a different next step.
 */
export async function voidInvitation(
  db: Database,
  input: { invitationId: string; workspaceId: string },
): Promise<InvitationVoidOutcome> {
  return db.transaction(async (tx) => {
    const voided = await tx
      .update(workspaceInvitations)
      .set({ status: 'canceled' })
      .where(
        and(
          eq(workspaceInvitations.id, input.invitationId),
          eq(workspaceInvitations.organizationId, input.workspaceId),
          eq(workspaceInvitations.status, 'pending'),
        ),
      )
      .returning({ id: workspaceInvitations.id });

    if (voided.length > 0) return { outcome: 'voided' };

    const [row] = await tx
      .select({ status: workspaceInvitations.status, email: workspaceInvitations.email })
      .from(workspaceInvitations)
      .where(
        and(
          eq(workspaceInvitations.id, input.invitationId),
          eq(workspaceInvitations.organizationId, input.workspaceId),
        ),
      )
      .limit(1);

    if (!row) return { outcome: 'missing' };
    if (row.status === 'accepted') return { outcome: 'accepted', email: row.email };
    return { outcome: 'already-inert', status: row.status };
  });
}

/**
 * Undo an invitation that was accepted before it could be voided.
 *
 * Round 3 compensated the *pending row* and nothing else, so the one ordering
 * that actually matters — invitation created, inviter demoted, invitee accepts,
 * compensation arrives — left an elevated member and their room rows in place
 * and threw an error at the inviter about it. Codex found it; this is the state
 * the compensation now reaches.
 *
 * ## One transaction, one lock, both writes
 *
 * Round 4 called `revokeWorkspaceRooms` and then deleted the member row — two
 * statements, and therefore two transactions, and therefore a window. Codex's
 * round-4 delta walked it: the room revocation commits and **releases the
 * member lock**, and a concurrent `afterAcceptInvitation → joinWorkspaceRooms`
 * takes that lock while `workspace_members` still has the row it reads,
 * inserts room membership, and finishes. The compensator's next statement then
 * deletes only the workspace row. Final state: no workspace membership,
 * retained room access — precisely the residue this function exists to remove,
 * reached *through* the function.
 *
 * Both writes are now one transaction under one acquisition of the lock. The
 * room rows still go first (they are what the realtime server reads, so a
 * failure part-way leaves the benign shape), but "first" is now an ordering
 * inside a transaction rather than across two. An acceptance that overlaps this
 * either completes entirely before it — and is undone by it — or waits for the
 * lock and then finds no member row, which `joinWorkspaceRooms` reads as a
 * refusal rather than a fallback. There is no third schedule.
 *
 * The invitation itself is left `accepted`, which is the truth about what
 * happened — it was accepted, and then undone.
 *
 * Scoped by the invited address and the workspace. `removed: false` with no
 * matching user means the acceptance had not landed a member row after all,
 * which is a compensation that hit nothing rather than one that failed.
 *
 * The user lookup stays outside, because it is a read of a table this lock does
 * not cover and the lock key needs its result. A user id is immutable once
 * minted, so nothing about it can change under us.
 */
export async function revokeAcceptedInvitation(
  db: Database,
  input: { workspaceId: string; email: string },
): Promise<{ removed: boolean; rooms: number }> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);
  if (!user) return { removed: false, rooms: 0 };

  return withMemberLock(db, input.workspaceId, user.id, async (tx) => {
    const roomIds = await workspaceRoomIds(tx, input.workspaceId);
    const revokedRooms = await deleteRoomMemberships(tx, user.id, roomIds);

    const deleted = await tx
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.organizationId, input.workspaceId),
          eq(workspaceMembers.userId, user.id),
        ),
      )
      .returning({ id: workspaceMembers.id });

    return { removed: deleted.length > 0, rooms: revokedRooms };
  });
}

/** The caller's workspace role, straight from Better Auth's own member table. */
export async function loadWorkspaceMemberRole(
  db: Database,
  input: { workspaceId: string; userId: string },
): Promise<string | null> {
  return committedRole(db, input.workspaceId, input.userId);
}
