import { callbackOAuth, error, verifyEmail } from 'better-auth/api';
import { describe, expect, it } from 'vitest';
import { authBasePath, isMountedAuthPath, mountedAuthRoutes } from '../src/mounted.js';

/**
 * The mounted surface is a deny-by-default allowlist, so the interesting tests
 * are the refusals — particularly the organization endpoints, which are the ones
 * round 1's reviewers walked through to escalate a role.
 *
 * Round 2's gauntlet then found the *second* defect, which is what most of this
 * file is now about: the guard normalised paths (decoding, collapsing `//`,
 * resolving `..`) while Better Auth's router matches the raw pathname segment by
 * segment. Nothing was exposed, but only because the dependency happened to be
 * stricter than we were. Every smuggling fixture below therefore asserts a
 * refusal **at the guard** — `isMountedAuthPath` itself returning false — rather
 * than trusting a 404 that a second system would have produced anyway.
 */

const GET = 'GET';
const POST = 'POST';

describe('isMountedAuthPath — what is allowed', () => {
  it('allows the verification link', () => {
    expect(isMountedAuthPath('/api/auth/verify-email', GET)).toBe(true);
  });

  it('allows an OAuth provider callback on both methods the library registers', () => {
    expect(isMountedAuthPath('/api/auth/callback/github', GET)).toBe(true);
    expect(isMountedAuthPath('/api/auth/callback/github', POST)).toBe(true);
  });

  it('allows the error page better auth redirects a failed callback to', () => {
    expect(isMountedAuthPath('/api/auth/error', GET)).toBe(true);
  });
});

describe('isMountedAuthPath — what is refused', () => {
  it('refuses every organization endpoint', () => {
    for (const path of [
      '/api/auth/organization/invite-member',
      '/api/auth/organization/create',
      '/api/auth/organization/update-member-role',
      '/api/auth/organization/remove-member',
      '/api/auth/organization/accept-invitation',
      '/api/auth/organization/list-members',
      // Better Auth fires no member hooks for this one (see the note at the top
      // of `org.ts`), so a self-removal through it would leave room membership
      // behind. It is unreachable because it is not on the list, and this
      // assertion is what stops a future widening from exposing it silently.
      '/api/auth/organization/leave',
    ]) {
      for (const method of [GET, POST]) {
        expect(isMountedAuthPath(path, method), `${method} ${path}`).toBe(false);
      }
    }
  });

  it('refuses the credential endpoints the Server Action throttle guards', () => {
    for (const path of [
      '/api/auth/sign-in/email',
      '/api/auth/sign-up/email',
      '/api/auth/send-verification-email',
      '/api/auth/change-password',
      '/api/auth/reset-password',
      '/api/auth/list-sessions',
      '/api/auth/get-session',
    ]) {
      for (const method of [GET, POST]) {
        expect(isMountedAuthPath(path, method), `${method} ${path}`).toBe(false);
      }
    }
  });

  it('refuses a bare callback with no provider', () => {
    expect(isMountedAuthPath('/api/auth/callback', GET)).toBe(false);
    expect(isMountedAuthPath('/api/auth/callback/', GET)).toBe(false);
  });

  it('refuses anything outside the base path', () => {
    expect(isMountedAuthPath('/verify-email', GET)).toBe(false);
    expect(isMountedAuthPath('/api/authx/verify-email', GET)).toBe(false);
    // better-call requires `basePath + '/'`, so the bare base path 404s there too.
    expect(isMountedAuthPath('/api/auth', GET)).toBe(false);
    expect(isMountedAuthPath('', GET)).toBe(false);
  });

  it('refuses a non-string path or method', () => {
    expect(isMountedAuthPath(undefined as unknown as string, GET)).toBe(false);
    expect(isMountedAuthPath('/api/auth/verify-email', undefined as unknown as string)).toBe(false);
  });
});

/**
 * The method is part of the route, not a detail.
 *
 * Better Auth registers `/verify-email` for GET only, so `POST /verify-email` is
 * a 404 at the router. A guard that ignored the method would admit it and hand
 * a POST body to an endpoint that never expects one.
 */
describe('isMountedAuthPath — method coverage', () => {
  it('publishes the verification link and the error page on GET alone', () => {
    for (const path of ['/api/auth/verify-email', '/api/auth/error']) {
      expect(isMountedAuthPath(path, GET), `GET ${path}`).toBe(true);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
        expect(isMountedAuthPath(path, method), `${method} ${path}`).toBe(false);
      }
    }
  });

  it('publishes the OAuth callback on GET and POST and nothing else', () => {
    const path = '/api/auth/callback/github';
    for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(isMountedAuthPath(path, method), `${method} ${path}`).toBe(false);
    }
  });

  it('compares the method case-insensitively, as the router does', () => {
    expect(isMountedAuthPath('/api/auth/verify-email', 'get')).toBe(true);
  });
});

/**
 * Smuggling fixtures.
 *
 * Every one of these is a way of spelling a path that some *other* piece of
 * software would resolve to something else. The guard's job is to refuse them
 * outright rather than to resolve them and hope its resolution agrees with the
 * router's — the round 2 finding, in one sentence.
 */
