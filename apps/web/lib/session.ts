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
 */
export async function requireSession(next?: string): Promise<AtriumSession> {
  const session = await currentSession();
  if (session) return session;
  redirect(next ? `/sign-in?next=${encodeURIComponent(next)}` : '/sign-in');
}
