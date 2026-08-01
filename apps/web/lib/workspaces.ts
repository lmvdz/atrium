import 'server-only';
import {
  memberships,
  rooms,
  users,
  workspaceInvitations,
  workspaceMembers,
  workspaces,
} from '@atrium/db';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { db } from './db';

/**
 * Reads of workspace state.
 *
 * Mutations go through Better Auth's API (it owns invitations, membership and
 * the transactional accept), but reads come straight from our own tables — the
 * whole benefit of self-hosting the auth schema is that a page can join against
 * it like any other data instead of round-tripping a service.
 *
 * Every function here takes the caller's `userId` and filters by it. None of
 * them is a general "get workspace by slug": a read that does not take who is
 * asking is a read waiting to be called from somewhere that forgot to check.
 */

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export async function listWorkspacesFor(userId: string): Promise<WorkspaceSummary[]> {
  return db()
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.organizationId, workspaces.id))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaces.name));
}

/** The workspace and the caller's membership of it, or null if they have none. */
export async function loadWorkspace(
  slug: string,
  userId: string,
): Promise<WorkspaceSummary | null> {
  const [row] = await db()
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      role: workspaceMembers.role,
    })
    .from(workspaces)
    .innerJoin(
      workspaceMembers,
      and(eq(workspaceMembers.organizationId, workspaces.id), eq(workspaceMembers.userId, userId)),
    )
    .where(eq(workspaces.slug, slug))
    .limit(1);
  return row ?? null;
}

export interface RoomSummary {
  id: string;
  slug: string;
  name: string;
  role: string;
}

/** Live rooms in a workspace that the caller is actually a member of. */
export async function listRoomsFor(workspaceId: string, userId: string): Promise<RoomSummary[]> {
  return db()
    .select({
      id: rooms.id,
      slug: rooms.slug,
      name: rooms.name,
      role: memberships.role,
    })
    .from(rooms)
    .innerJoin(memberships, and(eq(memberships.roomId, rooms.id), eq(memberships.userId, userId)))
    .where(and(eq(rooms.workspaceId, workspaceId), isNull(rooms.archivedAt)))
    .orderBy(asc(rooms.slug));
}

export async function loadRoom(
  workspaceId: string,
  roomSlug: string,
  userId: string,
): Promise<RoomSummary | null> {
  const [row] = await db()
    .select({
      id: rooms.id,
      slug: rooms.slug,
      name: rooms.name,
      role: memberships.role,
    })
    .from(rooms)
    .innerJoin(memberships, and(eq(memberships.roomId, rooms.id), eq(memberships.userId, userId)))
    .where(
      and(eq(rooms.workspaceId, workspaceId), eq(rooms.slug, roomSlug), isNull(rooms.archivedAt)),
    )
    .limit(1);
  return row ?? null;
}

export interface MemberSummary {
  /** `workspace_members.id` — what Better Auth's member endpoints are keyed by. */
  memberId: string;
  userId: string;
  displayName: string;
  email: string;
  role: string;
}

export async function listMembers(workspaceId: string): Promise<MemberSummary[]> {
  return db()
    .select({
      memberId: workspaceMembers.id,
      userId: users.id,
      displayName: users.displayName,
      email: users.email,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(workspaceMembers.userId, users.id))
    .where(eq(workspaceMembers.organizationId, workspaceId))
    .orderBy(asc(users.displayName));
}

export interface InvitationSummary {
  id: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: Date;
}

export async function listPendingInvitations(workspaceId: string): Promise<InvitationSummary[]> {
  return db()
    .select({
      id: workspaceInvitations.id,
      email: workspaceInvitations.email,
      role: workspaceInvitations.role,
      status: workspaceInvitations.status,
      expiresAt: workspaceInvitations.expiresAt,
    })
    .from(workspaceInvitations)
    .where(
      and(
        eq(workspaceInvitations.organizationId, workspaceId),
        eq(workspaceInvitations.status, 'pending'),
      ),
    )
    .orderBy(desc(workspaceInvitations.createdAt));
}

export interface InvitationDetail {
  id: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: Date;
  workspaceName: string;
  workspaceSlug: string;
}

/**
 * An invitation by id, whatever its state.
 *
 * Deliberately not filtered to `pending`: the invitation page has to be able to
 * say "this link has already been used" rather than "not found", which is the
 * difference between a person understanding what happened and filing a bug.
 */
export async function loadInvitation(id: string): Promise<InvitationDetail | null> {
  const [row] = await db()
    .select({
      id: workspaceInvitations.id,
      email: workspaceInvitations.email,
      role: workspaceInvitations.role,
      status: workspaceInvitations.status,
      expiresAt: workspaceInvitations.expiresAt,
      workspaceName: workspaces.name,
      workspaceSlug: workspaces.slug,
    })
    .from(workspaceInvitations)
    .innerJoin(workspaces, eq(workspaceInvitations.organizationId, workspaces.id))
    .where(eq(workspaceInvitations.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * `Ada's Team` → `adas-team`. Slugs are unique per workspace table, so a
 * collision is a real possibility; the caller appends a discriminator rather
 * than this function guessing.
 */
export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}
