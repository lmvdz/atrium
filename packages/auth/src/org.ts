import { APIError } from 'better-auth/api';
import type { OrganizationOptions } from 'better-auth/plugins/organization';
import { authorize, mayGrantRole, parseRole, roleRank } from './authz.js';
import type { Mailer } from './mailer.js';
import type { InvitationVoidOutcome } from './workspace.js';

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
  /**
   * Brings a user's room roles in line with the role that is **committed** in
   * `workspace_members`, serialized per (workspace, member).
   *
   * Note what is not in the signature: a role. That is the whole of blocking
   * finding 1 from round 3's gauntlet — a hook that can pass a role can pass a
   * *stale* role, and two overlapping role changes then leave the room rows
   * carrying whichever hook happened to finish last rather than whichever write
   * landed last. `atMost` is a ceiling, not a value: it lets the pre-write
   * demotion lower the rooms early without being able to raise them.
   */
  syncWorkspaceRoomRoles: (input: {
    workspaceId: string;
    userId: string;
    atMost?: string;
  }) => Promise<unknown>;
  /**
   * Moves a pending invitation out of `pending` so it can never be accepted.
   *
   * The compensating half of `afterCreateInvitation` — see the hook for why a
   * check that ran before the write is not enough on its own. Reports *what it
   * found*, not just whether it worked: round 3 returned a bare boolean, which
   * made "no such invitation" and "somebody accepted it a millisecond ago and is
   * now an over-privileged member" the same answer.
   */
  voidInvitation: (input: {
    invitationId: string;
    workspaceId: string;
  }) => Promise<InvitationVoidOutcome>;
  /**
   * Undoes an acceptance that beat the compensation: room rows first, then the
   * workspace member row. Only called for `{ outcome: 'accepted' }`.
   */
  revokeAcceptedInvitation: (input: {
    workspaceId: string;
    email: string;
  }) => Promise<{ removed: boolean; rooms: number }>;
}

export interface OrganizationLogger {
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * A room-revocation sweep that failed after the member row was already gone.
 *
 * Through round 5 this was a security event and it was swallowed, which is the
 * combination the round-5 gauntlet called blocking. It is now neither: room
 * authorization joins `workspace_members` (`room-access.ts`), so the orphaned
 * `memberships` rows this describes grant nothing at all. What is left is
 * garbage in a table, and garbage still deserves to be reported rather than
 * absorbed — the removal itself succeeded, so throwing would tell the caller
 * the opposite of what happened and invite a retry that can only fail.
 */
export interface RoomCleanupFailure {
  /** The port that rejected. */
  operation: 'revokeWorkspaceRooms';
  /** Which hook it rejected in. */
  phase: 'afterRemoveMember';
  workspaceId: string;
  userId: string;
  error: Error;
}

export interface OrganizationOptionsInput {
  ports: OrganizationPorts;
  /** Public origin of the web app; invitation links are built against it. */
  baseURL: string;
  mailer: Mailer;
  /** The model/field remapping from `@atrium/db` (`organizationSchemaOptions`). */
  schema: OrganizationOptions['schema'];
  logger?: OrganizationLogger;
  /**
   * Where a cleanup failure goes besides the log.
   *
   * The seam a deployment alerts on: the log line below is greppable and
   * carries a stable `event`, but a structured hook is what lets an operator
   * page on it or enqueue a repair without parsing text. Optional because the
   * failure is no longer a security event — nothing breaks if a deployment
   * declines to wire it — and deliberately not defaulted to a throw, for the
   * reason on {@link RoomCleanupFailure}.
   *
   * A reporter that throws is itself logged and swallowed: a broken alerting
   * hook must not turn a completed removal into an error.
   */
  onCleanupFailure?: (failure: RoomCleanupFailure) => void;
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

  /**
   * Report a cleanup failure loudly, then carry on.
   *
   * "Loudly" is the whole change from round 5, and it is three specific things
   * rather than an adverb: a stable `event` key an alert can match on, the
   * error's `name` and `stack` and not just its `message` (round 5 learned that
   * `DrizzleQueryError` hides the interesting part one `cause` down), and a
   * `consequence` field that says what an operator is looking at — orphaned
   * rows, not lost access — so nobody re-derives that at 3am.
   */
  const reportCleanupFailure = (failure: RoomCleanupFailure): void => {
    logger.error('room revocation sweep failed after member removal', {
      event: 'room_cleanup_failed',
      operation: failure.operation,
      phase: failure.phase,
      workspaceId: failure.workspaceId,
      userId: failure.userId,
      errorName: failure.error.name,
      error: failure.error.message,
      stack: failure.error.stack,
      cause: failure.error.cause instanceof Error ? failure.error.cause.message : undefined,
      consequence:
        'the workspace member row is gone, so room authorization already denies this user; ' +
        'orphaned `memberships` rows remain and should be swept',
    });
    try {
      input.onCleanupFailure?.(failure);
    } catch (reporterError) {
      logger.error('the cleanup-failure reporter itself threw', {
        event: 'room_cleanup_reporter_failed',
        error: (reporterError as Error).message,
      });
    }
  };

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
       *
       * **And the acceptance that beats the void.** Round 3 could only cancel a
       * `pending` row, so the one ordering that costs something — created,
       * inviter demoted, invitee accepts, compensation arrives — hit nothing,
       * returned `false`, and threw a FORBIDDEN at the inviter while leaving an
       * over-privileged member and their room rows exactly where the acceptance
       * put them. The void now reports what it found, and an `accepted` row is
       * compensated for real: `revokeAcceptedInvitation` takes the room rows and
       * the member row back out. A cancelled or already-inert row needs nothing.
       * A missing one is logged, because an invitation that vanished between two
       * statements is a thing worth knowing about.
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

