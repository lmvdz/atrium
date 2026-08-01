import { isMountedAuthPath } from '@atrium/auth';
import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/lib/auth';

/**
 * Better Auth's HTTP surface, reduced to the paths a browser actually arrives
 * at on its own: the verification link and the OAuth callback.
 *
 * The catch-all is the point of the file and also its hazard — mounting the
 * library's router publishes every endpoint it has, including the organization
 * plugin's `invite` and `update-member-role`. Atrium drives all of that
 * in-process from Server Actions, where `authorize()` and the sign-in throttle
 * live, so an HTTP caller reaching those endpoints would be a caller who skipped
 * both. Round 1 of this ticket's review walked exactly that path to have a
 * workspace admin mint an `owner` invitation.
 *
 * The allowlist itself is `@atrium/auth`'s `isMountedAuthPath` — shared, so the
 * decision is testable on its own and the realtime server can read the same
 * list. Anything not on it gets a flat 404: not "403, and here is what exists",
 * which would enumerate the surface we just declined to publish.
 */
export const dynamic = 'force-dynamic';

const notFound = () =>
  new Response(JSON.stringify({ error: 'not found' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });

function guard(request: Request): Response | null {
  return isMountedAuthPath(new URL(request.url).pathname) ? null : notFound();
}

export async function GET(request: Request): Promise<Response> {
  return guard(request) ?? toNextJsHandler(auth()).GET(request);
}

export async function POST(request: Request): Promise<Response> {
  return guard(request) ?? toNextJsHandler(auth()).POST(request);
}
