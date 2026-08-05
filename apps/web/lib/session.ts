import 'server-only';
import { type AtriumSession, getAtriumSession } from '@atrium/auth';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from './auth';

/**
 * Reading the session in a Server Component.
 *
 * Every page that shows anything belonging to a person calls `requireSession`.
 * There is no middleware doing it invisibly: a redirect that happens in the file
 * you are reading is a redirect you can see, and Next's own guidance since 15.2
 * is to authorize where the data is, not in a matcher three directories away.
 */

export async function currentSession(): Promise<AtriumSession | null> {
  return getAtriumSession(auth(), await headers());
}

/**
 * The session, or a redirect to sign in. `next` carries where the person was
 * heading, so accepting an invitation while signed out lands back on the
 * invitation rather than dumping them on a workspace list.
 *
 * An unverified address is not a session as far as this function is concerned.
 * Better Auth is configured not to mint one (`requireEmailVerification`), and
 * the WebSocket upgrade re-checks it anyway — round 1 left the web path as the
 * only one of the three that did not, so a future relaxation of that setting, or
 * any flow that creates a session another way, would have been visible in the
 * app and invisible over the socket. Same check, both sides.
 */
export async function requireSession(next?: string): Promise<AtriumSession> {
  const session = await currentSession();
  if (session?.emailVerified) return session;

  if (session) {
    // Signed in, not verified: the useful destination is the page that resends
    // the link, not the sign-in form they have already completed.
    redirect(`/check-email?email=${encodeURIComponent(session.email)}`);
  }

  redirect(next ? `/sign-in?next=${encodeURIComponent(next)}` : '/sign-in');
}
