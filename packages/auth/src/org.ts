import { APIError } from 'better-auth/api';
import type { OrganizationOptions } from 'better-auth/plugins/organization';
import { authorize, mayGrantRole, parseRole } from './authz.js';
import type { Mailer } from './mailer.js';

/**
 * The organization plugin's configuration, and the authorization that has to
 * live *inside* it.
 *
 * Round 1 of this ticket's review landed the same finding from two independent
 * critics, and it was correct: policy that only exists in a Server Action is
 * decorative, because the library it calls also answers HTTP. Two locks were
 * missing and both are fitted now.
 *
 *  1. `mounted.ts` stops the organization API being reachable over HTTP at all.
 *  2. **This file** enforces the policy at the point of the write, so it holds
 *     for every caller — the Server Action, a future admin CLI, a route we
 *     mount later, and Better Auth's own endpoints if any of them are ever
 *     exposed again. `beforeCreateInvitation` refuses to mint an invitation for
 *     a role the inviter does not themselves hold, which is the specific
 *     escalation the reviewers demonstrated: an admin inviting an `owner`.
 *
 * Both locks are load-bearing on purpose. Better Auth 1.6.x happens to refuse
 * that particular escalation itself (`crud-invites.mjs` compares the invited
 * role against `creatorRole`), but a guarantee that lives only in a dependency's
 * changelog is a guarantee we do not have. The hooks below are ours.
 *
 * The hooks take their database access as ports rather than a `Database`, so
 * the policy can be tested for what it decides instead of for what Postgres
 * does. `atriumOrganizationPorts()` in `auth.ts` supplies the real ones.
 *
 * **Known gap, stated rather than hidden**: Better Auth's `/organization/leave`
 * endpoint fires no member hooks (see `crud-members.mjs`), so a self-removal
 * through it would not revoke room membership. Atrium neither exposes that
 * endpoint over HTTP (`mounted.ts`) nor calls it, so today the gap is
 * unreachable; a "leave workspace" flow must call `revokeWorkspaceRooms`
 * itself, and this paragraph is the reminder.
 */

/** Everything the hooks need from the outside world. */
export interface OrganizationPorts {
  /** The role a user holds in a workspace, or null if they are not a member. */
  memberRole: (input: { workspaceId: string; userId: string }) => Promise<string | null>;
  /** Creates the workspace's first room and grants its creator membership. */
  createDefaultRoom: (input: {
    workspaceId: string;
    userId: string;
    role: string;
  }) => Promise<unknown>;
  /** Grants membership of every live room in a workspace. */
  joinWorkspaceRooms: (input: {
    workspaceId: string;
    userId: string;
    role: string;
  }) => Promise<unknown>;
  /** Removes every room membership a user holds in a workspace. */
  revokeWorkspaceRooms: (input: { workspaceId: string; userId: string }) => Promise<unknown>;
  /** Brings a user's room roles in line with a new workspace role. */
  syncWorkspaceRoomRoles: (input: {
    workspaceId: string;
    userId: string;
    role: string;
  }) => Promise<unknown>;
}

export interface OrganizationLogger {
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
}

export interface OrganizationOptionsInput {
  ports: OrganizationPorts;
  /** Public origin of the web app; invitation links are built against it. */
  baseURL: string;
  mailer: Mailer;
  /** The model/field remapping from `@atrium/db` (`organizationSchemaOptions`). */
  schema: OrganizationOptions['schema'];
  logger?: OrganizationLogger;
}

const noopLogger: OrganizationLogger = { warn: () => {}, error: () => {} };

/**
 * Refuse a role string that is not exactly one role we know.
 *
 * Better Auth accepts `role` as a string or an array and stores the result as a
 * comma-separated list. Atrium has three roles and no notion of holding two at
 * once, so anything else — an unknown name, a list, an empty string — is
 * rejected rather than parsed into whichever component looks most familiar.
 */
export function assertKnownRole(raw: unknown): string {
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  if (typeof value !== 'string' || parseRole(value) === null) {
    throw new APIError('BAD_REQUEST', {
      message: 'Unknown role. Atrium workspaces have exactly three: owner, admin, member.',
    });
  }
  return value;
}

/**
 * The organization plugin's options, hooks included.
 *
 * Exported separately from `createAtriumAuth` so the hooks can be exercised
 * directly: `test/org.test.ts` calls `beforeCreateInvitation` with a stub
 * inviter and asserts the escalation is refused, which is a test of the
 * authorization decision rather than of Better Auth's routing.
 */
