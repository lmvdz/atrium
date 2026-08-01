/**
 * Where "come back here after you sign in" is allowed to point.
 *
 * One function, used by the sign-in page and by every action that reads a `next`
 * parameter. `//evil.example` is a protocol-relative URL that a naive
 * `startsWith('/')` waves through, which turns a login form into an open
 * redirect — the second check is the whole point of this existing.
 */
export function safeNextPath(value: unknown, fallback = '/app'): string {
  if (typeof value !== 'string') return fallback;
  if (!value.startsWith('/')) return fallback;
  if (value.startsWith('//')) return fallback;
  // A backslash is a path separator to some browsers' URL parsers.
  if (value.startsWith('/\\')) return fallback;
  return value;
}
