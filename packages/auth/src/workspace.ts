import {
  type Database,
  memberships,
  rooms,
  workspaceInvitations,
  workspaceMembers,
} from '@atrium/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { parseRole, type Role } from './authz.js';

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
 * the room role down with it**. That last pair was missing in round 1: a
 * removed member kept every room membership they had, which is to say removal
 * removed nothing the realtime server could see.
 *
 * Each function below is internally transactional: the rooms it reads and the
 * memberships it writes move together, so reconciliation never half-happens
 * *within* one call.
 *
 * It is worth being exact about what that does **not** mean, because round 2's
 * receipt was not. These transactions are ours, opened on our own `Database`
 * handle; Better Auth's workspace write happens in the library's own adapter
 * transaction, and the two are never joined. Nothing here rolls back when that
 * one fails. The guarantee is the *ordering* `org.ts` imposes — revocations
 * before the library's write, grants after it commits — which bounds a partial
 * failure to "member with no rooms" in both directions, never "no longer a
 * member, still in every room".
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
 */
export async function createDefaultRoom(
  db: Database,
  input: RoomGrantInput,
  logger: ReconcileLogger = silent,
): Promise<boolean> {
  const role = roomRole(input.role, logger);

  const [room] = await db
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

  await db
    .insert(memberships)
    .values({ roomId: room.id, userId: input.userId, role })
    .onConflictDoNothing({ target: [memberships.roomId, memberships.userId] });
  return true;
}

/**
 * Puts a user into every live room of a workspace.
 *
 * Called when an invitation is accepted. Per-room invitations are a later
 * concern; today a workspace member can see the workspace's rooms, which is what
 * the acceptance test means by "lands in the shared room".
 */
export async function joinWorkspaceRooms(
  db: Database,
  input: RoomGrantInput,
  logger: ReconcileLogger = silent,
): Promise<number> {
  const role = roomRole(input.role, logger);
  if (!role) return 0;

  const live = await db
    .select({ id: rooms.id })
    .from(rooms)
    .where(and(eq(rooms.workspaceId, input.workspaceId), isNull(rooms.archivedAt)));

  if (live.length === 0) return 0;

  await db
    .insert(memberships)
    .values(live.map((room) => ({ roomId: room.id, userId: input.userId, role })))
    .onConflictDoNothing({ target: [memberships.roomId, memberships.userId] });

  return live.length;
}

/**
 * Takes every room of a workspace away from a user.
 *
 * Called when workspace membership ends — removal, or the member leaving. The
 * realtime server authorizes each command against `memberships`, so deleting
 * these rows is what actually ends their access; the live socket notices on its
 * next command, which is at most one frame later.
 *
 * Archived rooms are included: an archived room can be un-archived, and a row
 * left behind would silently restore access when it was.
 */
export async function revokeWorkspaceRooms(
  db: Database,
  input: { workspaceId: string; userId: string },
): Promise<number> {
  return db.transaction(async (tx) => {
    const roomIds = await tx
      .select({ id: rooms.id })
      .from(rooms)
      .where(eq(rooms.workspaceId, input.workspaceId));
    if (roomIds.length === 0) return 0;

    const deleted = await tx
      .delete(memberships)
      .where(
        and(
          eq(memberships.userId, input.userId),
          inArray(
            memberships.roomId,
            roomIds.map((room) => room.id),
          ),
        ),
      )
      .returning({ id: memberships.id });

    return deleted.length;
  });
}

/**
 * Brings a user's room roles in line with a new workspace role.
 *
 * Demotion is a revocation: an admin who becomes a member must stop being able
 * to archive the workspace's rooms, and nothing else in the system re-derives
 * room role from workspace role. An unreadable new role revokes room membership
 * outright rather than guessing — the same fail-closed direction as everywhere
 * else in this file.
 */
export async function syncWorkspaceRoomRoles(
  db: Database,
  input: RoomGrantInput,
  logger: ReconcileLogger = silent,
): Promise<number> {
  const role = roomRole(input.role, logger);
  if (!role) return revokeWorkspaceRooms(db, input);

  return db.transaction(async (tx) => {
    const roomIds = await tx
      .select({ id: rooms.id })
      .from(rooms)
      .where(eq(rooms.workspaceId, input.workspaceId));
    if (roomIds.length === 0) return 0;

    const updated = await tx
      .update(memberships)
      .set({ role })
      .where(
        and(
          eq(memberships.userId, input.userId),
          inArray(
            memberships.roomId,
            roomIds.map((room) => room.id),
          ),
        ),
      )
      .returning({ id: memberships.id });

    return updated.length;
  });
}

/**
 * Moves a pending invitation to `canceled`, so it can never be accepted.
 *
 * The compensating write behind `afterCreateInvitation` — the inviter's
 * authority is re-checked once the row exists, and an invitation minted in the
 * gap by somebody who has since lost that authority is voided here. Better Auth
 * accepts only from `pending`, so this is what makes an already-emailed link
 * inert.
 *
 * Conditional on the row still being `pending`, which is what keeps it safe to
 * run against a race: an invitation somebody accepted a millisecond earlier is
 * not dragged back out of `accepted`, and the `false` return says so rather than
 * reporting a compensation that did not happen.
 */
export async function voidInvitation(
  db: Database,
  input: { invitationId: string; workspaceId: string },
): Promise<boolean> {
  const voided = await db
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

  return voided.length > 0;
}

/** The caller's workspace role, straight from Better Auth's own member table. */
export async function loadWorkspaceMemberRole(
  db: Database,
  input: { workspaceId: string; userId: string },
): Promise<string | null> {
  const [row] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.organizationId, input.workspaceId),
        eq(workspaceMembers.userId, input.userId),
      ),
    )
    .limit(1);
  return row?.role ?? null;
}
