import { describe, expect, it } from 'vitest';
import { authBasePath, isMountedAuthPath, mountedAuthPaths } from '../src/mounted.js';

/**
 * The mounted surface is a deny-by-default allowlist, so the interesting tests
 * are the refusals — particularly the organization endpoints, which are the
 * ones round 1's reviewers walked through to escalate a role.
 */

describe('isMountedAuthPath — what is allowed', () => {
  it('allows the verification link', () => {
    expect(isMountedAuthPath('/api/auth/verify-email')).toBe(true);
  });

  it('allows an OAuth provider callback', () => {
    expect(isMountedAuthPath('/api/auth/callback/github')).toBe(true);
    expect(isMountedAuthPath('/api/auth/oauth2/callback/github')).toBe(true);
  });

  it('allows the error page better auth redirects a failed callback to', () => {
    expect(isMountedAuthPath('/api/auth/error')).toBe(true);
  });
});

describe('isMountedAuthPath — what is refused', () => {
  it('refuses every organization endpoint', () => {
    for (const path of [
      '/api/auth/organization/invite',
      '/api/auth/organization/create',
      '/api/auth/organization/update-member-role',
      '/api/auth/organization/remove-member',
      '/api/auth/organization/accept-invitation',
      '/api/auth/organization/list-members',
    ]) {
      expect(isMountedAuthPath(path), path).toBe(false);
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
      expect(isMountedAuthPath(path), path).toBe(false);
    }
  });

  it('refuses a bare callback with no provider', () => {
    expect(isMountedAuthPath('/api/auth/callback')).toBe(false);
    expect(isMountedAuthPath('/api/auth/callback/')).toBe(false);
  });

  it('refuses anything outside the base path', () => {
    expect(isMountedAuthPath('/verify-email')).toBe(false);
    expect(isMountedAuthPath('/api/authx/verify-email')).toBe(false);
    expect(isMountedAuthPath('/api/auth')).toBe(false);
    expect(isMountedAuthPath('')).toBe(false);
  });

  it('cannot be walked around by spelling the path differently', () => {
    // Every one of these resolves to an organization endpoint for a router that
    // normalises, which is every router.
    expect(isMountedAuthPath('/api/auth//organization/invite')).toBe(false);
    expect(isMountedAuthPath('/api/auth/./organization/invite')).toBe(false);
    expect(isMountedAuthPath('/api/auth/verify-email/../organization/invite')).toBe(false);
    expect(isMountedAuthPath('/api/auth/%2e%2e/api/auth/organization/invite')).toBe(false);
    expect(isMountedAuthPath('/api/auth/callback/../organization/invite')).toBe(false);
  });

  it('still allows a path whose only oddity is a redundant slash', () => {
    expect(isMountedAuthPath('/api/auth//verify-email')).toBe(true);
    expect(isMountedAuthPath('/api/auth/callback/github/')).toBe(true);
  });

  it('refuses a non-string', () => {
    expect(isMountedAuthPath(undefined as unknown as string)).toBe(false);
  });
});

describe('the list itself', () => {
  it('is short, and every entry is a sub-path of the base', () => {
    expect(authBasePath).toBe('/api/auth');
    for (const path of mountedAuthPaths) expect(path.startsWith('/')).toBe(true);
    // Deny-by-default only means something if the list stays reviewable.
    expect(mountedAuthPaths.length).toBeLessThanOrEqual(4);
  });
});
