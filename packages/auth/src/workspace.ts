import { type Database, memberships, rooms } from '@atrium/db';
import { and, eq, isNull } from 'drizzle-orm';
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
 * the organization plugin's hooks, wired in `auth.ts`. Joining a workspace puts
 * you in its rooms; creating a workspace creates the room you land in.
 */

/** The room every new workspace starts with, so nobody arrives at an empty page. */
export const defaultRoomSlug = 'general';
export const defaultRoomName = 'general';

/**
 * Workspace role → room role. They use the same three names, but the mapping is
 * written out rather than cast: an unrecognised workspace role becomes a plain
 * `member` in the room, which is the safe direction to fail.
 */
function roomRole(workspaceRole: string): Role {
  return parseRole(workspaceRole) ?? 'member';
}

/** Creates the workspace's first room and puts its creator in it. */
export async function createDefaultRoom(
  db: Database,
  input: { workspaceId: string; userId: string; role: string },
): Promise<void> {
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

  if (!room) return;

  await db
    .insert(memberships)
    .values({ roomId: room.id, userId: input.userId, role: roomRole(input.role) })
    .onConflictDoNothing({ target: [memberships.roomId, memberships.userId] });
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
  input: { workspaceId: string; userId: string; role: string },
): Promise<number> {
  const live = await db
    .select({ id: rooms.id })
    .from(rooms)
    .where(and(eq(rooms.workspaceId, input.workspaceId), isNull(rooms.archivedAt)));

  if (live.length === 0) return 0;

  const role = roomRole(input.role);
  await db
    .insert(memberships)
    .values(live.map((room) => ({ roomId: room.id, userId: input.userId, role })))
    .onConflictDoNothing({ target: [memberships.roomId, memberships.userId] });

  return live.length;
}
