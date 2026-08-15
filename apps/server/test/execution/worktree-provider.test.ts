import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createScratchRepo,
  DANGEROUS_GIT_VARS,
  disposeScratchRepo,
  type ScratchRepo,
} from '../../src/execution/git.js';
import {
  MAX_QUEUED_STEERS,
  MAX_SEEN_SIGNALS,
  type SessionContext,
} from '../../src/execution/provider.js';
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
 *
 * BEST-EFFORT, honestly (#147 FIX 1, the #141 lesson): this proves the COOPERATING
 * case — a grandchild that stayed in the group dies. It does NOT claim to kill a
 * grandchild that `setsid()`s out of the group; a process group cannot reach that,
 * only the #138 sandbox can (see the `setsid escape survives` test below).
 */
describe('cancelAll terminates the process group — best-effort; a setsid escape needs #138 (#120 r7 F4)', () => {
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

  it('terminates the process group (best-effort; a setsid escape needs #138)', async () => {
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

/**
 * #147 — DELIVERY of an already-authorized signal to a RUNNING worktree harness.
 *
 * The interrupt terminates the harness AND every grandchild that STAYED in its
 * process group, exactly as `cancelAll` does but targeted at one session. This is
 * BEST-EFFORT, not an absolute no-orphan guarantee (#147 FIX 1 / #141): a
 * `setsid()`-escaping grandchild survives — only the #138 sandbox contains that —
 * and a dedicated test below documents the limit. A `steer` is DELIVERED to the
 * session's inbox for a COOPERATING harness to read at ITS own boundary (the
 * provider does not enforce the boundary of a foreign process, #147 FIX 4); a
 * signal for a session this provider is not running is a safe no-op.
 */
describe('deliver reaches a running worktree harness (#147)', () => {
  let savedOptIn: string | undefined;
  beforeEach(() => {
    savedOptIn = process.env.EXECUTION_ALLOW_UNSANDBOXED;
    process.env.EXECUTION_ALLOW_UNSANDBOXED = '1';
  });
  afterEach(() => {
    if (savedOptIn === undefined) delete process.env.EXECUTION_ALLOW_UNSANDBOXED;
    else process.env.EXECUTION_ALLOW_UNSANDBOXED = savedOptIn;
  });

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
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
  const ctx = (sessionId: string): SessionContext => ({
    sessionId,
    roomId: 'r',
    planId: 'p',
    harness: 'omp',
    model: 'haiku',
  });

  it('an interrupt group-kills the harness and its in-group grandchild (best-effort)', async () => {
    const repo = await createScratchRepo();
    const provider = createWorktreeCommandProvider({
      repo,
      command: ['bash', '-lc', 'sleep 300 & echo "$!" > pids.txt; echo "$$" >> pids.txt; wait'],
    });
    const c = ctx('interrupt-me');
    const workspace = await provider.resolve(c);
    const runPromise = provider.run(workspace, c);

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
    expect(alive(bashPid)).toBe(true);
    expect(alive(sleepPid)).toBe(true);

    // THE INTERRUPT. It consumes an already-authorized row (#127) and only kills —
    // no ledger write, no certify. REVERT-REDS: swap the `killGroup(record.child)`
    // in deliver()'s interrupt arm for `record.child.kill('SIGKILL')` (the direct
    // child only, not the group) and the grandchild `sleep` SURVIVES — an orphan.
    const outcome = await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'interrupt',
      body: 'stop',
    });
    expect(outcome).toEqual({ kind: 'interrupted' });

    // The whole group is gone — assert the grandchild specifically (the orphan).
    await waitUntilDead(bashPid);
    await waitUntilDead(sleepPid);
    expect(alive(sleepPid)).toBe(false);

    // The run itself reaches a FAILED terminal (the harness was SIGKILLed) — the
    // coordinator settles session_failed; delivery certified nothing.
    const report = await runPromise;
    expect(report.terminal.ok).toBe(false);

    await workspace.dispose().catch(() => undefined);
    await disposeScratchRepo(repo);
  });

  it('a steer is queued in the inbox and a cooperating harness reads it at its boundary', async () => {
    const repo = await createScratchRepo();
    // The harness polls its steer inbox (the env var the provider sets) and, once a
    // steer lands, copies it out and exits — a stand-in for a real turn boundary.
    const provider = createWorktreeCommandProvider({
      repo,
      command: [
        'bash',
        '-lc',
        'for i in $(seq 1 200); do if [ -s "$ATRIUM_STEER_INBOX" ]; then cat "$ATRIUM_STEER_INBOX" > steer-seen.txt; exit 0; fi; sleep 0.05; done; exit 3',
      ],
    });
    const c = ctx('steer-me');
    const workspace = await provider.resolve(c);
    const runPromise = provider.run(workspace, c);

    // Give the harness a moment to start polling, then deliver. REVERT-REDS: drop
    // the `appendFile(record.steerInbox, …)` in deliver()'s steer arm and the inbox
    // stays empty — the harness times out (exit 3) and steer-seen.txt never appears.
    await new Promise((r) => setTimeout(r, 100));
    const outcome = await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'steer',
      body: 'tighten the loop',
    });
    expect(outcome).toEqual({ kind: 'delivered' });

    const report = await runPromise;
    expect(report.terminal.ok).toBe(true);
    const seen = (await readFile(join(workspace.dir, 'steer-seen.txt'), 'utf8')).trim();
    expect(seen).toBe('tighten the loop');

    await workspace.dispose().catch(() => undefined);
    await disposeScratchRepo(repo);
  });

  it('a signal for a session this provider is not running is a safe no-op', async () => {
    const repo = await createScratchRepo();
    const provider = createWorktreeCommandProvider({ repo, command: ['true'] });
    // No resolve for this session.
    expect(
      await provider.deliver({ sessionId: 'ghost', roomId: 'r', kind: 'interrupt', body: null }),
    ).toEqual({ kind: 'ignored', reason: 'not-running' });
    expect(
      await provider.deliver({ sessionId: 'ghost', roomId: 'r', kind: 'steer', body: 'x' }),
    ).toEqual({ kind: 'ignored', reason: 'not-running' });
    // A resume is the daemon's wake even for a session it IS running — always noop.
    expect(
      await provider.deliver({ sessionId: 'ghost', roomId: 'r', kind: 'resume', body: null }),
    ).toEqual({ kind: 'ignored', reason: 'resume-noop' });
    await disposeScratchRepo(repo);
  });

  // ── FIX 2 (#147): an interrupt acked BEFORE the harness spawns must LATCH, and
  // `run` must refuse to spawn — an acked interrupt can never be followed by a clean
  // settle. RED-ON-REVERT: drop the `if (record?.interrupted)` pre-spawn check in
  // `run` and the harness (`true`) spawns and settles clean (terminal.ok === true).
  it('an interrupt after resolve but before spawn latches — run does not settle clean', async () => {
    const repo = await createScratchRepo();
    // `true` WOULD settle a clean terminal if it were allowed to spawn.
    const provider = createWorktreeCommandProvider({ repo, command: ['true'] });
    const c = ctx('interrupt-pre-spawn');
    const workspace = await provider.resolve(c);

    // Deliver the interrupt AFTER resolve fully completed but BEFORE `run` — the
    // pre-spawn window. There is no live child yet, so it only latches.
    const outcome = await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'interrupt',
      body: 'stop',
      signalId: 'i1',
    });
    expect(outcome).toEqual({ kind: 'interrupted' });

    // The run refuses to spawn the already-interrupted session: a FAILED terminal
    // with no artifact, not a clean settle.
    const report = await provider.run(workspace, c);
    expect(report.terminal.ok).toBe(false);
    expect(report.receipt.artifact).toBeNull();
    expect(report.terminal.detail).toContain('interrupted');

    await workspace.dispose().catch(() => undefined);
    await disposeScratchRepo(repo);
  });

  // ── FIX 3 (#147): a signal delivered DURING the resolve window (before resolve's
  // awaited work finishes) is applied, not dropped. The record is registered in
  // resolve's synchronous prefix, so a steer delivered before `resolve` resolves is
  // buffered and flushed to the inbox. RED-ON-REVERT: move the `inflight.set(...)`
  // back below `addWorktree`/`mkdtemp` in `resolve` and this steer returns
  // `not-running` (dropped) — the harness never sees it and times out (exit 3).
  it('a steer delivered in the resolve window is applied, not dropped', async () => {
    const repo = await createScratchRepo();
    const provider = createWorktreeCommandProvider({
      repo,
      command: [
        'bash',
        '-lc',
        'for i in $(seq 1 200); do if [ -s "$ATRIUM_STEER_INBOX" ]; then cat "$ATRIUM_STEER_INBOX" > steer-seen.txt; exit 0; fi; sleep 0.05; done; exit 3',
      ],
    });
    const c = ctx('resolve-window');

    // Start resolve but DO NOT await it — deliver synchronously, inside the window
    // while `addWorktree`/`mkdtemp` are still pending. The record exists (synchronous
    // prefix), the inbox file does not yet, so the steer is buffered.
    const resolveP = provider.resolve(c);
    const outcome = await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'steer',
      body: 'window-steer',
      signalId: 'w1',
    });
    expect(outcome).toEqual({ kind: 'delivered' });

    const workspace = await resolveP;
    const report = await provider.run(workspace, c);
    // The buffered steer was flushed to the inbox and the harness read it.
    expect(report.terminal.ok).toBe(true);
    const seen = (await readFile(join(workspace.dir, 'steer-seen.txt'), 'utf8')).trim();
    expect(seen).toBe('window-steer');

    await workspace.dispose().catch(() => undefined);
    await disposeScratchRepo(repo);
  });

  // ── FIX 5 (#147): a redelivered signal id is deduped — the steer queues ONCE.
  // RED-ON-REVERT: drop the `record.seen` guard in `deliver` and the second
  // delivery appends a second line (count === 2).
  it('dedups a redelivered signal id — the steer is queued exactly once', async () => {
    const repo = await createScratchRepo();
    const provider = createWorktreeCommandProvider({
      repo,
      // Copy the inbox out and count its lines, so the queued count is observable.
      command: ['bash', '-lc', 'cp "$ATRIUM_STEER_INBOX" seen.txt; wc -l < seen.txt > count.txt'],
    });
    const c = ctx('dedup-me');
    const workspace = await provider.resolve(c);

    const first = await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'steer',
      body: 'only-once',
      signalId: 'dup-1',
    });
    const second = await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'steer',
      body: 'the-retry',
      signalId: 'dup-1',
    });
    expect(first).toEqual({ kind: 'delivered' });
    expect(second).toEqual({ kind: 'ignored', reason: 'duplicate' });

    await provider.run(workspace, c);
    const count = Number((await readFile(join(workspace.dir, 'count.txt'), 'utf8')).trim());
    expect(count).toBe(1);
    const seen = (await readFile(join(workspace.dir, 'seen.txt'), 'utf8')).trim();
    expect(seen).toBe('only-once');

    await workspace.dispose().catch(() => undefined);
    await disposeScratchRepo(repo);
  });

  // ── FIX 5 (#147): the steer queue is BOUNDED. Beyond the cap a steer is dropped
  // with `queue-full`, never an unbounded inbox append.
  it('bounds the steer queue at the cap and drops the overflow honestly', async () => {
    const repo = await createScratchRepo();
    const provider = createWorktreeCommandProvider({ repo, command: ['true'] });
    const c = ctx('flood-me');
    await provider.resolve(c);

    for (let i = 0; i < MAX_QUEUED_STEERS; i += 1) {
      const outcome = await provider.deliver({
        sessionId: c.sessionId,
        roomId: c.roomId,
        kind: 'steer',
        body: `steer-${i}`,
        signalId: `flood-${i}`,
      });
      expect(outcome).toEqual({ kind: 'delivered' });
    }
    // The (cap + 1)th is refused — dropped, not appended.
    const overflow = await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'steer',
      body: 'one-too-many',
      signalId: 'flood-overflow',
    });
    expect(overflow).toEqual({ kind: 'ignored', reason: 'queue-full' });

    await disposeScratchRepo(repo);
  });

  // ── FIX 1 (#147, the #141 lesson): the process-group interrupt is BEST-EFFORT.
  // A harness that `setsid()`s a grandchild into a NEW session ESCAPES the `-pid`
  // group signal and SURVIVES — a process group cannot contain it. This is not a
  // bug to patch in the provider: escape-proof termination is cgroup/container
  // containment, which is the #138 sandbox. This test DOCUMENTS the limit (the
  // escapee is still alive after the interrupt) so the claim stays honest and the
  // guarantee is routed to #138, not overstated here.
  it('a setsid escape survives the interrupt — best-effort, routed to #138', async () => {
    const repo = await createScratchRepo();
    const provider = createWorktreeCommandProvider({
      repo,
      // The harness runs a grandchild in a NEW session via `setsid`; that grandchild
      // records its own pid (the escaped session leader) and sleeps. The harness
      // records its own pid and waits. `-pid` on the harness group cannot reach the
      // escaped session.
      command: [
        'bash',
        '-lc',
        'setsid bash -c \'echo $$ > escaped.txt; sleep 300\' & echo "$$" > bash.txt; sleep 300 & wait',
      ],
    });
    const c = ctx('setsid-escape');
    const workspace = await provider.resolve(c);
    const runPromise = provider.run(workspace, c);

    // Wait for both pids to be recorded.
    let escapedPid = 0;
    let bashPid = 0;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        escapedPid = Number((await readFile(join(workspace.dir, 'escaped.txt'), 'utf8')).trim());
        bashPid = Number((await readFile(join(workspace.dir, 'bash.txt'), 'utf8')).trim());
        if (escapedPid > 0 && bashPid > 0) break;
      } catch {
        // not written yet
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(escapedPid).toBeGreaterThan(0);
    expect(bashPid).toBeGreaterThan(0);
    expect(alive(escapedPid)).toBe(true);

    // THE INTERRUPT. It group-kills the harness — but the setsid'd grandchild is in
    // its OWN session and escapes. The provider does not, and cannot, claim to kill it.
    const outcome = await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'interrupt',
      body: 'stop',
      signalId: 'escape-int',
    });
    expect(outcome).toEqual({ kind: 'interrupted' });
    await waitUntilDead(bashPid);

    // THE HONEST TRUTH: the escapee is STILL ALIVE. A process group did not contain
    // it; only #138's sandbox would. This is the scoped claim, proven.
    expect(alive(escapedPid)).toBe(true);

    // Clean up the escaped session ourselves (the sandbox's job in the real system).
    try {
      process.kill(-escapedPid, 'SIGKILL');
    } catch {
      try {
        process.kill(escapedPid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    await runPromise.catch(() => undefined);
    await workspace.dispose().catch(() => undefined);
    await disposeScratchRepo(repo);
  });

  // ── FIX A (#147 completing round): the steer-queue cap holds under CONCURRENT
  // delivery. The steer path is check-then-await-then-mutate (read `steerCount`,
  // `await appendFile`, increment); without serialization a concurrent flood all
  // observe `steerCount < cap` before any increment and every one appends, blowing
  // past the cap. Serialized, each delivery's check-and-increment is atomic. Driven
  // with a genuinely concurrent flood; the harness copies the inbox and counts its
  // lines, so an over-cap append is directly observable. RED-ON-REVERT: route
  // `deliver` straight to `applyDelivery` (drop the `serializeDelivery` wrapper) and
  // the inbox carries MORE than the cap and every delivery reads `delivered`.
  it('holds the queue cap under a concurrent delivery flood (no bypass)', async () => {
    const repo = await createScratchRepo();
    const provider = createWorktreeCommandProvider({
      repo,
      command: ['bash', '-lc', 'cp "$ATRIUM_STEER_INBOX" seen.txt; wc -l < seen.txt > count.txt'],
    });
    const c = ctx('concurrent-cap');
    const workspace = await provider.resolve(c);

    const N = MAX_QUEUED_STEERS + 8;
    const flood = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        provider.deliver({
          sessionId: c.sessionId,
          roomId: c.roomId,
          kind: 'steer',
          body: `flood-${i}`,
          signalId: `conc-${i}`,
        }),
      ),
    );
    const delivered = flood.filter((o) => o.kind === 'delivered').length;
    const full = flood.filter((o) => o.kind === 'ignored' && o.reason === 'queue-full').length;
    expect(delivered).toBe(MAX_QUEUED_STEERS);
    expect(full).toBe(N - MAX_QUEUED_STEERS);

    // The inbox itself carries EXACTLY the cap — the ground truth the harness reads.
    await provider.run(workspace, c);
    const count = Number((await readFile(join(workspace.dir, 'count.txt'), 'utf8')).trim());
    expect(count).toBe(MAX_QUEUED_STEERS);

    await workspace.dispose().catch(() => undefined);
    await disposeScratchRepo(repo);
  });

  // ── FIX B (#147 completing round, grok's exact fix): an interrupt acked in the
  // window between the pre-spawn latch check and the spawn (during the `harnessEnv`
  // await) races an instant-exit command — the `onSpawn` group-kill can lose to a
  // `true` that exits 0 first, so the child reports a CLEAN exit despite the acked
  // interrupt. An acked interrupt must ALWAYS settle failed, never clean, on EVERY
  // path. The post-exit latch re-check guarantees it. RED-ON-REVERT: drop the
  // post-exit `if (postExit?.interrupted) return failed` block in `run` and this
  // races to a clean settle (or a `killed by SIGKILL` detail) — never the
  // interrupt-scoped terminal the fix produces.
  it('an interrupt racing the spawn always settles failed, never clean', async () => {
    const repo = await createScratchRepo();
    // `true` WOULD settle clean if allowed; it is the instant-exit that wins the
    // onSpawn kill race, exposing the need for the post-exit re-check.
    const provider = createWorktreeCommandProvider({ repo, command: ['true'] });
    const c = ctx('interrupt-races-spawn');
    const workspace = await provider.resolve(c);

    // Start run() but DO NOT await: it runs synchronously through the pre-spawn check
    // (not interrupted) and suspends at the `await harnessEnv(...)` BEFORE spawning.
    const runPromise = provider.run(workspace, c);
    // Deliver the interrupt now — inside the pre-spawn/harnessEnv window. There is no
    // child yet, so it only latches.
    const outcome = await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'interrupt',
      body: 'stop',
      signalId: 'race-int',
    });
    expect(outcome).toEqual({ kind: 'interrupted' });

    const report = await runPromise;
    // The acked interrupt produced a FAILED terminal with no artifact, and the detail
    // names the interrupt — not a clean settle, not a bare `killed by SIGKILL`.
    expect(report.terminal.ok).toBe(false);
    expect(report.receipt.artifact).toBeNull();
    expect(report.terminal.detail ?? '').toMatch(/interrupt/i);

    await workspace.dispose().catch(() => undefined);
    await disposeScratchRepo(repo);
  });

  // ── FIX C part 1 (#147 completing round): a steer dropped as `queue-full` is NOT
  // recorded as `seen`, so a legitimate retry is a fresh `queue-full`, not a phantom
  // `duplicate` (which would silently lose the retry). RED-ON-REVERT: move
  // `seen.add(signalId)` back ABOVE the queue-cap check in `applyDelivery` and the
  // retry returns `duplicate`.
  it('does not remember a queue-full steer as seen — retry is queue-full, not duplicate', async () => {
    const repo = await createScratchRepo();
    const provider = createWorktreeCommandProvider({ repo, command: ['true'] });
    const c = ctx('worktree-queuefull-seen');
    await provider.resolve(c);
    for (let i = 0; i < MAX_QUEUED_STEERS; i += 1) {
      await provider.deliver({
        sessionId: c.sessionId,
        roomId: c.roomId,
        kind: 'steer',
        body: `fill-${i}`,
        signalId: `fill-${i}`,
      });
    }
    const dropped = await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'steer',
      body: 'dropped',
      signalId: 'retry-me',
    });
    expect(dropped).toEqual({ kind: 'ignored', reason: 'queue-full' });
    const retry = await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'steer',
      body: 'dropped',
      signalId: 'retry-me',
    });
    expect(retry).toEqual({ kind: 'ignored', reason: 'queue-full' });
    await disposeScratchRepo(repo);
  });

  // ── FIX C part 2 (#147 completing round): the `seen` set is LRU-bounded at
  // `MAX_SEEN_SIGNALS`. Applied signals past the cap evict the oldest; interrupts
  // (not bounded by the steer cap) fill it. RED-ON-REVERT: drop the eviction loop in
  // `rememberAppliedSignal` and the evicted-oldest id reads as `duplicate`.
  it('bounds the seen set — the oldest applied id is evicted and re-applies', async () => {
    const repo = await createScratchRepo();
    const provider = createWorktreeCommandProvider({ repo, command: ['true'] });
    const c = ctx('worktree-seen-bound');
    await provider.resolve(c);
    for (let i = 0; i <= MAX_SEEN_SIGNALS; i += 1) {
      await provider.deliver({
        sessionId: c.sessionId,
        roomId: c.roomId,
        kind: 'interrupt',
        body: null,
        signalId: `evict-${i}`,
      });
    }
    const evicted = await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'interrupt',
      body: null,
      signalId: 'evict-0',
    });
    expect(evicted).toEqual({ kind: 'interrupted' });
    const recent = await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'interrupt',
      body: null,
      signalId: `evict-${MAX_SEEN_SIGNALS}`,
    });
    expect(recent).toEqual({ kind: 'ignored', reason: 'duplicate' });
    await disposeScratchRepo(repo);
  });

  // ── FIX D (#147 completing round): a `resolve` that THROWS after the record is
  // registered in its synchronous prefix (FIX 3) must UNREGISTER it — otherwise a
  // later `deliver` acks into a session that never ran. RED-ON-REVERT: drop the
  // `try/catch` around the awaited work in `resolve` and the steer below returns
  // `delivered` (a false ack, buffered into a dead session's `pendingSteers`).
  it('a resolve that throws unregisters the record — a later signal is not-running', async () => {
    const deadRepo = await createScratchRepo();
    const provider = createWorktreeCommandProvider({ repo: deadRepo, command: ['true'] });
    const c = ctx('worktree-resolve-throw');
    // Dispose the scratch repo so `addWorktree` inside resolve throws.
    await disposeScratchRepo(deadRepo);
    await expect(provider.resolve(c)).rejects.toThrow();
    const outcome = await provider.deliver({
      sessionId: c.sessionId,
      roomId: c.roomId,
      kind: 'steer',
      body: 'into-the-void',
      signalId: 'd1',
    });
    expect(outcome).toEqual({ kind: 'ignored', reason: 'not-running' });
  });
});
