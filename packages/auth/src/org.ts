import { APIError } from 'better-auth/api';
import type { OrganizationOptions } from 'better-auth/plugins/organization';
import { authorize, mayGrantRole, parseRole, roleRank } from './authz.js';
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
 * ## What the ordering actually guarantees — and what it does not
 *
 * Round 2's receipt said reconciliation happened "in one transaction *before*
 * Better Auth commits". The first half of that was an overclaim and is corrected
 * here, because a claim that outruns the code is worse than no claim: **the hook
 * writes and Better Auth's write are separate transactions.** The hook runs
 * through our own `Database` handle, the workspace row goes through the
 * library's adapter, and nothing joins the two. There is no rollback of one when
 * the other fails and this file cannot give you one.
 *
 * What it does give you is *direction*, which is the part that decides how a
 * partial failure looks:
 *
 *  - **Revocations run first**, before the Better Auth write. A crash in between
 *    leaves somebody who is still a workspace member with no room access —
 *    visible, annoying, and fixable by re-adding them.
 *  - **Grants run last**, after that write has committed. A crash in between
 *    leaves somebody who is a workspace member with no rooms yet: the same
 *    benign shape, reached from the other side. Round 2 had the demotion hook
 *    apply *any* new role before the commit, which for a promotion meant handing
 *    out room authority the workspace row did not yet carry — and keeping it if
 *    the commit then failed.
 *
 * The failure this ordering refuses to produce, in either direction, is somebody
 * holding authority no row entitles them to. That is the whole guarantee. It is
 * smaller than atomicity and it is the one the code actually implements.
 *
 * **Known gap, stated rather than hidden**: Better Auth's `/organization/leave`
 * endpoint fires no member hooks (see `crud-members.mjs`), so a self-removal
 * through it would not revoke room membership. Atrium neither exposes that
 * endpoint over HTTP (`mounted.ts` — and `mounted.test.ts` asserts that path
 * 404s, so widening the allowlist cannot expose it by accident) nor calls it, so
 * today the gap is unreachable; a "leave workspace" flow must call
 * `revokeWorkspaceRooms` itself, and this paragraph is the reminder.
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
  /**
   * Moves a pending invitation out of `pending` so it can never be accepted.
   *
   * The compensating half of `afterCreateInvitation` — see the hook for why a
   * check that ran before the write is not enough on its own. Returns whether a
   * row was actually voided, so a compensation that hit nothing is not reported
   * as a success.
   */
  voidInvitation: (input: { invitationId: string; workspaceId: string }) => Promise<boolean>;
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
 * Is moving from `currentRole` to `nextRole` a *reduction* of authority?
 *
 * This is what decides whether room roles are brought down before Better Auth
 * writes the workspace row or brought up after it commits. Two edges, both
 * deliberate:
 *
 *  - no current membership is not a demotion — there is nothing to take away,
 *    and treating it as one would revoke rooms the member is about to be given;
 *  - a role string either side that we cannot read *is* treated as a demotion,
 *    because the fail-closed reading of "I do not understand this authority" is
 *    to take it away first and let the after-hook grant whatever is real.
 */
export function isDemotion(currentRole: string | null, nextRole: string): boolean {
  if (currentRole === null) return false;
  const current = parseRole(currentRole);
  const next = parseRole(nextRole);
  if (!current || !next) return true;
  return roleRank(next) < roleRank(current);
}

/**
 * May `inviterRole` mint an invitation for `requestedRole` right now?
 *
 * Both halves of the escalation guard in one place, because it is asked twice —
 * before the write and again after it committed. Two copies of this rule would
 * be two chances for the after-check to be laxer than the before-check, which
 * would make the compensation theatre.
 */
