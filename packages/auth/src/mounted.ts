/**
 * Which Better Auth endpoints Atrium actually exposes over HTTP.
 *
 * Better Auth ships a large API — sign-up, sign-in, password reset, account
 * linking, and every route the organization plugin adds, including
 * `POST /organization/invite` and `POST /organization/update-member-role`.
 * Mounting the library's router at `/api/auth/[...all]` publishes *all* of it.
 *
 * Atrium does not drive that API from the browser. Every mutation the product
 * performs is a Server Action calling `auth.api.*` in-process, which is where
 * `authorize()` and the sign-in/sign-up throttle live. So the HTTP surface only
 * has to carry the two things a browser genuinely arrives at on its own:
 *
 *  - `GET /verify-email` — the link in the confirmation email.
 *  - `GET /callback/:provider` — where the OAuth provider sends the browser
 *    back, plus `/error`, the page Better Auth redirects to when that fails.
 *
 * Everything else is denied here. Two consequences worth being explicit about,
 * because both were findings in round 1 of this ticket's review:
 *
 *  1. The raw organization API is not reachable, so it cannot be used to walk
 *     around the Server Action policy (an admin POSTing `role: "owner"` to
 *     `/organization/invite`). The library-layer guard in `org.ts` is the
 *     second, independent lock on that same door — a deny-list of one is not a
 *     security boundary, and neither is a policy that only exists in the UI.
 *  2. `/sign-in/email` and `/sign-up/email` are not reachable either, so there
 *     is no unthrottled path past the sliding-window limiter the Server Actions
 *     apply.
 *
 * Adding a flow that genuinely needs a browser to call Better Auth directly
 * means adding its path here, which is the review moment this list exists for.
 */

/** Where the catch-all route is mounted. Better Auth's `basePath`. */
export const authBasePath = '/api/auth';

/** Exact sub-paths (below `authBasePath`) that the router may answer. */
export const mountedAuthPaths = [
  /** The confirmation link in every verification email. */
  '/verify-email',
  /** Where Better Auth redirects a failed OAuth callback. */
  '/error',
] as const;

/** Sub-path prefixes the router may answer. Only OAuth's provider callbacks. */
export const mountedAuthPathPrefixes = ['/callback/', '/oauth2/callback/'] as const;

/**
 * Decide whether a request path may reach Better Auth's router.
 *
 * @param pathname a full request path, e.g. `/api/auth/verify-email`. Anything
 *                 outside `authBasePath` is refused: this function is the whole
 *                 rule, so it never assumes the caller stripped a prefix
 *                 correctly.
 */
export function isMountedAuthPath(pathname: string): boolean {
  if (typeof pathname !== 'string') return false;

  // Normalise `//api//auth//verify-email` and any `.`/`..` segments before
  // comparing, so a path that Next would route here cannot dodge the list by
  // spelling itself differently.
  const normalised = normalise(pathname);
  if (normalised !== authBasePath && !normalised.startsWith(`${authBasePath}/`)) return false;

  const sub = normalised.slice(authBasePath.length) || '/';
  if ((mountedAuthPaths as readonly string[]).includes(sub)) return true;
  return mountedAuthPathPrefixes.some(
    (prefix) => sub.startsWith(prefix) && sub.length > prefix.length,
  );
}

function normalise(pathname: string): string {
  const segments: string[] = [];
  for (const raw of pathname.split('/')) {
    // Decode *before* the `.`/`..` test: `%2e%2e` is `..` by the time any
    // router looks at it, so it has to be `..` by the time this list does.
    const segment = decodeSegment(raw);
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

/** `%2e%2e` must not survive as a path segment that we then treat as literal. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
