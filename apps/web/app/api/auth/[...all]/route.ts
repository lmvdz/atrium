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
 * ## `rawPathname` here is defense-in-depth, and that is the honest word
 *
 * It uses `rawPathname` rather than `new URL(request.url).pathname`, but round
 * 4's receipt claimed more for that than the code can deliver, and codex's
 * round-4 delta was right. **At this boundary the two are the same function.**
 * A route handler is handed a `Request`, and constructing one already runs the
 * WHATWG URL parser: `new Request('http://x/api/auth/organization/../verify-
 * email').url` is `http://x/api/auth/verify-email` before this module sees it,
 * dot segments resolved and `%2e%2e` with them. Next also rejects such a
 * request line with a 400 of its own first, which is why round 3's e2e asserts
 * a 400 rather than a 404.
 *
 * So: **Next and the URL parser own canonicalization on this path.** Reverting
 * this line to `new URL(request.url).pathname` would change nothing observable,
 * and no test at this boundary can catch it — which is exactly why it is
 * written down here instead of being described as a guard that was proved.
 * `rawPathname` stays because it costs nothing, because it is the same function
 * the realtime server calls (where the request target really is raw and the
 * mutation *is* caught, in `apps/server/test/ws-server.test.ts`), and because if
 * a future runtime stops canonicalizing, this call site is already right —
 * `mounted.test.ts` measures that premise so its failure is the thing that
 * tells you.
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
