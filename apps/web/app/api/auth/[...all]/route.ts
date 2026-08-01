import { isMountedAuthPath, rawPathname } from '@atrium/auth';
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
 *
 * The pathname handed over is the **raw** one, and the method goes with it.
 * `isMountedAuthPath` deliberately matches on the same terms Better Auth's own
 * router does, so the guard's answer and the router's cannot diverge; passing a
 * pre-decoded or pre-normalised path here would undo that.
 *
 * Which is why this uses `rawPathname` and not `new URL(request.url).pathname`.
 * Round 3 used the latter and described it as raw; it is not. WHATWG URL parsing
 * removes dot segments, so `/api/auth/organization/../verify-email` would have
 * reached the guard as `/api/auth/verify-email` and been admitted. Next happens
 * to reject a request line carrying `..` with a 400 first — which is why nothing
 * was exposed and why round 3's own e2e asserts a 400 there rather than a 404 —
 * but "a different layer normalised it for us" is the shape of guarantee this
 * whole file exists to stop depending on.
 */
export const dynamic = 'force-dynamic';

const notFound = () =>
  new Response(JSON.stringify({ error: 'not found' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });

function guard(request: Request): Response | null {
  return isMountedAuthPath(rawPathname(request.url), request.method) ? null : notFound();
}

export async function GET(request: Request): Promise<Response> {
  return guard(request) ?? toNextJsHandler(auth()).GET(request);
}

export async function POST(request: Request): Promise<Response> {
  return guard(request) ?? toNextJsHandler(auth()).POST(request);
}