        let found: InvitationVoidOutcome;
        try {
          found = await ports.voidInvitation({ invitationId: data.invitation.id, workspaceId });
        } catch (error) {
          logger.error('failed to void an over-privileged invitation', {
            invitationId: data.invitation.id,
            error: (error as Error).message,
          });
          throw new APIError('INTERNAL_SERVER_ERROR', {
            message: 'The invitation could not be issued. Nothing was granted; please try again.',
          });
        }

        if (found.outcome === 'accepted') {
          // The row is out of `pending` and there is a member behind it. This is
          // the only branch where something was actually granted, and it is the
          // only one where failing to compensate must not read as success.
          logger.warn('an over-privileged invitation was accepted before it could be voided', {
            reason: 'invitation_accepted_before_void',
            workspaceId,
            invitationId: data.invitation.id,
            email: found.email,
          });
          try {
            const undone = await ports.revokeAcceptedInvitation({
              workspaceId,
              email: found.email,
            });
            logger.warn('undid an acceptance of an over-privileged invitation', {
              workspaceId,
              invitationId: data.invitation.id,
              removedMember: undone.removed,
              revokedRooms: undone.rooms,
            });
          } catch (error) {
            logger.error('failed to undo an accepted over-privileged invitation', {
              invitationId: data.invitation.id,
              email: found.email,
              error: (error as Error).message,
            });
            throw new APIError('INTERNAL_SERVER_ERROR', {
              message:
                'That invitation was accepted while your permission to send it changed, and ' +
                'the membership it created could not be undone. It has been logged for an admin.',
            });
          }
        } else if (found.outcome === 'missing') {
          logger.error('an over-privileged invitation vanished before it could be voided', {
            invitationId: data.invitation.id,
            workspaceId,
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
       * are separate transactions (see the note at the top of this file). A
       * failure part-way through leaves somebody who is still a workspace
       * member but can reach no room: annoying, and fixable by re-adding them.
       * The other order would leave somebody who is no longer a member but
       * still holds room rows.
       *
       * Round 6 changed what that second shape *costs*, and the ordering is
       * kept anyway. Room authorization now joins `workspace_members`
       * (`room-access.ts`), so retained room rows grant nothing once the member
       * row is gone — the ordering is no longer the thing standing between a
       * removed member and their rooms. It stays because leaving the tidier
       * residue for free is worth having, and because a guarantee that depends
       * on two hooks running in a particular order is exactly what this ticket
       * spent five rounds learning not to rely on.
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

      /**
       * Again, idempotently: a join racing the removal must not survive it.
       *
       * And when this sweep fails, it is *reported*, not absorbed. Round 5
       * caught the failure and logged one line with the message and the user
       * id, which was a security decision dressed as error handling: the member
       * row was already gone, the room rows were still there, and room
       * authorization read only the room rows. Round 6 moved authorization onto
       * the join, so the same failure now leaves orphaned rows and no access.
       * That makes it a cleanup concern — one that gets a stable event key, the
       * whole error, and an operator seam (`onCleanupFailure`).
       *
       * Still not a throw. The removal has committed; reporting failure to the
       * caller would be a false statement about what happened, and the retry it
       * invites can only fail against a member row that no longer exists.
       */
      afterRemoveMember: async (data: {
        member: { userId: string; organizationId: string };
        organization: { id: string };
      }) => {
        const workspaceId = data.member.organizationId ?? data.organization.id;
        try {
          await ports.revokeWorkspaceRooms({ workspaceId, userId: data.member.userId });
        } catch (error) {
          reportCleanupFailure({
            operation: 'revokeWorkspaceRooms',
            phase: 'afterRemoveMember',
            workspaceId,
            userId: data.member.userId,
            error: error instanceof Error ? error : new Error(String(error)),
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

        // A *ceiling*, not a value. The port applies the lower of this and
        // whatever is committed, so this call can only ever lower the rooms —
        // and cannot lower them past a demotion that has already committed.
        await ports.syncWorkspaceRoomRoles({
          workspaceId,
          userId: data.member.userId,
          atMost: newRole,
        });
        return undefined;
      },

      /**
       * The reconciliation, on whatever is committed when it runs.
       *
       * Round 3 passed `data.member.role` — the row this particular call wrote —
       * which is correct for one role change and wrong for two overlapping ones:
       * the hook that finished last won, rather than the write that landed last.
       * The interleaving is drawn at the top of `workspace.ts`. This now names
       * only *who*, and the port reads the committed role under a lock keyed on
       * that pair; the last reconciliation to run is necessarily the one that
       * started after the last commit, so what it reads is what landed.
       *
       * Runs for every change, not just promotions: re-applying a demotion the
       * before-hook already applied is idempotent, and it is what makes the
       * committed row the last word.
       */
      afterUpdateMemberRole: async (data: {
        member: { userId: string; organizationId: string; role: string };
        organization: { id: string };
      }) => {
        await ports.syncWorkspaceRoomRoles({
          workspaceId: data.member.organizationId ?? data.organization.id,
          userId: data.member.userId,
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
