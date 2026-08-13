import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DANGEROUS_GIT_VARS } from '../../src/execution/git.js';
import {
  createWorktreeCommandProvider,
  harnessEnv,
  unsandboxedExecutionAllowed,
} from '../../src/execution/worktree-provider.js';

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
    // Round 3: the system config path is pinned too, not merely suppressed by
    // the NOSYSTEM flag — parity with `scrubbedGitBaseEnv`.
    expect(env.GIT_CONFIG_SYSTEM).toBe('/dev/null');
  });
});

/**
 * ROUND 3, F6 — THE OPT-IN GATE IS IN THE FACTORY, not only at the two entry
 * points somebody happened to think of.
 *
 * `env.ts` refuses `EXECUTION_PROVIDER=worktree` without the opt-in, and
 * `configure.ts` refuses to build it without the opt-in. Neither is on the path a
 * direct caller takes, and the integration suite took exactly that path: it
 * constructed and RAN the unsandboxed adapter with no opt-in anywhere in the
 * process. That is the #89 adjacent-path-bypass class — a guard that holds on
 * every route except the one nobody enumerated.
 */
describe('the unsandboxed provider cannot be constructed without the opt-in (#120 r3 F6)', () => {
  const repo = { dir: '/tmp/nonexistent-repo', seedCommit: 'deadbeef' };
  const build = () => createWorktreeCommandProvider({ repo, command: ['true'] });

  let savedOptIn: string | undefined;
  beforeEach(() => {
    savedOptIn = process.env.EXECUTION_ALLOW_UNSANDBOXED;
  });
  afterEach(() => {
    if (savedOptIn === undefined) delete process.env.EXECUTION_ALLOW_UNSANDBOXED;
    else process.env.EXECUTION_ALLOW_UNSANDBOXED = savedOptIn;
  });

  it('throws when the opt-in is absent', () => {
    delete process.env.EXECUTION_ALLOW_UNSANDBOXED;
    // REVERT-REDS: drop the `unsandboxedExecutionAllowed()` check at the top of
    // `createWorktreeCommandProvider` and this returns a live provider instead.
    expect(build).toThrow(/EXECUTION_ALLOW_UNSANDBOXED/);
  });

  it('throws when the opt-in is explicitly off', () => {
    for (const off of ['0', 'false', '', 'yes', 'TRUE']) {
      process.env.EXECUTION_ALLOW_UNSANDBOXED = off;
      expect(build, `"${off}" must not read as an opt-in`).toThrow(/EXECUTION_ALLOW_UNSANDBOXED/);
    }
  });

  it('builds when the opt-in is set out loud', () => {
    for (const on of ['1', 'true']) {
      process.env.EXECUTION_ALLOW_UNSANDBOXED = on;
      expect(build().kind).toBe('worktree');
    }
  });

  it('is read per construction, so the window is exactly the one asked for', () => {
    process.env.EXECUTION_ALLOW_UNSANDBOXED = '1';
    expect(unsandboxedExecutionAllowed()).toBe(true);
    delete process.env.EXECUTION_ALLOW_UNSANDBOXED;
    expect(unsandboxedExecutionAllowed()).toBe(false);
    expect(build).toThrow(/EXECUTION_ALLOW_UNSANDBOXED/);
  });
});
