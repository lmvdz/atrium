import 'server-only';
import {
  type AuthorizedRoom,
  listAuthorizedRooms,
  loadAuthorizedRoom,
  type PrincipalKind,
  parsePrincipalKind,
} from '@atrium/auth';
import { users, workspaceInvitations, workspaceMembers, workspaces } from '@atrium/db';
import { and, asc, desc, eq } from 'drizzle-orm';
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

/**
 * A room the caller may open, with the authority they hold in it.
 *
 * Both room reads are `@atrium/auth`'s, not this file's. Round 5 wrote them out
 * here as `rooms` joined to `memberships` — the derived table on its own — so
 * every revocation whose cleanup failed kept the room listed and openable. They
 * now join `workspace_members` and cap the role at the workspace role, and they
 * live next to the realtime server's copy of the same question because two
 * copies of an authorization predicate is how one of them ends up wrong. The
 * argument in full is at the top of `packages/auth/src/room-access.ts`.
 */
export type RoomSummary = AuthorizedRoom;

/** Live rooms in a workspace that the caller is actually a member of. */
export async function listRoomsFor(workspaceId: string, userId: string): Promise<RoomSummary[]> {
  return listAuthorizedRooms(db(), workspaceId, userId);
}

export async function loadRoom(
  workspaceId: string,
  roomSlug: string,
  userId: string,
): Promise<RoomSummary | null> {
  return loadAuthorizedRoom(db(), workspaceId, roomSlug, userId);
}

export interface MemberSummary {
  /** `workspace_members.id` — what Better Auth's member endpoints are keyed by. */
  memberId: string;
  userId: string;
  displayName: string;
  email: string;
  /**
   * What the identity IS. An agent member has an `email` — `users.email` is NOT
   * NULL and it is keyed by one — but the address is a non-deliverable
   * placeholder the deployment owns, so the People list reads the kind and shows
   * the register instead of an address that looks like a way to reach a person.
   */
  principalKind: PrincipalKind;
  role: string;
}

export async function listMembers(workspaceId: string): Promise<MemberSummary[]> {
  const rows = await db()
    .select({
      memberId: workspaceMembers.id,
      userId: users.id,
      displayName: users.displayName,
      email: users.email,
      principalKind: users.principalKind,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(workspaceMembers.userId, users.id))
    .where(eq(workspaceMembers.organizationId, workspaceId))
    .orderBy(asc(users.displayName));
  return rows.map((row) => ({
    ...row,
    // An allowlist off the stored column, defaulting to human — a People row is
    // display, and the gates that must fail closed are elsewhere.
    principalKind: parsePrincipalKind(row.principalKind) ?? 'human',
  }));
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
