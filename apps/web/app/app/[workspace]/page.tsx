import { authorize } from '@atrium/auth';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/session';
import { listMembers, listPendingInvitations, listRoomsFor, loadWorkspace } from '@/lib/workspaces';
import { inviteMemberAction, removeMemberAction, updateMemberRoleAction } from '../actions';
import styles from '../workspace.module.css';

export const metadata: Metadata = { title: 'Workspace · Atrium' };
export const dynamic = 'force-dynamic';

const errors: Record<string, string> = {
  not_allowed: 'You are not allowed to do that in this workspace.',
  invalid_email: 'That does not look like an email address.',
  invite_failed: 'Could not send that invitation. Try again.',
  member_failed: 'Could not change that membership. A workspace always keeps its owner.',
};

export default async function WorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{
    error?: string;
    invited?: string;
    removed?: string;
    rolechanged?: string;
  }>;
}) {
  const { workspace: slug } = await params;
  const session = await requireSession(`/app/${slug}`);
  const { error, invited, removed, rolechanged } = await searchParams;

  const workspace = await loadWorkspace(slug, session.userId);
  // Not a member reads as "no such workspace". Confirming that a workspace
  // exists to someone who cannot see it is a small leak with no upside.
  if (!workspace) notFound();

  const [rooms, members, invitations] = await Promise.all([
    listRoomsFor(workspace.id, session.userId),
    listMembers(workspace.id),
    listPendingInvitations(workspace.id),
  ]);

  const mayInvite = authorize('workspace.invite', workspace, { scope: 'workspace' }).allowed;
  const mayManageMembers = authorize('workspace.member.remove', workspace, {
    scope: 'workspace',
  }).allowed;

  return (
    <main className={styles.page}>
      {/* The id is on the page because members already have it in every form
          they submit; exposing it here is what lets the end-to-end suite aim a
          raw API call at this workspace and prove the call is refused. */}
      <div className={styles.heading} data-testid="workspace" data-workspace-id={workspace.id}>
        <h1 className={styles.title} data-testid="workspace-name">
          {workspace.name}
        </h1>
        <span className={styles.roleTag} data-testid="workspace-role">
          {workspace.role}
        </span>
      </div>

      {error ? (
        <p className={styles.error} role="alert" data-testid="form-error">
          {errors[error] ?? 'Something went wrong.'}
        </p>
      ) : null}
      {invited ? (
        <p className={styles.notice} role="status" data-testid="invite-sent">
          Invitation sent to {invited}. In development the link is in the server console.
        </p>
      ) : null}
      {removed ? (
        <p className={styles.notice} role="status" data-testid="member-removed">
          Removed. They lose the workspace’s rooms immediately, open connections included.
        </p>
      ) : null}
      {rolechanged ? (
        <p className={styles.notice} role="status" data-testid="member-role-changed">
          Role updated. Room permissions follow it.
        </p>
      ) : null}

      <section className={styles.section} aria-labelledby="rooms">
        <h2 className={styles.sectionTitle} id="rooms">
          Rooms
        </h2>
        <ul className={styles.list} data-testid="room-list">
          {rooms.map((room) => (
            <li className={styles.row} key={room.id}>
              <span className={styles.rowMain}>
                <Link className={styles.link} href={`/app/${workspace.slug}/${room.slug}`}>
                  #{room.slug}
                </Link>
              </span>
              <span className={styles.roleTag}>{room.role}</span>
            </li>
          ))}
        </ul>
        {rooms.length === 0 ? <p className={styles.empty}>No rooms you can see yet.</p> : null}
      </section>

      <section className={styles.section} aria-labelledby="people">
        <h2 className={styles.sectionTitle} id="people">
          People
        </h2>
        <ul className={styles.list} data-testid="member-list">
          {members.map((member) => (
            <li
              className={styles.row}
              data-member-id={member.memberId}
              data-participant-kind={member.principalKind}
              key={member.userId}
            >
              <span className={styles.rowMain}>
                <span className={styles.rowName}>{member.displayName}</span>
                {/* An agent's address is a non-deliverable placeholder, so the
                    row names the register instead of an email that reads as a
                    way to contact a person. */}
                <span className={styles.rowMeta}>
                  {member.principalKind === 'agent' ? 'agent' : member.email}
                </span>
              </span>
              <span className={styles.roleTag}>{member.role}</span>
              {/* Managing yourself out of your own workspace is a separate
                  conversation (ownership transfer); the row simply has no
                  controls rather than offering ones that would be refused. */}
              {mayManageMembers && member.userId !== session.userId ? (
                <span className={styles.rowActions}>
                  <form action={updateMemberRoleAction}>
                    <input type="hidden" name="workspaceSlug" value={workspace.slug} />
                    <input type="hidden" name="memberId" value={member.memberId} />
                    <input
                      type="hidden"
                      name="role"
                      value={member.role === 'admin' ? 'member' : 'admin'}
                    />
                    <button
                      className={styles.secondaryButton}
                      data-testid={`member-role-${member.email}`}
                      type="submit"
                    >
                      Make {member.role === 'admin' ? 'member' : 'admin'}
                    </button>
                  </form>
                  <form action={removeMemberAction}>
                    <input type="hidden" name="workspaceSlug" value={workspace.slug} />
                    <input type="hidden" name="memberId" value={member.memberId} />
                    <button
                      className={styles.secondaryButton}
                      data-testid={`member-remove-${member.email}`}
                      type="submit"
                    >
                      Remove
                    </button>
                  </form>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {mayInvite ? (
        <section className={styles.section} aria-labelledby="invite">
          <h2 className={styles.sectionTitle} id="invite">
            Invite someone
          </h2>
          <form action={inviteMemberAction} className={styles.inlineForm}>
            <input type="hidden" name="workspaceSlug" value={workspace.slug} />
            <div className={styles.field}>
              <label className={styles.label} htmlFor="invite-email">
                Email
              </label>
              <input
                className={styles.input}
                id="invite-email"
                name="email"
                required
                type="email"
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="invite-role">
                Role
              </label>
              <select className={styles.select} defaultValue="member" id="invite-role" name="role">
                <option value="member">member</option>
                <option value="admin">admin</option>
              </select>
            </div>
            <button className={styles.button} type="submit">
              Send invitation
            </button>
          </form>

          <h3 className={styles.sectionTitle}>Pending invitations</h3>
          {invitations.length === 0 ? (
            <p className={styles.empty} data-testid="no-pending-invitations">
              None outstanding.
            </p>
          ) : (
            <ul className={styles.list} data-testid="invitation-list">
              {invitations.map((invitation) => (
                <li className={styles.row} key={invitation.id}>
                  <span className={styles.rowMain}>
                    <span className={styles.rowName}>{invitation.email}</span>
                    <span className={styles.rowMeta}>
                      expires {invitation.expiresAt.toISOString().slice(0, 10)}
                    </span>
                  </span>
                  <span className={styles.roleTag}>{invitation.role ?? 'member'}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <p className={styles.lede}>
        <Link className={styles.link} href="/app">
          All workspaces
        </Link>
      </p>
    </main>
  );
}