describe('isMountedAuthPath — path smuggling', () => {
  it('refuses an encoded slash (%2f), whichever side of the path it hides on', () => {
    for (const path of [
      '/api/auth/verify-email%2f..%2forganization%2finvite-member',
      '/api/auth/organization%2finvite-member',
      '/api/auth/callback%2f..%2forganization%2finvite-member',
      '/api/auth/callback/github%2f..%2forganization%2finvite-member',
      '/api/auth%2fverify-email',
    ]) {
      expect(isMountedAuthPath(path, POST), path).toBe(false);
      expect(isMountedAuthPath(path, GET), path).toBe(false);
    }
  });

  it('refuses encoded dot segments (%2e%2e)', () => {
    for (const path of [
      '/api/auth/%2e%2e/api/auth/organization/invite-member',
      '/api/auth/verify-email/%2e%2e/organization/invite-member',
      '/api/auth/%2e/verify-email',
      '/api/auth/callback/%2e%2e/organization/invite-member',
    ]) {
      expect(isMountedAuthPath(path, GET), path).toBe(false);
    }
  });

  it('refuses double encoding, which one decode pass would turn into a fresh path', () => {
    for (const path of [
      '/api/auth/%252e%252e/organization/invite-member',
      '/api/auth/verify-email%252f..%252forganization',
      '/api/auth/%2570rganization/invite-member',
    ]) {
      expect(isMountedAuthPath(path, GET), path).toBe(false);
    }
  });

  it('refuses a percent-encoded spelling of a path it would otherwise allow', () => {
    // `%76` is `v`. Decoded this is the verification link; raw it is not, and
    // raw is what the router matches. Refusing is the only answer that cannot
    // disagree with the router.
    expect(isMountedAuthPath('/api/auth/%76erify-email', GET)).toBe(false);
    expect(isMountedAuthPath('/api/auth/callback/git%68ub', GET)).toBe(false);
  });

  it('refuses a percent sign that is not valid encoding at all', () => {
    expect(isMountedAuthPath('/api/auth/verify-email%zz', GET)).toBe(false);
    expect(isMountedAuthPath('/api/auth/%', GET)).toBe(false);
  });

  it('refuses mixed case, because rou3 matches segments byte-for-byte', () => {
    for (const path of [
      '/api/auth/Verify-Email',
      '/api/auth/VERIFY-EMAIL',
      '/api/auth/Error',
      '/api/auth/Callback/github',
      '/API/AUTH/verify-email',
    ]) {
      expect(isMountedAuthPath(path, GET), path).toBe(false);
    }
  });

  it('refuses a trailing slash, which better-call 404s on its own', () => {
    for (const path of [
      '/api/auth/verify-email/',
      '/api/auth/error/',
      '/api/auth/callback/github/',
    ]) {
      expect(isMountedAuthPath(path, GET), path).toBe(false);
    }
  });

  it('refuses doubled slashes, which better-call rejects before it routes', () => {
    for (const path of [
      '/api/auth//verify-email',
      '/api/auth///verify-email',
      '/api/auth//organization/invite-member',
      '/api/auth/callback//github',
    ]) {
      expect(isMountedAuthPath(path, GET), path).toBe(false);
    }
  });

  it('refuses literal dot segments, which rou3 treats as ordinary segments', () => {
    // The round 2 defect exactly: the old guard normalised this to the
    // verification link and admitted it, while the router 404s it. Same verdict
    // now, reached for the same reason the router reaches it.
    for (const path of [
      '/api/auth/./verify-email',
      '/api/auth/organization/../verify-email',
      '/api/auth/verify-email/../organization/invite-member',
      '/api/auth/callback/../organization/invite-member',
      '/api/auth/callback/./github',
    ]) {
      expect(isMountedAuthPath(path, GET), path).toBe(false);
      expect(isMountedAuthPath(path, POST), path).toBe(false);
    }
  });

  it('refuses a deeper path under an allowed prefix', () => {
    expect(isMountedAuthPath('/api/auth/callback/github/extra', GET)).toBe(false);
    expect(isMountedAuthPath('/api/auth/verify-email/anything', GET)).toBe(false);
  });
});

/**
 * The table itself, checked against the library rather than against a comment.
 *
 * `mountedAuthRoutes` copies Better Auth's own `path` and `method` declarations.
 * Copying is what makes the guard match the router; asking the library for the
 * real values is what stops the copy going stale on an upgrade. If a version
 * bump moves `/verify-email` or adds a method to the callback, this fails here
 * — at the allowlist — instead of in production.
 */
describe('the table matches what Better Auth actually registers', () => {
  const published = new Map(mountedAuthRoutes.map((route) => [route.path, route]));

  it.each([
    ['verify-email', verifyEmail],
    ['error', error],
    ['oauth callback', callbackOAuth],
  ])('mirrors the library’s declaration for %s', (_name, endpoint) => {
    const declared = endpoint as unknown as {
      path: string;
      options: { method: string | string[] };
    };
    const route = published.get(declared.path);
    expect(route, `no allowlist entry for ${declared.path}`).toBeDefined();
    const methods = Array.isArray(declared.options.method)
      ? declared.options.method
      : [declared.options.method];
    expect([...(route?.methods ?? [])].sort()).toEqual([...methods].sort());
  });

  it('is short, and every entry is a sub-path of the base', () => {
    expect(authBasePath).toBe('/api/auth');
    for (const route of mountedAuthRoutes) expect(route.path.startsWith('/')).toBe(true);
    // Deny-by-default only means something if the list stays reviewable.
    expect(mountedAuthRoutes.length).toBeLessThanOrEqual(4);
  });

  it('does not publish the generic-oauth callback, which no installed plugin registers', () => {
    expect(published.has('/oauth2/callback/:providerId')).toBe(false);
    expect(isMountedAuthPath('/api/auth/oauth2/callback/github', GET)).toBe(false);
  });
});
