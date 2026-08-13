import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DANGEROUS_GIT_VARS } from '../../src/execution/git.js';
import { harnessEnv } from '../../src/execution/worktree-provider.js';

/**
 * The harness environment is an ALLOWLIST, never the raw `process.env` (#120 F4).
 * These prove the two failure modes the gauntlet found: the server's secrets do
 * not cross the seam, and no repo-retargeting `GIT_*` var does either.
 */

const SECRETS = [
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'AI_GATEWAY_API_KEY',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
];

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of [...SECRETS, ...DANGEROUS_GIT_VARS]) {
    saved[key] = process.env[key];
    process.env[key] = `SENTINEL_${key}`;
  }
  // A real value the harness IS allowed to see.
  saved.PATH = process.env.PATH;
});

afterEach(() => {
  for (const key of [...SECRETS, ...DANGEROUS_GIT_VARS]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('harnessEnv is a strict allowlist (#120 F4)', () => {
  it('carries no server secret and no repo-retargeting GIT_* var', async () => {
    const env = await harnessEnv('sess-123');

    // None of the server's secrets survive. Revert F4 (`{...process.env, …}`) and
    // every one of these reds — a harness `printenv` would exfiltrate them.
    for (const key of SECRETS) {
      expect(env[key], `${key} must not reach the harness`).toBeUndefined();
    }
    // None of the git-retargeting vars survive either — the harness's own git is
    // bound to its worktree, so `git update-ref refs/heads/main …` cannot reach
    // the real repo.
    for (const key of DANGEROUS_GIT_VARS) {
      expect(env[key], `${key} must not reach the harness`).toBeUndefined();
    }

    // What it SHOULD carry: PATH, a scrubbed HOME, the session id, and the git
    // config lockdown.
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.ATRIUM_SESSION_ID).toBe('sess-123');
    expect(env.HOME).toBeTruthy();
    expect(env.HOME).not.toBe(process.env.HOME);
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
  });
});