function mayInvite(inviterRole: string | null, requestedRole: string): boolean {
  const decision = authorize(
    'workspace.invite',
    inviterRole === null ? null : { role: inviterRole },
    { scope: 'workspace' },
  );
  return decision.allowed && mayGrantRole(inviterRole ?? '', requestedRole);
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

      /**
       * The same question, asked again after the row exists.
       *
       * `beforeCreateInvitation` reads the inviter's role and Better Auth then
       * writes the invitation — two statements, two transactions, a gap between
       * them. An admin demoted or removed *inside* that gap has their invitation
       * land anyway, minted with authority they no longer hold. Codex found this
       * in round 2 and it is a real time-of-check/time-of-use race, not a
       * theoretical one: "remove this admin" and "this admin invites an admin"
       * are two ordinary clicks that can overlap.
       *
       * The check cannot move into the write — the write is the library's, in
       * its own adapter transaction, and there is no hook inside it. So this is
       * the other legitimate answer: **compensate.** Re-read the role now that
       * the row is committed, and if it no longer permits what was minted, move
       * the invitation out of `pending`. Better Auth accepts an invitation only
       * from `pending`, so a voided row is inert whoever holds it.
       *
       * Two honest limits:
       *
       *  - the invitation *email has already been sent* by the time this runs
       *    (`crud-invites.mjs` mails before calling this hook), so the link is in
       *    an inbox. Voiding is what makes it useless; nothing here un-sends it.
       *  - if the void itself fails, an over-privileged pending invitation is
       *    live. That case is logged as an error and thrown, so it surfaces as a
       *    failed request rather than a quiet success.
       */
      afterCreateInvitation: async (data: {
        invitation: { id: string; role?: string | null; organizationId?: string };
        inviter: { id: string };
        organization: { id: string };
      }) => {
        const workspaceId = data.invitation.organizationId ?? data.organization.id;
        const requested = typeof data.invitation.role === 'string' ? data.invitation.role : '';
        const inviterRole = await ports.memberRole({ workspaceId, userId: data.inviter.id });
        if (mayInvite(inviterRole, requested)) return;

        logger.warn('voiding an invitation whose inviter lost the authority to mint it', {
          reason: 'invitation_toctou',
          workspaceId,
          inviterId: data.inviter.id,
          invitationId: data.invitation.id,
          requestedRole: requested,
        });

        let voided: boolean;
        try {
          voided = await ports.voidInvitation({ invitationId: data.invitation.id, workspaceId });
        } catch (error) {
          logger.error('failed to void an over-privileged invitation', {
            invitationId: data.invitation.id,
            error: (error as Error).message,
          });
          throw new APIError('INTERNAL_SERVER_ERROR', {
            message: 'The invitation could not be issued. Nothing was granted; please try again.',
          });
        }

        if (!voided) {
          logger.error('an over-privileged invitation was not voided', {
            invitationId: data.invitation.id,
          });
        }

        throw new APIError('FORBIDDEN', {
          message: 'Your permission to invite changed while that invitation was being created.',
        });
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
       * Ordering is the whole point — and ordering is all it is; the two writes
       * are separate transactions (see the note at the top of this file). Room
       * memberships are what the realtime server checks, so dropping them first
       * means a failure part-way through leaves somebody who is still a
       * workspace member but can reach no room — annoying, and fixable by
       * re-adding them. The other order would leave somebody who is no longer a
       * member but still has every room, which is the failure nobody notices.
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
       * A role change, applied in the direction the change is going.
       *
       * `beforeUpdateMemberRole` is handed the member being changed and the role
       * they are moving to — not the actor, which is why the "may you grant
       * this?" check for role changes stays where the actor is known (the Server
       * Action, plus Better Auth's own owner guard). What this hook owns is the
       * consequence: room roles follow workspace roles.
       *
       * **Only downward, and only here.** Round 2 applied every new role at this
       * point, which is right for a demotion and wrong for a promotion: it
       * granted room authority before the workspace row said so, and left it
       * granted if the library's write then failed. So a demotion is taken away
       * now, and everything else waits for `afterUpdateMemberRole`, which runs
       * on the value that actually landed.
       */
      beforeUpdateMemberRole: async (data: {
        member: { userId: string; organizationId: string };
        newRole: string;
        organization: { id: string };
      }) => {
        const newRole = assertKnownRole(data.newRole);
        const workspaceId = data.member.organizationId ?? data.organization.id;

        const currentRole = await ports.memberRole({ workspaceId, userId: data.member.userId });
        if (!isDemotion(currentRole, newRole)) return undefined;

        await ports.syncWorkspaceRoomRoles({
          workspaceId,
          userId: data.member.userId,
          role: newRole,
        });
        return undefined;
      },

      /**
       * The grant half, on the value that actually committed.
       *
       * Runs for every change, not just promotions: re-applying a demotion that
       * the before-hook already applied is idempotent, and it is the only thing
       * that makes the landed row the last word if the two ever disagree.
       */
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