export function atriumOrganizationOptions(input: OrganizationOptionsInput) {
  const { ports, baseURL, mailer, schema } = input;
  const logger = input.logger ?? noopLogger;

  return {
    schema,
    // The person who creates a workspace owns it.
    creatorRole: 'owner',
    // A stale invitation is a smaller problem than an eternal one.
    invitationExpiresIn: 60 * 60 * 48,
    cancelPendingInvitationsOnReInvite: true,
    /**
     * Explicit rather than inherited. Acting on an invitation *by id* has to
     * require a verified address, because an id that leaks — from a log, a
     * shared screen, a members list — would otherwise be enough to join a
     * workspace as somebody who never proved they own the invited mailbox.
     * Atrium refuses unverified sessions everywhere else; this says so here too
     * instead of relying on the library's default staying what it is today.
     */
    requireEmailVerificationOnInvitation: true,

    sendInvitationEmail: async ({
      id,
      email,
      organization: workspace,
      inviter,
    }: {
      id: string;
      email: string;
      organization: { name: string };
      inviter: { user: { name: string; email: string } };
    }) => {
      const link = new URL(`/invite/${id}`, baseURL).toString();
      await mailer({
        kind: 'workspace-invitation',
        to: email,
        subject: `${inviter.user.name} invited you to ${workspace.name} on Atrium`,
        url: link,
        body:
          `${inviter.user.name} (${inviter.user.email}) invited you to join ` +
          `the ${workspace.name} workspace: ${link}`,
      });
    },

    organizationHooks: {
      /**
       * The escalation guard.
       *
       * Two questions, in order, both answered against the database rather than
       * against anything the caller sent: may this person invite at all, and is
       * the role they are handing out one they hold themselves? A missing
       * membership is a denial, not a fallthrough — an inviter with no row is
       * somebody acting on a workspace they do not belong to.
       */
      beforeCreateInvitation: async (data: {
        invitation: { email: string; role: string; organizationId: string; inviterId: string };
        inviter: { id: string };
        organization: { id: string };
      }) => {
        const requested = assertKnownRole(data.invitation.role);
        const inviterRole = await ports.memberRole({
          workspaceId: data.invitation.organizationId,
          userId: data.inviter.id,
        });

        const decision = authorize(
          'workspace.invite',
          inviterRole === null ? null : { role: inviterRole },
          { scope: 'workspace' },
        );
        if (!decision.allowed) {
          logger.warn('invitation refused at the library layer', {
            reason: decision.reason,
            workspaceId: data.invitation.organizationId,
            inviterId: data.inviter.id,
          });
          throw new APIError('FORBIDDEN', {
            message: 'You are not allowed to invite people to this workspace.',
          });
        }

        if (!mayGrantRole(inviterRole ?? '', requested)) {
          logger.warn('invitation refused: role above the inviter’s own', {
            reason: 'role_escalation',
            workspaceId: data.invitation.organizationId,
            inviterId: data.inviter.id,
            requestedRole: requested,
          });
          throw new APIError('FORBIDDEN', {
            message: 'You cannot invite somebody to a role you do not hold yourself.',
          });
        }

        return undefined;
      },

      // A workspace with no room is a dead end for the person who just made it,
      // so the first room is part of creating one.
      afterCreateOrganization: async (data: {
        organization: { id: string };
        member: { userId: string; role: string };
      }) => {
        await ports.createDefaultRoom({
          workspaceId: data.organization.id,
          userId: data.member.userId,
          role: data.member.role,
        });
      },

      // Accepting an invitation has to land the invitee somewhere shared, or
      // "you're in the workspace" is a claim with nothing behind it.
      afterAcceptInvitation: async (data: {
        organization: { id: string };
        member: { userId: string; role: string };
      }) => {
        await ports.joinWorkspaceRooms({
          workspaceId: data.organization.id,
          userId: data.member.userId,
          role: data.member.role,
        });
      },

      /**
       * Removal, revoked *before* the workspace row goes.
       *
       * Ordering is the whole point. Room memberships are what the realtime
       * server checks, so dropping them first means a failure part-way through
       * leaves somebody who is still a workspace member but can reach no room —
       * annoying, and fixable by re-adding them. The other order would leave
       * somebody who is no longer a member but still has every room, which is
       * the failure nobody notices.
       */
      beforeRemoveMember: async (data: {
        member: { userId: string; organizationId: string };
        organization: { id: string };
      }) => {
        await ports.revokeWorkspaceRooms({
          workspaceId: data.member.organizationId ?? data.organization.id,
          userId: data.member.userId,
        });
      },

      /** Again, idempotently: a join racing the removal must not survive it. */
      afterRemoveMember: async (data: {
        member: { userId: string; organizationId: string };
        organization: { id: string };
      }) => {
        try {
          await ports.revokeWorkspaceRooms({
            workspaceId: data.member.organizationId ?? data.organization.id,
            userId: data.member.userId,
          });
        } catch (error) {
          // The membership is already gone; a failed second sweep must not turn
          // a successful removal into an error the caller retries forever.
          logger.error('room revocation sweep failed after member removal', {
            userId: data.member.userId,
            error: (error as Error).message,
          });
        }
      },

      /**
       * Demotion, applied before the workspace role changes.
       *
       * `beforeUpdateMemberRole` is handed the member being changed and the
       * role they are moving to — not the actor, which is why the "may you
       * grant this?" check for role changes stays where the actor is known (the
       * Server Action, plus Better Auth's own owner guard). What this hook owns
       * is the consequence: room roles follow workspace roles, downward first.
       */
      beforeUpdateMemberRole: async (data: {
        member: { userId: string; organizationId: string };
        newRole: string;
        organization: { id: string };
      }) => {
        assertKnownRole(data.newRole);
        await ports.syncWorkspaceRoomRoles({
          workspaceId: data.member.organizationId ?? data.organization.id,
          userId: data.member.userId,
          role: data.newRole,
        });
        return undefined;
      },

      /** And once more with the value that actually landed, for promotions. */
      afterUpdateMemberRole: async (data: {
        member: { userId: string; organizationId: string; role: string };
        organization: { id: string };
      }) => {
        await ports.syncWorkspaceRoomRoles({
          workspaceId: data.member.organizationId ?? data.organization.id,
          userId: data.member.userId,
          role: data.member.role,
        });
      },

      /** Adding a member server-side takes the same role vocabulary. */
      beforeAddMember: async (data: { member: { role: string } }) => {
        assertKnownRole(data.member.role);
        return undefined;
      },
    },
  };
}
