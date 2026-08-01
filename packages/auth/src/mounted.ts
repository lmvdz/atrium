/**
 * Which Better Auth endpoints Atrium actually exposes over HTTP.
 *
 * Better Auth ships a large API — sign-up, sign-in, password reset, account
 * linking, and every route the organization plugin adds, including
 * `POST /organization/invite-member` and `POST /organization/update-member-role`.
 * Mounting the library's router at `/api/auth/[...all]` publishes *all* of it.
 *
 * Atrium does not drive that API from the browser. Every mutation the product
 * performs is a Server Action calling `auth.api.*` in-process, which is where
 * `authorize()` and the sign-in/sign-up throttle live. So the HTTP surface only
 * has to carry the two things a browser genuinely arrives at on its own:
 *
 *  - `GET /verify-email` — the link in the confirmation email.
 *  - `GET|POST /callback/:id` — where the OAuth provider sends the browser
 *    back, plus `GET /error`, the page Better Auth redirects to when that fails.
 *
 * Everything else is denied here. Two consequences worth being explicit about,
 * because both were findings in round 1 of this ticket's review:
 *
 *  1. The raw organization API is not reachable, so it cannot be used to walk
 *     around the Server Action policy. The library-layer guard in `org.ts` is the
 *     second, independent lock on that same door — a deny-list of one is not a
 *     security boundary, and neither is a policy that only exists in the UI.
 *  2. `/sign-in/email` and `/sign-up/email` are not reachable either, so there
 *     is no unthrottled path past the sliding-window limiter the Server Actions
 *     apply.
 *
 * Adding a flow that genuinely needs a browser to call Better Auth directly
 * means adding its route here, which is the review moment this list exists for.
 *
 * ## Why this file mirrors a router instead of normalising paths
 *
 * Round 2's version normalised the path first — decoded each segment, collapsed
 * `//`, resolved `.` and `..` — and then compared. That is the intuitive thing
 * to write and it is wrong, because it makes the guard's idea of a path
 * *different* from the router's. Better Auth (better-call over rou3) matches the
 * **raw** pathname, segment by segment, and decodes nothing: `%2e%2e` is the
 * four-character string `%2e%2e`, not `..`. Two different notions of "the same
 * path" is exactly the shape a bypass grows in, and round 2's gauntlet found it:
 * the guard admitted `/api/auth/organization/../verify-email` (normalises to the
 * verification link) while the router would have 404'd it. Nothing was exposed,
 * but only because a *dependency's* matching happened to be stricter than ours.
 * That is a guarantee we do not own.
 *
 * So this file now answers the same question the router answers, in the same
 * terms, and refuses anything it cannot answer identically:
 *
 *  - the raw pathname is what is matched, exactly as `new URL(url).pathname`
 *    hands it over — no decoding, no case folding, no segment collapsing;
 *  - percent-encoding is refused outright. Decoding *is* a second semantics, so
 *    rather than admit anything whose raw and decoded forms differ, a path that
 *    is not already its own decoded form is denied. None of the three mounted
 *    routes ever needs one;
 *  - two or more consecutive slashes are refused, because better-call refuses
 *    them before it routes (`/\/{2,}/`);
 *  - a trailing slash is refused, because better-call compares the request's
 *    trailing slash against the registered route's and none of ours has one;
 *  - the method is part of the match, because the router registers routes per
 *    method. `POST /api/auth/verify-email` is a 404 at the router, so it is a
 *    404 here.
 *
 * The `mounted.test.ts` fixtures assert the refusals *at this function* rather
 * than at the router, which is the whole point: exposure must not depend on a
 * second system's quirks.
 */

/** Where the catch-all route is mounted. Better Auth's `basePath`. */
export const authBasePath = '/api/auth';

/**
 * A route Better Auth registers and Atrium chooses to publish.
 *
 * `path` is the pattern **exactly as the library registers it** (so `:id` for a
 * parameter segment), and `methods` are the methods it registers for it. Both
 * halves are copied from Better Auth's own endpoint definitions:
 * `api/routes/email-verification.mjs`, `api/routes/error.mjs` and
 * `api/routes/callback.mjs` in `better-auth@1.6.x`. If a library upgrade
 * changes either, the guard is wrong in the *closed* direction — the flow
 * breaks visibly instead of the surface widening quietly.
 */
export interface MountedAuthRoute {
  /** rou3-style pattern below `authBasePath`, e.g. `/callback/:id`. */
  path: string;
  /** Uppercase HTTP methods this route answers. */
  methods: readonly string[];
}

/**
 * The published surface, in full.
 *
 * `/oauth2/callback/:providerId` is deliberately **absent**: it belongs to the
 * `genericOAuth` plugin, which Atrium does not install, so the router has no
 * such route. Round 2 listed it anyway, which is the same divergence class this
 * file exists to close — an allowlist entry for a route that does not exist
 * means the guard admits what the router 404s. Adding that plugin means adding
 * its route here, in the same commit.
 */
export const mountedAuthRoutes: readonly MountedAuthRoute[] = [
  /** The confirmation link in every verification email. */
  { path: '/verify-email', methods: ['GET'] },
  /** Where Better Auth redirects a failed OAuth callback. */
  { path: '/error', methods: ['GET'] },
  /** The OAuth provider's return leg. Some providers use form_post. */
  { path: '/callback/:id', methods: ['GET', 'POST'] },
] as const;

/**
 * Decide whether a request may reach Better Auth's router.
 *
 * @param pathname a full request path, e.g. `/api/auth/verify-email`, raw and
 *                 undecoded. Anything outside `authBasePath` is refused: this
 *                 function is the whole rule, so it never assumes the caller
 *                 stripped a prefix correctly.
 * @param method   the request method. Required, and part of the match — the
 *                 router registers per method, so a guard that ignores it is a
 *                 guard that disagrees with the router.
 */
export function isMountedAuthPath(pathname: string, method: string): boolean {
  if (typeof pathname !== 'string' || typeof method !== 'string') return false;

  // Percent-encoding is a second way to spell a path, and a second spelling is
  // a second semantics. Refuse anything that is not already its own decoded
  // form — including a string that does not decode at all.
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (decoded !== pathname) return false;

  // better-call: `pathname.startsWith(basePath + '/')`, or 404. A bare
  // `/api/auth` therefore does not route, and neither does `/api/authx/...`.
  if (!pathname.startsWith(`${authBasePath}/`)) return false;
  const path = pathname.slice(authBasePath.length);

  // better-call, before it routes at all.
  if (/\/{2,}/.test(path)) return false;
  // better-call compares the request's trailing slash with the matched route's;
  // no route we publish has one, so a trailing slash is always a 404 there.
  if (path.endsWith('/')) return false;

  const segments = path.split('/').slice(1);
  const wanted = method.toUpperCase();

  return mountedAuthRoutes.some(
    (route) => route.methods.includes(wanted) && matchesPattern(route.path, segments),
  );
}

/**
 * rou3's static/param matching, for the shapes we register.
 *
 * Static segments compare byte-for-byte (case-sensitive, no decoding); a `:name`
 * segment matches exactly one non-empty segment. No wildcards, because no route
 * we publish has one — and a wildcard we did not write cannot be smuggled in
 * through a path.
 */
function matchesPattern(pattern: string, segments: readonly string[]): boolean {
  const expected = pattern.split('/').slice(1);
  if (expected.length !== segments.length) return false;
  return expected.every((part, index) => {
    const segment = segments[index];
    if (segment === undefined || segment === '') return false;
    return part.startsWith(':') ? true : part === segment;
  });
}
