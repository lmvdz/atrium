import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createScratchRepo,
  DANGEROUS_GIT_VARS,
  disposeScratchRepo,
  type ScratchRepo,
} from '../../src/execution/git.js';
import type { SessionContext } from '../../src/execution/provider.js';
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
  // A FACTORY-MINTED, authentic empty-trunk repo (#141 r5). The scratch-repo brand
  // is now verified at the factory, so this suite — which exercises the ORTHOGONAL
  // opt-in gate — must pass an authentic handle, or it would red on the brand refusal
  // and never reach the opt-in behaviour it is here to prove. (The opt-in check runs
  // BEFORE the brand check, so the two "throws" cases would pass regardless; using an
  // authentic repo is what lets the "builds" case actually build.)
  let repo: ScratchRepo;
  beforeAll(async () => {
    repo = await createScratchRepo();
  });
  afterAll(async () => {
    await disposeScratchRepo(repo);
  });
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

/**
 * ROUND 7 F4 — SIGTERM MUST NOT ABANDON THE CHILD.
 *
 * The provider spawns a harness on the server's own disk. Before this fix the
 * ExecutionProvider seam had no cancellation verb, so shutdown expired the drain
 * grace, deleted scratch and `process.exit`'d WITHOUT killing the child — a silent
 * harness kept executing after Atrium abandoned the session. `cancelAll` is the
 * verb, and this proves it terminates not just the direct child but its whole
 * process GROUP: a `bash -lc` AND the grandchild it backgrounded both die.
 */
describe('cancelAll terminates a running harness and its whole process group (#120 r7 F4)', () => {
  let savedOptIn: string | undefined;
  beforeEach(() => {
    savedOptIn = process.env.EXECUTION_ALLOW_UNSANDBOXED;
    process.env.EXECUTION_ALLOW_UNSANDBOXED = '1';
  });
  afterEach(() => {
    if (savedOptIn === undefined) delete process.env.EXECUTION_ALLOW_UNSANDBOXED;
    else process.env.EXECUTION_ALLOW_UNSANDBOXED = savedOptIn;
  });

  /** Is `pid` a live process? `kill(pid, 0)` sends no signal — it only probes. */
  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // ESRCH = no such process (dead). EPERM = alive but not ours to signal.
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  async function waitUntilDead(pid: number, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!alive(pid)) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`process ${pid} was still alive after ${timeoutMs}ms`);
  }

  it('kills the child and the grandchild it backgrounded, so nothing runs loose', async () => {
    const repo = await createScratchRepo();
    // The harness backgrounds a long `sleep` (the grandchild), records BOTH its own
    // pid ($$) and the grandchild's ($!), then blocks on `wait`. A run this shape is
    // exactly the orphan-maker: kill only the direct child and the grandchild lives.
    const provider = createWorktreeCommandProvider({
      repo,
      command: ['bash', '-lc', 'sleep 300 & echo "$!" > pids.txt; echo "$$" >> pids.txt; wait'],
    });
    const ctx: SessionContext = {
      sessionId: 'cancel-me',
      roomId: 'r',
      planId: 'p',
      harness: 'omp',
      model: 'haiku',
    };
    const workspace = await provider.resolve(ctx);
    // Start the run but DO NOT await it — it blocks on `wait` until we cancel.
    const runPromise = provider.run(workspace, ctx);

    // Wait for the harness to record both pids.
    const pidfile = join(workspace.dir, 'pids.txt');
    let sleepPid = 0;
    let bashPid = 0;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        const lines = (await readFile(pidfile, 'utf8')).trim().split('\n');
        if (lines.length >= 2 && lines[0] && lines[1]) {
          sleepPid = Number(lines[0]);
          bashPid = Number(lines[1]);
          break;
        }
      } catch {
        // not written yet
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(sleepPid).toBeGreaterThan(0);
    expect(bashPid).toBeGreaterThan(0);
    // Both are running before we cancel.
    expect(alive(bashPid)).toBe(true);
    expect(alive(sleepPid)).toBe(true);

    // THE CANCEL. REVERT-REDS: return the ExecutionProvider interface to no
    // `cancelAll` (or make it a no-op / kill only `child.pid` without the group),
    // and the grandchild `sleep` survives — an orphan spending against an abandoned
    // session.
    await provider.cancelAll();

    await waitUntilDead(bashPid);
    await waitUntilDead(sleepPid);

    // The run resolves once its child is gone; clean up.
    await runPromise;
    await workspace.dispose().catch(() => undefined);
    await disposeScratchRepo(repo);
  });
});
