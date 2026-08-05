import type { Metadata } from 'next';
import Link from 'next/link';
import { acceptInvitationAction } from '@/app/app/actions';
import { requireSession } from '@/lib/session';
import { loadInvitation } from '@/lib/workspaces';
import styles from '../../(auth)/auth.module.css';

export const metadata: Metadata = { title: 'Invitation · Atrium' };
export const dynamic = 'force-dynamic';

/**
 * The other end of an invitation email.
 *
 * The page tells the truth about the link's state rather than collapsing every
 * outcome into "invalid": already used, expired, addressed to somebody else, or
 * ready to accept are four different situations and only one of them is the
 * recipient's fault.
 *
 * **The recipient check comes first, and everything downstream of it is silent.**
 * An invitation id in a URL is a bearer token that arrives by email, so whoever
 * holds it is not necessarily who it was sent to — a forwarded message, a shared
 * screen, a link in a bug report. Round 1 answered anybody holding an id with
 * the workspace's name, the invited address and the invitation's state, which
 * turns a stray link into a directory lookup: paste ids, learn who was invited
 * where. Somebody signed in as the wrong person now gets one sentence with no
 * nouns in it, and only the actual recipient sees which workspace, which role,
 * and what happened to their link.
 *
 * Single-use is not enforced here — Better Auth moves the row out of `pending`
 * with a conditional update inside a transaction, so two simultaneous accepts
 * still produce exactly one membership. What this page does is *explain* it.
 */
export default async function InvitationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;

  // Signing in first, then coming back: the invitation is the destination.
  const session = await requireSession(`/invite/${id}`);
  const invitation = await loadInvitation(id);

  // One answer for "there is no such invitation" and for "there is one, but it
  // is not yours". Distinguishing them would confirm that an id is real, which
  // is the only thing an id-guesser wants to know.
  if (!invitation || invitation.email.toLowerCase() !== session.email.toLowerCase()) {
    return (
      <Shell title="Invitation">
        {/* One state for both branches, on purpose: a `data-state` that said
            "this id is real, just not yours" is an oracle a script can read, and
            the whole point of getting here is that the holder is not the person
            entitled to know. */}
        <p className={styles.blocked} data-testid="invitation-state" data-state="unavailable">
          This invitation is not for the account you are signed in as (
          <span className={styles.mono}>{session.email}</span>). If it was sent to another address,
          sign in as that person; otherwise ask whoever invited you to send a new one.
        </p>
        <BackToApp />
      </Shell>
    );
  }

  if (invitation.status !== 'pending') {
    return (
      <Shell title={`Invitation to ${invitation.workspaceName}`}>
        <p className={styles.blocked} data-testid="invitation-state" data-state="used">
          This invitation has already been {invitation.status}. Invitation links work once — ask an
          admin of {invitation.workspaceName} for a fresh one.
        </p>
        <BackToApp />
      </Shell>
    );
  }

  if (invitation.expiresAt.getTime() < Date.now()) {
    return (
      <Shell title={`Invitation to ${invitation.workspaceName}`}>
        <p className={styles.blocked} data-testid="invitation-state" data-state="expired">
          This invitation expired on {invitation.expiresAt.toISOString().slice(0, 10)}. Ask an admin
          of {invitation.workspaceName} for a new one.
        </p>
        <BackToApp />
      </Shell>
    );
  }

  return (
    <Shell title={`Join ${invitation.workspaceName}`}>
      {error ? (
        <p className={styles.error} role="alert" data-testid="form-error">
          That invitation could not be accepted. It may have just been used or revoked.
        </p>
      ) : null}

      <p className={styles.lede} data-testid="invitation-state" data-state="pending">
        You have been invited to {invitation.workspaceName} as{' '}
        <strong>{invitation.role ?? 'member'}</strong>.
      </p>

      <form action={acceptInvitationAction} className={styles.form}>
        <input type="hidden" name="invitationId" value={invitation.id} />
        <button className={styles.button} type="submit" data-testid="accept-invitation">
          Accept invitation
        </button>
      </form>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>{title}</h1>
        {children}
      </div>
    </main>
  );
}

function BackToApp() {
  return (
    <p className={styles.footer}>
      <Link className={styles.link} href="/app">
        Go to your workspaces
      </Link>
    </p>
  );
}
